import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createTesseractPdfOcr } from '@/lib/providers/ocr/tesseract-pdf';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const pdfPath = path.resolve(
    valueAfter('--pdf') ??
      process.env.REAL_PARSER_PDF ??
      'fixtures/sources/sample-report.pdf',
  );
  const expected =
    valueAfter('--expect') ??
    process.env.REAL_PARSER_EXPECT ??
    (pdfPath.endsWith('sample-report.pdf') ? 'board-level risk committee' : undefined);
  const requireOcr = process.argv.includes('--require-ocr');

  const bytes = await readFile(pdfPath);
  const parser = createTesseractPdfOcr();
  const started = performance.now();
  const parsed = await parser.parseDocument({ filename: path.basename(pdfPath), bytes });
  const elapsedMs = Math.round(performance.now() - started);

  if (parsed.pages.length === 0) throw new Error('real parser smoke: no pages returned');
  if (!parsed.markdown.trim()) throw new Error('real parser smoke: no text returned');
  if (expected && !parsed.markdown.toLocaleLowerCase('en-GB').includes(expected.toLocaleLowerCase('en-GB'))) {
    throw new Error('real parser smoke: expected phrase not found: ' + expected);
  }
  if (requireOcr && parsed.metadata['ocrFallbackUsed'] !== true) {
    throw new Error('real parser smoke: --require-ocr set but OCR fallback was not used');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        pdf: pdfPath,
        parser: parsed.metadata['parser'] ?? parser.name,
        pages: parsed.pages.length,
        elapsed_ms: elapsedMs,
        ocr_fallback_used: parsed.metadata['ocrFallbackUsed'] ?? null,
        sparse_pages: parsed.metadata['sparsePageNumbers'] ?? [],
        remaining_sparse_pages: parsed.metadata['remainingSparsePageNumbers'] ?? [],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[smoke:parser:real] failed:', error);
  process.exit(1);
});
