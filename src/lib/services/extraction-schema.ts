import { z } from 'zod';

/**
 * Pass 1 output — source-level metadata extracted from the first ~10k chars
 * of canonical markdown.
 *
 * All multi-select axes are arrays of slug strings; the handler resolves
 * each slug to a taxonomy id via the per-axis `resolveOrCreate*` repo
 * functions, auto-creating unknown slugs with `unverified=true`.
 */
export const SourceMetadataSchema = z.object({
  summary: z.string().nullable(),
  authors: z.array(z.string()).default([]),
  publication_date: z.string().nullable(),
  org_owner: z.string().nullable(),
  thematic_area_slugs: z.array(z.string()).default([]),
  source_type_slugs: z.array(z.string()).default([]),
  purpose_slugs: z.array(z.string()).default([]),
  role_relevance_slugs: z.array(z.string()).default([]),
  target_audience_type_slugs: z.array(z.string()).default([]),
});

export type SourceMetadataOutput = z.infer<typeof SourceMetadataSchema>;

/**
 * Minimal recommendation candidate shape used by the real page-aware path.
 * Keep the first model task deliberately narrow: decide whether an actionable
 * recommendation exists, capture its text, and anchor it to the explicit page
 * markers. Taxonomy/priority/confidence work happens later in a separate pass.
 */
export const RecommendationCandidateSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(20),
  page_start: z.number().int().nullable().optional(),
  page_end: z.number().int().nullable().optional(),
});

export const RecommendationCandidatesSchema = z.object({
  recommendations: z.array(RecommendationCandidateSchema),
});

export type RecommendationCandidate = z.infer<typeof RecommendationCandidateSchema>;
export type RecommendationCandidatesOutput = z.infer<typeof RecommendationCandidatesSchema>;

/**
 * Enrichment is keyed back to a deterministic candidate index. The model is
 * not asked to repeat title/body/page text, so it cannot accidentally rewrite
 * the recommendation while classifying it.
 */
export const RecommendationEnrichmentSchema = z.object({
  candidate_index: z.number().int().nonnegative(),
  thematic_area_slugs: z.array(z.string()).default([]),
  purpose_slugs: z.array(z.string()).default([]),
  target_audience_type_slugs: z.array(z.string()).default([]),
  location_scope_slugs: z.array(z.string()).default([]),
  priority_timescale_slug: z.string().nullable().optional(),
  target_organization: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const RecommendationEnrichmentsSchema = z.object({
  enrichments: z.array(RecommendationEnrichmentSchema),
});

export type RecommendationEnrichment = z.infer<typeof RecommendationEnrichmentSchema>;

/**
 * Legacy combined Pass 2 shape. Fixture-backed tests and older sources without
 * source_pages still use this route so the migration to page-aware extraction
 * does not require a flag-day fixture rewrite.
 */
export const RecommendationsSchema = z.object({
  recommendations: z.array(
    RecommendationCandidateSchema.extend({
      thematic_area_slugs: z.array(z.string()).default([]),
      purpose_slugs: z.array(z.string()).default([]),
      target_audience_type_slugs: z.array(z.string()).default([]),
      location_scope_slugs: z.array(z.string()).default([]),
      priority_timescale_slug: z.string().nullable().optional(),
      target_organization: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export type RecommendationsOutput = z.infer<typeof RecommendationsSchema>;
export type RecommendationInput = RecommendationsOutput['recommendations'][number];
