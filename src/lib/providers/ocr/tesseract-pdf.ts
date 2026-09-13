import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { OcrProvider, ParsedDocument, ParsedPage } from './types';

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;

export type TesseractPdfConfig = {
  /**
   * Override command execution in tests or unusual deployments. Production
   * expects `pdftotext` (Poppler) and `ocrmypdf` to be available on PATH.
   */
  runCommand?: CommandRunner;
  /** Overall timeout for each external command. */
  timeoutMs?: number;
  /** OCRmyPDF/Tesseract worker count. Defaults to 1 for predictable local RAM/CPU use. */
  jobs?: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_OCR_JOBS = 1;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || error.message;
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            new Error(
              `${command} failed${code ? ` (${code})` : ''}: ${detail}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Poppler emits a form-feed between PDF pages by default. Keep blank interior
 * pages (they are exactly the pages likely to need OCR) while removing only
 * the final terminator chunk.
 */
export function pagesFromPdftotext(stdout: string): ParsedPage[] {
  const chunks = stdout.replace(/\r\n/g, '\n').split('\f');
  if (chunks.length > 1 && chunks[chunks.length - 1]?.trim() === '') {
    chunks.pop();
  }

  return chunks.map((chunk, index) => ({
    pageNumber: index + 1,
    markdown: chunk.trim(),
    imageRefs: [],
  }));
}

/**
 * A page with only a page number, running header or a handful of glyphs is
 * not a useful text layer. The threshold is intentionally conservative: a
 * normal paragraph easily clears it, while scanned/image pages do not.
 */
export function hasUsableText(page: ParsedPage): boolean {
  const text = page.markdown.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const alphaNumeric = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return alphaNumeric >= 40 && words >= 6;
}

function canonicalMarkdown(pages: ParsedPage[]): string {
  return pages.map((page) => page.markdown).join('\n\n---\n\n');
}

function ocrPageSelection(pageNumbers: number[]): string {
  return pageNumbers.join(',');
}

async function extractPdfText(
  runCommand: CommandRunner,
  pdfPath: string,
  timeoutMs: number,
): Promise<ParsedPage[]> {
  const result = await runCommand(
    'pdftotext',
    ['-layout', '-enc', 'UTF-8', pdfPath, '-'],
    { timeoutMs },
  );
  return pagesFromPdftotext(result.stdout);
}

/**
 * Local PDF parser for ordinary reports and scanned/mixed PDFs.
 *
 * 1. Try the embedded text layer with Poppler (`pdftotext`).
 * 2. If every page has usable text, return immediately — no OCR/model cost.
 * 3. If one or more pages are sparse, run OCRmyPDF only for those page numbers.
 *    We use `--force-ocr` on the selected pages so a stray page number,
 *    watermark or broken partial text layer cannot prevent OCR. Unselected
 *    pages are preserved, and PDF optimisation/PDF-A conversion are disabled.
 * 4. Extract page-aware text from the repaired/OCRed PDF with Poppler.
 *
 * This intentionally favours predictable page provenance and low peak memory
 * over layout-perfect markdown. Docling remains available when rich table or
 * layout reconstruction is worth the additional cost.
 */
export function createTesseractPdfOcr(config: TesseractPdfConfig = {}): OcrProvider {
  const runCommand = config.runCommand ?? defaultRunCommand;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobs = Math.max(1, Math.floor(config.jobs ?? DEFAULT_OCR_JOBS));

  return {
    name: 'tesseract-pdf',
    async parseDocument({ filename, bytes }): Promise<ParsedDocument> {
      if (extname(filename).toLowerCase() !== '.pdf') {
        throw new Error(`tesseract-pdf only supports PDF input: ${filename}`);
      }

      const workDir = await mkdtemp(join(tmpdir(), 'open-recs-tesseract-'));
      const inputPath = join(workDir, 'input.pdf');
      const outputPath = join(workDir, 'ocr.pdf');

      try {
        await writeFile(inputPath, bytes);

        const textLayerPages = await extractPdfText(runCommand, inputPath, timeoutMs);
        const sparsePageNumbers = textLayerPages
          .filter((page) => !hasUsableText(page))
          .map((page) => page.pageNumber);
        const hasAnyUsablePage = textLayerPages.some(hasUsableText);

        if (sparsePageNumbers.length === 0) {
          return {
            markdown: canonicalMarkdown(textLayerPages),
            pages: textLayerPages,
            metadata: {
              filename,
              parser: 'pdftotext',
              ocrFallbackUsed: false,
              pageCount: textLayerPages.length,
              sparsePageNumbers: [],
            },
          };
        }

        await runCommand(
          'ocrmypdf',
          [
            '--pages',
            ocrPageSelection(sparsePageNumbers),
            '--force-ocr',
            '--output-type',
            'pdf',
            '--optimize',
            '0',
            '--jobs',
            String(jobs),
            '--quiet',
            inputPath,
            outputPath,
          ],
          { timeoutMs },
        );

        const ocrPages = await extractPdfText(runCommand, outputPath, timeoutMs);
        const remainingSparsePageNumbers = ocrPages
          .filter((page) => sparsePageNumbers.includes(page.pageNumber) && !hasUsableText(page))
          .map((page) => page.pageNumber);
        const hasTextAfterOcr = ocrPages.some((page) => page.markdown.trim().length > 0);
        if (!hasTextAfterOcr) {
          throw new Error('tesseract-pdf produced no extractable text after OCR');
        }

        return {
          markdown: canonicalMarkdown(ocrPages),
          pages: ocrPages,
          metadata: {
            filename,
            parser: 'pdftotext+ocrmypdf+tesseract',
            ocrFallbackUsed: true,
            pageCount: ocrPages.length,
            sparsePageNumbers,
            remainingSparsePageNumbers,
            textLayerHadUsablePages: hasAnyUsablePage,
            ocrJobs: jobs,
          },
        };
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
