import type { OcrProvider, ParsedDocument, ParsedPage } from './types';

/**
 * Real OCR adapter backed by a self-hosted Docling-serve container.
 *
 * Endpoint: `POST {baseUrl}/v1/convert/file` — multipart form upload with
 * the PDF bytes in the `files` field. The response shape varies slightly
 * between Docling-serve versions; see
 * https://github.com/docling-project/docling-serve for the authoritative
 * schema. This adapter handles the two shapes we've observed:
 *
 *   1. `{ status: 'success', document: { md_content, pages: [...] } }` — the
 *      preferred shape; per-page markdown is taken directly from `pages`.
 *   2. `{ status: 'success', document: { md_content } }` — older/minimal
 *      responses with no per-page segmentation. We fall back to splitting
 *      the concatenated markdown on `\n---\n`, matching the fake adapter's
 *      convention so downstream chunking stays identical.
 *
 * Image references are kept as markdown `![alt](path)` links; the adapter
 * only extracts the paths into `imageRefs` for each page. Actual image
 * resolution is a later concern (Phase 5 source viewer).
 */
export type DoclingOcrConfig = {
  /** Base URL of the Docling-serve instance, e.g. `http://docling:5001`. */
  baseUrl: string;
  /** Per-chunk HTTP deadline. Defaults to five minutes. */
  timeoutMs?: number;
};

type DoclingPage = {
  page_no?: number;
  page_number?: number;
  markdown?: string;
  md_content?: string;
};

type DoclingDocument = {
  md_content?: string;
  markdown?: string;
  pages?: DoclingPage[];
  metadata?: Record<string, unknown>;
};

type DoclingResponse = {
  status?: string;
  message?: string;
  document?: DoclingDocument;
};

const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Unique marker we ask Docling to inject between pages. Picked to be
// unambiguous in markdown — an HTML comment doesn't render and won't collide
// with a thematic-break `---` line that legitimately appears in body text.
const DOCLING_PAGE_BREAK = '<!-- docling-page-break -->';

function extractImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  // Use a fresh regex each call — sharing state across calls via the /g
  // flag is a classic footgun when reusing a module-level regex.
  const re = new RegExp(IMAGE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const ref = match[1];
    if (ref) refs.push(ref);
  }
  return refs;
}

function splitMarkdownIntoPages(markdown: string): ParsedPage[] {
  // Prefer the docling-injected marker (set via md_page_break_placeholder
  // when we call /v1/convert/file). If it's absent (older docling, or a
  // future shape change), fall back to splitting on `\n---\n` so we keep
  // some segmentation rather than emitting one huge page.
  const re = markdown.includes(DOCLING_PAGE_BREAK)
    ? new RegExp(`\\r?\\n${DOCLING_PAGE_BREAK}\\r?\\n`)
    : /\r?\n---\r?\n/;
  const chunks = markdown.split(re);
  return chunks.map((chunk, index) => {
    const trimmed = chunk.trim();
    return {
      pageNumber: index + 1,
      markdown: trimmed,
      imageRefs: extractImageRefs(trimmed),
    };
  });
}

/**
 * How many pages to request from docling-serve in a single call. Docling's
 * Python worker pool crashes (clean exit code 0, body stream truncated, client
 * sees `fetch failed`) when asked to convert long PDFs in one go — observed
 * on a 177-page / 16 MB report. Chunked calls of this size complete reliably
 * and the markdown can be concatenated transparently because every page
 * boundary is already marked with {@link DOCLING_PAGE_BREAK}.
 */
const PAGE_CHUNK_SIZE = 50;

