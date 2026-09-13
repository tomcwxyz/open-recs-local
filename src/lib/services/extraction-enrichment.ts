import type {
  RecommendationCandidate,
  RecommendationEnrichment,
  RecommendationInput,
} from './extraction-schema';

const DEFAULT_ENRICHMENT = {
  thematic_area_slugs: [] as string[],
  purpose_slugs: [] as string[],
  target_audience_type_slugs: [] as string[],
  location_scope_slugs: [] as string[],
  priority_timescale_slug: null,
  target_organization: null,
  notes: null,
  confidence: 'low' as const,
};

/**
 * Join classification results back to immutable recommendation candidates.
 *
 * Models occasionally omit an item, duplicate an index, or return an index
 * outside the requested batch. Candidate text must never be dropped or
 * rewritten because enrichment was imperfect: invalid indexes are ignored,
 * the first enrichment for an index wins, and missing enrichment falls back
 * to empty taxonomy + low confidence for later human review.
 */
export function mergeCandidateEnrichments(
  candidates: RecommendationCandidate[],
  enrichments: RecommendationEnrichment[],
): RecommendationInput[] {
  const byIndex = new Map<number, RecommendationEnrichment>();
  for (const enrichment of enrichments) {
    if (enrichment.candidate_index < 0 || enrichment.candidate_index >= candidates.length) {
      continue;
    }
    if (!byIndex.has(enrichment.candidate_index)) {
      byIndex.set(enrichment.candidate_index, enrichment);
    }
  }

  return candidates.map((candidate, index) => {
    const enrichment = byIndex.get(index);
    return {
      ...candidate,
      ...(enrichment
        ? {
            thematic_area_slugs: enrichment.thematic_area_slugs,
            purpose_slugs: enrichment.purpose_slugs,
            target_audience_type_slugs: enrichment.target_audience_type_slugs,
            location_scope_slugs: enrichment.location_scope_slugs,
            priority_timescale_slug: enrichment.priority_timescale_slug ?? null,
            target_organization: enrichment.target_organization ?? null,
            notes: enrichment.notes ?? null,
            confidence: enrichment.confidence,
          }
        : DEFAULT_ENRICHMENT),
    };
  });
}
