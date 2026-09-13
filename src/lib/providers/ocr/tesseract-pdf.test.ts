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

  it('runs OCRmyPDF only when one or more pages have a sparse text layer', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let textCall = 0;
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (command === 'ocrmypdf') {
        return { stdout: '', stderr: '' };
      }
      textCall += 1;
      if (textCall === 1) {
        return { stdout: `${rich('Digital page.')}\f\f`, stderr: '' };
      }
      return {
        stdout: `${rich('Digital page.')}\f${rich('Recovered scan.')}\f`,
        stderr: '',
      };
    });
    const provider = createTesseractPdfOcr({ runCommand });

    const result = await provider.parseDocument({ filename: 'mixed.pdf', bytes: FAKE_PDF });

    expect(calls.map((call) => call.command)).toEqual([
      'pdftotext',
      'ocrmypdf',
      'pdftotext',
    ]);
    const ocrCall = calls[1]!;
    expect(ocrCall.args).toContain('--skip-text');
    expect(ocrCall.args).toContain('--optimize');
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]!.markdown).toContain('Recovered scan');
    expect(result.metadata).toMatchObject({
      parser: 'pdftotext+ocrmypdf+tesseract',
      ocrFallbackUsed: true,
      pageCount: 2,
      sparsePageNumbers: [2],
      textLayerHadUsablePages: true,
    });
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
      textLayerHadUsablePages: false,
    });
  });

  it('fails loudly when OCR still produces no text', async () => {
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