function buildConvertForm(filename: string, bytes: Uint8Array, pageRange: [number, number]): FormData {
  const form = new FormData();
  // Copy into a fresh Uint8Array so the Blob constructor sees an
  // ArrayBuffer-backed view (Node's Buffer may sit on a SharedArrayBuffer,
  // which the DOM BlobPart type rejects under strict TS lib typings).
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  form.append('files', new Blob([view], { type: 'application/pdf' }), filename);
  // Disable image-OCR + table-structure extraction by default. Both trigger
  // crashes in docling-serve's worker pool on real-world PDFs with mixed
  // image + text layouts. For PDFs with a selectable text layer (most modern
  // policy / report exports) Docling falls back to text extraction which is
  // fast, reliable, and produces useful markdown.
  form.append('do_ocr', 'false');
  form.append('do_table_structure', 'false');
  // Drop embedded base64 images — `embedded` (the default) produces 5MB+
  // payloads that overflow Postgres's tsvector limit (1MB) when stored in
  // `sources.canonical_markdown`.
  form.append('image_export_mode', 'placeholder');
  // Page-break marker we split on downstream (see splitMarkdownIntoPages).
  form.append('md_page_break_placeholder', `\n${DOCLING_PAGE_BREAK}\n`);
  // Page range is required for chunking. `page_range` is sent as two repeated
  // form fields ("start" then "end") rather than a single JSON array because
  // docling-serve's FastAPI binding rejects the bracket form with HTTP 422.
  form.append('page_range', String(pageRange[0]));
  form.append('page_range', String(pageRange[1]));
  return form;
}

async function convertChunk(
  baseUrl: string,
  filename: string,
  bytes: Uint8Array,
  pageRange: [number, number],
  timeoutMs: number,
): Promise<DoclingResponse> {
  const res = await fetch(`${baseUrl}/v1/convert/file`, {
    method: 'POST',
    body: buildConvertForm(filename, bytes, pageRange),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Docling OCR failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
    );
  }
  return (await res.json()) as DoclingResponse;
}

export function createDoclingOcr(config: DoclingOcrConfig): OcrProvider {
  // Trim trailing slash so `${baseUrl}/v1/...` always yields a single slash.
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'docling',
    async parseDocument({ filename, bytes }): Promise<ParsedDocument> {
      // Always chunk by page range. Docling-serve returns
      // `status: 'failure'` with null content when asked for a range past
      // the end of the document — we use that as the loop terminator.
      // We also stop early when a chunk returns fewer pages than requested
      // (saves one wasted call on PDFs whose page count is not a multiple of
      // PAGE_CHUNK_SIZE).
      const chunks: string[] = [];
      let metadata: Record<string, unknown> = {};
      let start = 1;
      while (true) {
        const end = start + PAGE_CHUNK_SIZE - 1;
        const payload = await convertChunk(baseUrl, filename, bytes, [start, end], timeoutMs);
        if (payload.status === 'failure') {
          if (start === 1) {
            throw new Error(
              `Docling OCR returned status=failure on the first chunk (pages ${start}..${end})${payload.message ? `: ${payload.message}` : ''}`,
            );
          }
          break;
        }
        if (payload.status && payload.status !== 'success') {
          throw new Error(
            `Docling OCR returned status=${payload.status}${payload.message ? `: ${payload.message}` : ''}`,
          );
        }
        const document = payload.document;
        if (!document) {
          throw new Error('Docling OCR response missing `document` field');
        }
        const md = (document.md_content ?? document.markdown ?? '').trim();
        if (!md) break;
        chunks.push(md);
        if (start === 1) metadata = document.metadata ?? {};
        // Marker count tells us how many pages came back (== breaks + 1).
        // Re-create the regex each call since the /g flag carries state.
        const markerRe = new RegExp(DOCLING_PAGE_BREAK, 'g');
        const pagesInChunk = (md.match(markerRe) ?? []).length + 1;
        if (pagesInChunk < PAGE_CHUNK_SIZE) break;
        start += PAGE_CHUNK_SIZE;
      }

      // Glue chunks together with the same marker so splitMarkdownIntoPages
      // sees the full sequence of page boundaries — within and across chunks.
      const markdown = chunks.join(`\n${DOCLING_PAGE_BREAK}\n`);
      const pages = splitMarkdownIntoPages(markdown);

      return {
        markdown: pages.map((page) => page.markdown).join('\n\n---\n\n'),
        pages,
        metadata: { filename, ...metadata },
      };
    },
  };
}
