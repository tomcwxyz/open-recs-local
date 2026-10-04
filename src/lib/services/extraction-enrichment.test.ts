import { describe, expect, it } from 'vitest';
import type { RecommendationCandidate, RecommendationEnrichment } from './extraction-schema';
import { mergeCandidateEnrichments } from './extraction-enrichment';

const candidates: RecommendationCandidate[] = [
  {
    title: 'Create a shared standard',
    body: 'Government and sector partners should create a shared standard for reporting outcomes.',
    page_start: 12,
    page_end: 13,
  },
  {
    title: 'Fund local delivery',
    body: 'Funders should provide sustained multi-year support for local delivery organisations.',
    page_start: 18,
    page_end: 18,
  },
];

function enrichment(
  candidateIndex: number,
  overrides: Partial<RecommendationEnrichment> = {},
): RecommendationEnrichment {
  return {
    candidate_index: candidateIndex,
    thematic_area_slugs: ['data'],
    purpose_slugs: ['strategy'],
    target_audience_type_slugs: ['funders'],
    location_scope_slugs: ['national'],
    priority_timescale_slug: 'urgent',
    target_organization: null,
    notes: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('mergeCandidateEnrichments', () => {
  it('joins classification by candidate index without allowing candidate text to change', () => {
    const result = mergeCandidateEnrichments(candidates, [enrichment(0), enrichment(1)]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      title: candidates[0]!.title,
      body: candidates[0]!.body,
      page_start: 12,
      page_end: 13,
      thematic_area_slugs: ['data'],
      confidence: 'high',
    });
  });

  it('keeps a candidate with low-confidence empty taxonomy if enrichment is missing', () => {
    const result = mergeCandidateEnrichments(candidates, [enrichment(0)]);

    expect(result[1]).toMatchObject({
      title: candidates[1]!.title,
      thematic_area_slugs: [],
      purpose_slugs: [],
      target_audience_type_slugs: [],
      location_scope_slugs: [],
      priority_timescale_slug: null,
      confidence: 'low',
    });
  });

  it('ignores out-of-range enrichments and uses the first duplicate index', () => {
    const result = mergeCandidateEnrichments(candidates, [
      enrichment(99, { confidence: 'medium' }),
      enrichment(0, { confidence: 'high' }),
      enrichment(0, { confidence: 'low' }),
    ]);

    expect(result[0]!.confidence).toBe('high');
    expect(result[1]!.confidence).toBe('low');
  });
});
