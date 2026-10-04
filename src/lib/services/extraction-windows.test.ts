import { describe, expect, it } from 'vitest';
import type { RecommendationInput } from './extraction-schema';
import {
  applyWindowProvenance,
  buildExtractionWindows,
  dedupeRecommendations,
} from './extraction-windows';

function page(pageNumber: number, text = `content for page ${pageNumber}`) {
  return { pageNumber, markdown: text };
}

function recommendation(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    title: 'Improve local support',
    body: 'Local partners should improve support through a coordinated programme of action.',
    thematic_area_slugs: [],
    purpose_slugs: [],
    target_audience_type_slugs: [],
    location_scope_slugs: [],
    priority_timescale_slug: null,
    target_organization: null,
    notes: null,
    confidence: 'high',
    page_start: null,
    page_end: null,
    ...overrides,
  };
}

describe('buildExtractionWindows', () => {
  it('adds explicit page markers and overlaps adjacent windows', () => {
    const windows = buildExtractionWindows(
      Array.from({ length: 7 }, (_, index) => page(index + 1)),
      { maxPages: 3, maxChars: 10_000, overlapPages: 1 },
    );

    expect(windows.map((window) => window.pageNumbers)).toEqual([
      [1, 2, 3],
      [3, 4, 5],
      [5, 6, 7],
    ]);
    expect(windows[0]!.text).toContain('[PAGE 1]');
    expect(windows[0]!.text).toContain('[PAGE 3]');
    expect(windows[1]!.startPage).toBe(3);
    expect(windows[1]!.endPage).toBe(5);
  });

  it('uses the character budget even when the page-count budget is not reached', () => {
    const windows = buildExtractionWindows(
      [page(1, 'a'.repeat(700)), page(2, 'b'.repeat(700)), page(3, 'c'.repeat(700))],
      { maxPages: 6, maxChars: 1_000, overlapPages: 0 },
    );

    expect(windows.map((window) => window.pageNumbers)).toEqual([[1], [2], [3]]);
  });

  it('splits a single pathological page without dropping its tail', () => {
    const source = '0123456789'.repeat(500);
    const windows = buildExtractionWindows([page(17, source)], {
      maxPages: 4,
      maxChars: 1_200,
      longPageOverlapChars: 100,
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.pageNumbers.length === 1)).toBe(true);
    expect(windows.every((window) => window.pageNumbers[0] === 17)).toBe(true);
    expect(windows.every((window) => window.text.startsWith('[PAGE 17]'))).toBe(true);
    expect(windows[windows.length - 1]!.text).toContain(source.slice(-200));
  });

  it('sorts source pages before building windows', () => {
    const windows = buildExtractionWindows([page(3), page(1), page(2)], {
      maxPages: 3,
      maxChars: 10_000,
    });
    expect(windows[0]!.pageNumbers).toEqual([1, 2, 3]);
  });
});

describe('applyWindowProvenance', () => {
  it('fills missing provenance for a single-page window', () => {
    const window = buildExtractionWindows([page(8)], { maxChars: 10_000 })[0]!;
    const result = applyWindowProvenance(recommendation(), window);
    expect(result.page_start).toBe(8);
    expect(result.page_end).toBe(8);
  });

  it('keeps valid model anchors and rejects hallucinated pages outside the window', () => {
    const window = buildExtractionWindows([page(10), page(11), page(12)], {
      maxPages: 3,
      maxChars: 10_000,
    })[0]!;

    expect(
      applyWindowProvenance(recommendation({ page_start: 11, page_end: 12 }), window),
    ).toMatchObject({ page_start: 11, page_end: 12 });
    expect(
      applyWindowProvenance(recommendation({ page_start: 99, page_end: 99 }), window),
    ).toMatchObject({ page_start: null, page_end: null });
  });

  it('normalises reversed page spans', () => {
    const window = buildExtractionWindows([page(4), page(5)], {
      maxPages: 2,
      maxChars: 10_000,
    })[0]!;
    const result = applyWindowProvenance(
      recommendation({ page_start: 5, page_end: 4 }),
      window,
    );
    expect(result.page_start).toBe(4);
    expect(result.page_end).toBe(5);
  });
});

describe('dedupeRecommendations', () => {
  it('deduplicates overlap copies by normalised title and body and merges page spans', () => {
    const first = recommendation({ page_start: 4, page_end: 4 });
    const duplicate = recommendation({
      title: 'Improve local support!',
      body: 'Local partners should improve support through a coordinated programme of action. ',
      page_start: 4,
      page_end: 5,
    });

    const result = dedupeRecommendations([first, duplicate]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ page_start: 4, page_end: 5 });
  });

  it('does not collapse distinct recommendations merely because titles match', () => {
    const result = dedupeRecommendations([
      recommendation({ body: 'First actionable recommendation body with enough detail for extraction.' }),
      recommendation({ body: 'Second actionable recommendation body with a different required action.' }),
    ]);
    expect(result).toHaveLength(2);
  });
});
