import { describe, expect, it, vi } from 'vitest';
import {
  createTesseractPdfOcr,
  hasUsableText,
  pagesFromPdftotext,
  type CommandRunner,
} from './tesseract-pdf';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake');

function rich(text: string): string {
  return `${text} This page contains enough ordinary report text to be treated as a useful embedded text layer.`;
}

describe('tesseract-pdf provider', () => {
  it('uses the PDF text layer directly when every page has useful text', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      expect(command).toBe('pdftotext');
      return {
        stdout: `${rich('Page one.')}\f${rich('Page two.')}\f`,
        stderr: '',
      };
    });
    const provider = createTesseractPdfOcr({ runCommand });

    const result = await provider.parseDocument({ filename: 'report.pdf', bytes: FAKE_PDF });

    expect(provider.name).toBe('tesseract-pdf');
    expect(calls.map((call) => call.command)).toEqual(['pdftotext']);
    expect(result.pages).toHaveLength(2);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.metadata).toMatchObject({
      parser: 'pdftotext',
      ocrFallbackUsed: false,
      pageCount: 2,
      sparsePageNumbers: [],
    });
  });

  it('force-OCRs only pages whose text layer is sparse', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let textCall = 0;
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (command === 'ocrmypdf') {
        return { stdout: '', stderr: '' };
      }
      textCall += 1;
      if (textCall === 1) {
        return {
          stdout: `${rich('Digital page.')}\f17 Annual Report\f${rich('Another digital page.')}\f`,
          stderr: '',
        };
      }
      return {
        stdout: `${rich('Digital page.')}\f${rich('Recovered sparse scan.')}\f${rich('Another digital page.')}\f`,
        stderr: '',
      };
    });
    const provider = createTesseractPdfOcr({ runCommand, jobs: 1 });

    const result = await provider.parseDocument({ filename: 'mixed.pdf', bytes: FAKE_PDF });

    expect(calls.map((call) => call.command)).toEqual([
      'pdftotext',
      'ocrmypdf',
      'pdftotext',
    ]);
    const ocrCall = calls[1]!;
    const pagesFlag = ocrCall.args.indexOf('--pages');
    expect(pagesFlag).toBeGreaterThanOrEqual(0);
    expect(ocrCall.args[pagesFlag + 1]).toBe('2');
    expect(ocrCall.args).toContain('--force-ocr');
    expect(ocrCall.args).not.toContain('--skip-text');
    expect(ocrCall.args).toContain('--optimize');
    expect(ocrCall.args).toContain('--jobs');
    expect(result.pages).toHaveLength(3);
    expect(result.pages[1]!.markdown).toContain('Recovered sparse scan');
    expect(result.metadata).toMatchObject({
      parser: 'pdftotext+ocrmypdf+tesseract',
      ocrFallbackUsed: true,
      pageCount: 3,
      sparsePageNumbers: [2],
      remainingSparsePageNumbers: [],
      textLayerHadUsablePages: true,
      ocrJobs: 1,
    });
  });

  it('passes every sparse page to OCRmyPDF as a page selection', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let textCall = 0;
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (command === 'ocrmypdf') return { stdout: '', stderr: '' };
      textCall += 1;
      return textCall === 1
        ? { stdout: `\f${rich('Digital middle page.')}\f3\f`, stderr: '' }
        : {
            stdout: `${rich('Recovered page one.')}\f${rich('Digital middle page.')}\f${rich('Recovered page three.')}\f`,
            stderr: '',
          };
    });
    const provider = createTesseractPdfOcr({ runCommand, jobs: 2 });

    const result = await provider.parseDocument({ filename: 'mixed.pdf', bytes: FAKE_PDF });

    const ocrCall = calls.find((call) => call.command === 'ocrmypdf')!;
    expect(ocrCall.args[ocrCall.args.indexOf('--pages') + 1]).toBe('1,3');
    expect(ocrCall.args[ocrCall.args.indexOf('--jobs') + 1]).toBe('2');
    expect(result.metadata).toMatchObject({ sparsePageNumbers: [1, 3], ocrJobs: 2 });
  });

  it('OCRs an effectively textless PDF', async () => {
    let textCall = 0;
    const runCommand: CommandRunner = vi.fn(async (command) => {
      if (command === 'ocrmypdf') return { stdout: '', stderr: '' };
      textCall += 1;
      return textCall === 1
        ? { stdout: '\f', stderr: '' }
        : { stdout: `${rich('Scanned report recovered.')}\f`, stderr: '' };
    });
    const provider = createTesseractPdfOcr({ runCommand });

    const result = await provider.parseDocument({ filename: 'scan.pdf', bytes: FAKE_PDF });

    expect(result.pages).toHaveLength(1);
    expect(result.metadata).toMatchObject({
      ocrFallbackUsed: true,
      sparsePageNumbers: [1],
      remainingSparsePageNumbers: [],
      textLayerHadUsablePages: false,
    });
  });

  it('records targeted pages that remain sparse after OCR', async () => {
    let textCall = 0;
    const runCommand: CommandRunner = vi.fn(async (command) => {
      if (command === 'ocrmypdf') return { stdout: '', stderr: '' };
      textCall += 1;
      return textCall === 1
        ? { stdout: `${rich('Good page.')}\f17 Annual Report\f`, stderr: '' }
        : { stdout: `${rich('Good page.')}\fstill tiny\f`, stderr: '' };
    });
    const provider = createTesseractPdfOcr({ runCommand });

    const result = await provider.parseDocument({ filename: 'poor-scan.pdf', bytes: FAKE_PDF });

    expect(result.metadata).toMatchObject({
      sparsePageNumbers: [2],
      remainingSparsePageNumbers: [2],
    });
  });

  it('fails loudly when OCR still produces no text at all', async () => {
    const runCommand: CommandRunner = vi.fn(async (command) =>
      command === 'ocrmypdf'
        ? { stdout: '', stderr: '' }
        : { stdout: '\f', stderr: '' },
    );
    const provider = createTesseractPdfOcr({ runCommand });

    await expect(
      provider.parseDocument({ filename: 'blank.pdf', bytes: FAKE_PDF }),
    ).rejects.toThrow(/no extractable text/i);
  });

  it('rejects non-PDF inputs before launching external tools', async () => {
    const runCommand: CommandRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const provider = createTesseractPdfOcr({ runCommand });

    await expect(
      provider.parseDocument({ filename: 'notes.txt', bytes: Buffer.from('hello') }),
    ).rejects.toThrow(/only supports PDF/i);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('pdftotext page handling', () => {
  it('preserves blank interior pages while dropping the trailing page terminator', () => {
    const pages = pagesFromPdftotext('one\f\fthree\f');
    expect(pages).toEqual([
      { pageNumber: 1, markdown: 'one', imageRefs: [] },
      { pageNumber: 2, markdown: '', imageRefs: [] },
      { pageNumber: 3, markdown: 'three', imageRefs: [] },
    ]);
  });

  it('treats running headers and tiny fragments as sparse', () => {
    expect(
      hasUsableText({ pageNumber: 1, markdown: '17 Annual Report', imageRefs: [] }),
    ).toBe(false);
    expect(
      hasUsableText({ pageNumber: 2, markdown: rich('Recommendation evidence.'), imageRefs: [] }),
    ).toBe(true);
  });
});
