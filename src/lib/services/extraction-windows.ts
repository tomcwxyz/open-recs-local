import type { RecommendationInput } from './extraction-schema';

export type ExtractionPage = {
  pageNumber: number;
  markdown: string;
};

export type ExtractionWindow = {
  index: number;
  startPage: number;
  endPage: number;
  pageNumbers: number[];
  text: string;
};

export type ExtractionWindowOptions = {
  maxPages?: number;
  maxChars?: number;
  overlapPages?: number;
  longPageOverlapChars?: number;
};

const DEFAULT_MAX_PAGES = 6;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_OVERLAP_PAGES = 1;
const DEFAULT_LONG_PAGE_OVERLAP_CHARS = 500;

function pageMarker(pageNumber: number): string {
  return `[PAGE ${pageNumber}]`;
}

function pageBlock(page: ExtractionPage): string {
  return `${pageMarker(page.pageNumber)}\n${page.markdown.trim()}`;
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function makeWindow(index: number, pages: ExtractionPage[]): ExtractionWindow {
  const pageNumbers = uniqueSorted(pages.map((page) => page.pageNumber));
  return {
    index,
    startPage: pageNumbers[0] ?? 1,
    endPage: pageNumbers[pageNumbers.length - 1] ?? 1,
    pageNumbers,
    text: pages.map(pageBlock).join('\n\n'),
  };
}

/**
 * Build bounded, page-aware LLM inputs. Windows overlap by one source page so
 * a recommendation that crosses a page boundary can still be captured in one
 * call. Explicit page markers make provenance observable rather than asking a
 * model to infer page numbers from concatenated markdown.
 *
 * A pathological single page can itself exceed the prompt budget (large table
 * exports are the common case). Such pages are split into overlapping text
 * fragments, each retaining the same source page marker, rather than silently
 * truncating their tail.
 */
export function buildExtractionWindows(
  inputPages: ExtractionPage[],
  options: ExtractionWindowOptions = {},
): ExtractionWindow[] {
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const overlapPages = Math.max(
    0,
    Math.min(maxPages - 1, options.overlapPages ?? DEFAULT_OVERLAP_PAGES),
  );
  const longPageOverlapChars = Math.max(
    0,
    options.longPageOverlapChars ?? DEFAULT_LONG_PAGE_OVERLAP_CHARS,
  );

  const pages = [...inputPages].sort((a, b) => a.pageNumber - b.pageNumber);
  const windows: ExtractionWindow[] = [];
  let cursor = 0;

  while (cursor < pages.length) {
    const first = pages[cursor]!;
    const firstBlock = pageBlock(first);

    if (firstBlock.length > maxChars) {
      const markerLength = pageMarker(first.pageNumber).length + 1;
      const bodyBudget = Math.max(500, maxChars - markerLength);
      const step = Math.max(1, bodyBudget - Math.min(longPageOverlapChars, bodyBudget - 1));
      const body = first.markdown.trim();
      for (let offset = 0; offset < body.length; offset += step) {
        const fragment = body.slice(offset, offset + bodyBudget);
        windows.push(
          makeWindow(windows.length, [
            { pageNumber: first.pageNumber, markdown: fragment },
          ]),
        );
        if (offset + bodyBudget >= body.length) break;
      }
      cursor += 1;
      continue;
    }

    const selected: ExtractionPage[] = [];
    let chars = 0;
    let end = cursor;

    while (end < pages.length && selected.length < maxPages) {
      const candidate = pages[end]!;
      const block = pageBlock(candidate);
      const separator = selected.length === 0 ? 0 : 2;
      if (selected.length > 0 && chars + separator + block.length > maxChars) break;
      selected.push(candidate);
      chars += separator + block.length;
      end += 1;
    }

    windows.push(makeWindow(windows.length, selected));
    if (end >= pages.length) break;

    // Retain overlap when a window contains enough pages, but always advance
    // at least one source page so sparse/large pages cannot create a loop.
    cursor = Math.max(cursor + 1, end - overlapPages);
  }

  return windows;
}

function normaliseRecommendationText(value: string): string {
  return value
    .toLocaleLowerCase('en-GB')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function pageMin(...values: Array<number | null | undefined>): number | null {
  const pages = values.filter((value): value is number => typeof value === 'number');
  return pages.length > 0 ? Math.min(...pages) : null;
}

function pageMax(...values: Array<number | null | undefined>): number | null {
  const pages = values.filter((value): value is number => typeof value === 'number');
  return pages.length > 0 ? Math.max(...pages) : null;
}

/**
 * Validate page anchors against the window that produced a recommendation.
 * For a single-page window we can safely fill a missing anchor. For wider
 * windows an absent anchor stays absent rather than inventing precision.
 */
export function applyWindowProvenance(
  recommendation: RecommendationInput,
  window: ExtractionWindow,
): RecommendationInput {
  let start = recommendation.page_start ?? null;
  let end = recommendation.page_end ?? null;

  const inWindow = (page: number): boolean =>
    page >= window.startPage && page <= window.endPage;

  if (start !== null && !inWindow(start)) start = null;
  if (end !== null && !inWindow(end)) end = null;

  if (window.startPage === window.endPage) {
    start ??= window.startPage;
    end ??= window.endPage;
  } else {
    if (start !== null && end === null) end = start;
    if (end !== null && start === null) start = end;
  }

  if (start !== null && end !== null && start > end) {
    [start, end] = [end, start];
  }

  return {
    ...recommendation,
    page_start: start,
    page_end: end,
  };
}

/**
 * Adjacent extraction windows overlap, so the same recommendation may appear
 * twice. Deduplicate only when both normalised title AND body match; title-only
 * dedupe would incorrectly collapse genuinely distinct recommendations that
 * share a generic heading such as "Increase funding".
 */
export function dedupeRecommendations(
  recommendations: RecommendationInput[],
): RecommendationInput[] {
  const byContent = new Map<string, RecommendationInput>();

  for (const recommendation of recommendations) {
    const key = `${normaliseRecommendationText(recommendation.title)}|${normaliseRecommendationText(
      recommendation.body,
    )}`;
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, recommendation);
      continue;
    }

    byContent.set(key, {
      ...existing,
      page_start: pageMin(existing.page_start, recommendation.page_start),
      page_end: pageMax(existing.page_end, recommendation.page_end),
    });
  }

  return Array.from(byContent.values());
}
