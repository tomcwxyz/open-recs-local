import { and, asc, eq } from 'drizzle-orm';
import type { JobContext } from '../context';
import type { QueuePayloads } from '../types';
import {
  recommendations,
  recommendationStatuses,
  sourceFiles,
  sourcePages,
  sources,
} from '@/lib/db/schema';
import {
  RecommendationCandidatesSchema,
  RecommendationEnrichmentsSchema,
  RecommendationsSchema,
  SourceMetadataSchema,
  type RecommendationCandidate,
  type RecommendationEnrichment,
  type RecommendationInput,
  type SourceMetadataOutput,
} from '@/lib/services/extraction-schema';
import { mergeCandidateEnrichments } from '@/lib/services/extraction-enrichment';
import { detectRecommendationSections } from '@/lib/services/extraction-sections';
import {
  applyWindowProvenance,
  buildExtractionWindows,
  dedupeRecommendations,
  type ExtractionWindow,
} from '@/lib/services/extraction-windows';
import {
  buildPass1Prompt,
  buildPass2LooserPrompt,
  buildPass2StrictPrompt,
  buildRecommendationCandidatePrompt,
  buildRecommendationEnrichmentPrompt,
  type TaxonomySlugLists,
} from '@/lib/services/extraction-prompts';
import {
  batchResolveTaxonomy,
  listLocationScopes,
  listPriorityTimescales,
  listPurposes,
  listRoleRelevances,
  listSourceTypes,
  listTargetAudienceTypes,
  listThematicAreas,
  resolveOrCreateLocationScopes,
  resolveOrCreatePurposes,
  resolveOrCreateSourceTypes,
  resolveOrCreateRoleRelevances,
  resolveOrCreateTargetAudienceTypes,
  resolveOrCreateThematicAreas,
  resolveOrCreatePriorityTimescales,
} from '@/lib/repositories/taxonomy';
import {
  replaceSourcePurposes,
  replaceSourceRoleRelevances,
  replaceSourceSourceTypes,
  replaceSourceTargetAudienceTypes,
  replaceSourceThematicAreas,
} from '@/lib/repositories/source-tags';
import {
  recommendationsLocationScopes,
  recommendationsPurposes,
  recommendationsTargetAudienceTypes,
  recommendationsThematicAreas,
} from '@/lib/db/schema';
import type { RepoContext } from '@/lib/repositories/types';

const MAX_PASS1_MARKDOWN = 10_000;
// Retained only for legacy/fake sources that do not have real source_pages.
// Real parsed sources now use bounded page-aware windows below, so their tail
// is never dropped just because the document is longer than one prompt.
const MAX_PASS2_MARKDOWN = 30_000;
const ENRICHMENT_BATCH_SIZE = 8;

function fixtureKeyFromStorageKey(storageKey: string): string {
  const filename = storageKey.split('/').pop() ?? storageKey;
  return filename.replace(/\.[^.]+$/, '');
}

function truncate(markdown: string, max: number): string {
  if (markdown.length <= max) return markdown;
  const cut = markdown.slice(0, max);
  return `${cut}\n\n<!-- truncated: ${markdown.length - max} chars omitted -->`;
}

function parsePublicationDate(input: string | null): Date | null {
  if (!input) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function windowLabel(window: ExtractionWindow): string {
  if (window.startPage === window.endPage) return `page ${window.startPage}`;
  return `pages ${window.startPage}-${window.endPage}`;
}

/**
 * `source.extract` handler — metadata + page-aware recommendation extraction.
 *
 * Pass 1: source metadata (summary, authors, dates, source-level taxonomies).
 * Reads the first ~10k chars of canonical markdown so the model sees front
 * matter + executive summary without receiving the whole document.
 *
 * Pass 2A (real parsed sources): identify recommendation candidates in small,
 * overlapping page windows. This task intentionally has no taxonomy lists or
 * classification fields: the local model only decides what is actionable,
 * preserves the recommendation text, and anchors it to explicit `[PAGE N]`
 * markers. Candidates are deduplicated across overlapping windows.
 *
 * Pass 2B: enrich the deduplicated candidates in batches with taxonomy,
 * target organisation, priority and confidence. Enrichment is joined back by
 * deterministic candidate index and cannot rewrite title/body/page text.
 *
 * Fake/legacy compatibility: fixture-backed fake LLMs and old sources with no
 * `source_pages` keep the historical combined section-aware Pass 2 route.
 *
 * Local concurrency: a 16 GB local inference host runs metadata, page windows
 * and enrichment sequentially. Hosted mode may run Pass 1 alongside the
 * recommendation sequence, but page/enrichment batches themselves stay
 * bounded instead of launching an unbounded fan-out of model calls.
 */
export async function extractHandler(
  ctx: JobContext,
  payload: QueuePayloads['source.extract'],
): Promise<void> {
  const { sourceId } = payload;
  try {
    await ctx.emit(sourceId, { type: 'phase', phase: 'extracting' });

    const [sourceRow] = await ctx.db
      .select({ slug: sources.slug, canonical: sources.canonicalMarkdown })
      .from(sources)
      .where(eq(sources.id, sourceId));
    if (!sourceRow) {
      throw new Error(`source.extract: source ${sourceId} not found`);
    }
    const canonicalMarkdown = sourceRow.canonical ?? '';

    const [fileRows, pageRows] = await Promise.all([
      ctx.db
        .select({ storageKey: sourceFiles.storageKey })
        .from(sourceFiles)
        .where(and(eq(sourceFiles.sourceId, sourceId), eq(sourceFiles.role, 'original')))
        .orderBy(asc(sourceFiles.createdAt))
        .limit(1),
      ctx.db
        .select({ pageNumber: sourcePages.pageNumber, markdown: sourcePages.markdown })
        .from(sourcePages)
        .where(eq(sourcePages.sourceId, sourceId))
        .orderBy(asc(sourcePages.pageNumber)),
    ]);
    const fixtureKey = fileRows[0]
      ? fixtureKeyFromStorageKey(fileRows[0].storageKey)
      : sourceRow.slug;

    const repoCtx: RepoContext = {
      db: ctx.db,
      auth: { user: { id: 'system', name: 'system' }, roles: ['admin'], isSystem: true },
    };

    const [
      themeRows,
      sourceTypeRows,
      purposeRows,
      roleRelevanceRows,
      targetAudienceTypeRows,
      locationScopeRows,
      priorityTimescaleRows,
    ] = await Promise.all([
      listThematicAreas(repoCtx),
      listSourceTypes(repoCtx),
      listPurposes(repoCtx),
      listRoleRelevances(repoCtx),
      listTargetAudienceTypes(repoCtx),
      listLocationScopes(repoCtx),
      listPriorityTimescales(repoCtx),
    ]);
    const taxonomySlugs: TaxonomySlugLists = {
      thematic_area: themeRows.map((r) => r.slug),
      source_type: sourceTypeRows.map((r) => r.slug),
      purpose: purposeRows.map((r) => r.slug),
      role_relevance: roleRelevanceRows.map((r) => r.slug),
      target_audience_type: targetAudienceTypeRows.map((r) => r.slug),
      location_scope: locationScopeRows.map((r) => r.slug),
      priority_timescale: priorityTimescaleRows.map((r) => r.slug),
    };

    const pass1Input = truncate(canonicalMarkdown, MAX_PASS1_MARKDOWN);
    const runPass1 = () =>
      ctx.providers.llm.generateStructured({
        prompt: `Extract the source-level metadata for the following document.\n\n---\n${pass1Input}`,
        system: buildPass1Prompt(taxonomySlugs),
        schema: SourceMetadataSchema,
        key: `${fixtureKey}:metadata`,
      });

    // The fake provider is fixture-keyed and intentionally represents one
    // whole-document response. Keep it on the legacy route even though fake
    // OCR creates page rows in E2E. Every real provider uses page windows as
    // soon as usable parsed pages exist.
    const usablePageRows = pageRows.filter((page) => page.markdown.trim().length > 0);
    const usePageWindows = usablePageRows.length > 0 && ctx.providers.llm.name !== 'fake';

    const section = detectRecommendationSections(canonicalMarkdown);
    const legacyPass2Input = truncate(section.processText, MAX_PASS2_MARKDOWN);
    const legacyPass2System =
      section.mode === 'sections'
        ? buildPass2StrictPrompt(taxonomySlugs)
        : buildPass2LooserPrompt(taxonomySlugs);
    const runLegacyPass2 = () =>
      ctx.providers.llm.generateStructured({
        prompt: `Extract every actionable recommendation from the text below.\n\n---\n${legacyPass2Input}`,
        system: legacyPass2System,
        schema: RecommendationsSchema,
        key: fixtureKey,
      });

    const windows = usePageWindows
      ? buildExtractionWindows(
          usablePageRows.map((page) => ({
            pageNumber: page.pageNumber,
            markdown: page.markdown,
          })),
        )
      : [];

    const runCandidateExtraction = async (): Promise<RecommendationCandidate[]> => {
      const candidates: RecommendationCandidate[] = [];
      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index]!;
        const percent = Math.min(65, 45 + Math.round(((index + 1) / windows.length) * 20));
        await ctx.emit(sourceId, {
          type: 'progress',
          percent,
          message: `finding recommendations ${index + 1}/${windows.length} (${windowLabel(window)})`,
        });

        const result = await ctx.providers.llm.generateStructured({
          prompt: `Find actionable recommendations in this page window.\n\n---\n${window.text}`,
          system: buildRecommendationCandidatePrompt(),
          schema: RecommendationCandidatesSchema,
          key: `${fixtureKey}:candidates-${window.index}`,
        });

        for (const recommendation of result.value.recommendations) {
          candidates.push(applyWindowProvenance(recommendation, window));
        }
      }
      return dedupeRecommendations(candidates);
    };

    const runCandidateEnrichment = async (
      candidates: RecommendationCandidate[],
    ): Promise<RecommendationInput[]> => {
      if (candidates.length === 0) return [];

      const enrichments: RecommendationEnrichment[] = [];
      const totalBatches = Math.ceil(candidates.length / ENRICHMENT_BATCH_SIZE);
      for (let offset = 0, batchNumber = 0; offset < candidates.length; offset += ENRICHMENT_BATCH_SIZE) {
        batchNumber += 1;
        const batch = candidates.slice(offset, offset + ENRICHMENT_BATCH_SIZE);
        const indexedBatch = batch.map((candidate, localIndex) => ({
          candidate_index: offset + localIndex,
          title: candidate.title,
          body: candidate.body,
          page_start: candidate.page_start ?? null,
          page_end: candidate.page_end ?? null,
        }));
        const percent = Math.min(78, 65 + Math.round((batchNumber / totalBatches) * 13));
        await ctx.emit(sourceId, {
          type: 'progress',
          percent,
          message: `classifying recommendations ${batchNumber}/${totalBatches}`,
        });

        const result = await ctx.providers.llm.generateStructured({
          prompt: [
            'Classify these recommendation candidates.',
            'Return one enrichment for every candidate_index.',
            '',
            JSON.stringify(indexedBatch, null, 2),
          ].join('\n'),
          system: buildRecommendationEnrichmentPrompt(taxonomySlugs),
          schema: RecommendationEnrichmentsSchema,
          key: `${fixtureKey}:enrichment-${batchNumber - 1}`,
        });
        enrichments.push(...result.value.enrichments);
      }

      return mergeCandidateEnrichments(candidates, enrichments);
    };

    const runPageAwareExtraction = async (): Promise<RecommendationInput[]> => {
      const candidates = await runCandidateExtraction();
      if (candidates.length === 0) return [];
      await ctx.emit(sourceId, {
        type: 'progress',
        percent: 65,
        message: `found ${candidates.length} recommendation candidate(s); classifying`,
      });
      return runCandidateEnrichment(candidates);
    };

    let metadata: SourceMetadataOutput;
    let recs: RecommendationInput[];
    let extractionSummary: string;

    if (usePageWindows) {
      if (ctx.env.APP_MODE === 'local') {
        await ctx.emit(sourceId, {
          type: 'progress',
          percent: 25,
          message: 'extracting source metadata',
        });
        const pass1Result = await runPass1();
        metadata = pass1Result.value;
        await ctx.emit(sourceId, {
          type: 'progress',
          percent: 45,
          message: `scanning ${windows.length} page window(s) for recommendations`,
        });
        recs = await runPageAwareExtraction();
      } else {
        const [pass1Result, pageRecommendations] = await Promise.all([
          runPass1(),
          runPageAwareExtraction(),
        ]);
        metadata = pass1Result.value;
        recs = pageRecommendations;
      }
      extractionSummary = `from ${windows.length} page window(s), then classified separately`;
    } else {
      let pass1Result: Awaited<ReturnType<typeof runPass1>>;
      let pass2Result: Awaited<ReturnType<typeof runLegacyPass2>>;

      if (ctx.env.APP_MODE === 'local') {
        await ctx.emit(sourceId, {
          type: 'progress',
          percent: 25,
          message: 'extracting source metadata',
        });
        pass1Result = await runPass1();
        await ctx.emit(sourceId, {
          type: 'progress',
          percent: 45,
          message: 'extracting recommendations',
        });
        pass2Result = await runLegacyPass2();
      } else {
        [pass1Result, pass2Result] = await Promise.all([runPass1(), runLegacyPass2()]);
      }

      metadata = pass1Result.value;
      recs = pass2Result.value.recommendations;
      extractionSummary =
        section.mode === 'sections' ? 'from detected sections' : 'from legacy full-document input';
    }

    // ----- Source metadata -------------------------------------------------
    await ctx.db
      .update(sources)
      .set({
        summary: metadata.summary,
        authors: metadata.authors,
        publicationDate: parsePublicationDate(metadata.publication_date),
        orgOwner: metadata.org_owner,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));

    await Promise.all([
      resolveOrCreateThematicAreas(repoCtx, metadata.thematic_area_slugs).then((ids) =>
        replaceSourceThematicAreas(repoCtx, sourceId, ids),
      ),
      resolveOrCreateSourceTypes(repoCtx, metadata.source_type_slugs).then((ids) =>
        replaceSourceSourceTypes(repoCtx, sourceId, ids),
      ),
      resolveOrCreatePurposes(repoCtx, metadata.purpose_slugs).then((ids) =>
        replaceSourcePurposes(repoCtx, sourceId, ids),
      ),
      resolveOrCreateRoleRelevances(repoCtx, metadata.role_relevance_slugs).then((ids) =>
        replaceSourceRoleRelevances(repoCtx, sourceId, ids),
      ),
      resolveOrCreateTargetAudienceTypes(repoCtx, metadata.target_audience_type_slugs).then((ids) =>
        replaceSourceTargetAudienceTypes(repoCtx, sourceId, ids),
      ),
    ]);

    // ----- Recommendations -------------------------------------------------
    const [themeIdsPerRec, purposeIdsPerRec, audienceIdsPerRec, locationIdsPerRec, priorityIdsPerRec] =
      await Promise.all([
        batchResolveTaxonomy(
          repoCtx,
          recs.map((r) => r.thematic_area_slugs),
          resolveOrCreateThematicAreas,
        ),
        batchResolveTaxonomy(
          repoCtx,
          recs.map((r) => r.purpose_slugs),
          resolveOrCreatePurposes,
        ),
        batchResolveTaxonomy(
          repoCtx,
          recs.map((r) => r.target_audience_type_slugs),
          resolveOrCreateTargetAudienceTypes,
        ),
        batchResolveTaxonomy(
          repoCtx,
          recs.map((r) => r.location_scope_slugs),
          resolveOrCreateLocationScopes,
        ),
        recs.length > 0
          ? (async () => {
              const uniqueSlugs = Array.from(
                new Set(
                  recs
                    .map((r) => r.priority_timescale_slug)
                    .filter((s): s is string => s !== null && s !== undefined),
                ),
              );
              if (uniqueSlugs.length === 0) return [];
              const ids = await resolveOrCreatePriorityTimescales(repoCtx, uniqueSlugs);
              const slugToId = new Map(uniqueSlugs.map((s, i) => [s, ids[i] ?? null]));
              return recs.map((r) => {
                const slug = r.priority_timescale_slug;
                return slug ? (slugToId.get(slug) ?? null) : null;
              });
            })()
          : Promise.resolve([] as (string | null)[]),
      ]);

    await ctx.db.transaction(async (tx) => {
      // Idempotency: delete existing recs for this source. Cascades clear
      // recommendation_statuses + every rec-side M2M row automatically.
      await tx.delete(recommendations).where(eq(recommendations.sourceId, sourceId));

      if (recs.length === 0) return;

      const insertedRecs = await tx
        .insert(recommendations)
        .values(
          recs.map((rec, i) => {
            const slugBase = rec.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 80);
            const slug = `${slugBase || 'rec'}-${sourceId.slice(0, 8)}-${i}`;
            return {
              sourceId,
              slug,
              title: rec.title,
              body: rec.body,
              pageAnchor: rec.page_start ?? null,
              targetOrganization: rec.target_organization ?? null,
              priorityTimescaleId: priorityIdsPerRec[i] ?? null,
              notes: rec.notes ?? null,
              confidence: rec.confidence,
            };
          }),
        )
        .returning({ id: recommendations.id });

      if (insertedRecs.length !== recs.length) {
        throw new Error(
          `source.extract: inserted ${insertedRecs.length} recs, expected ${recs.length}`,
        );
      }

      await tx.insert(recommendationStatuses).values(
        insertedRecs.map((r) => ({
          recommendationId: r.id,
          status: 'open' as const,
          note: 'initial',
        })),
      );

      const themeRows: Array<{ recommendationId: string; thematicAreaId: string }> = [];
      const purposeRows: Array<{ recommendationId: string; purposeId: string }> = [];
      const audienceRows: Array<{ recommendationId: string; targetAudienceTypeId: string }> = [];
      const locationRows: Array<{ recommendationId: string; locationScopeId: string }> = [];

      for (let i = 0; i < recs.length; i += 1) {
        const recId = insertedRecs[i]!.id;
        for (const id of themeIdsPerRec[i] ?? []) {
          themeRows.push({ recommendationId: recId, thematicAreaId: id });
        }
        for (const id of purposeIdsPerRec[i] ?? []) {
          purposeRows.push({ recommendationId: recId, purposeId: id });
        }
        for (const id of audienceIdsPerRec[i] ?? []) {
          audienceRows.push({ recommendationId: recId, targetAudienceTypeId: id });
        }
        for (const id of locationIdsPerRec[i] ?? []) {
          locationRows.push({ recommendationId: recId, locationScopeId: id });
        }
      }

      await Promise.all([
        themeRows.length > 0
          ? tx.insert(recommendationsThematicAreas).values(themeRows)
          : Promise.resolve(),
        purposeRows.length > 0
          ? tx.insert(recommendationsPurposes).values(purposeRows)
          : Promise.resolve(),
        audienceRows.length > 0
          ? tx.insert(recommendationsTargetAudienceTypes).values(audienceRows)
          : Promise.resolve(),
        locationRows.length > 0
          ? tx.insert(recommendationsLocationScopes).values(locationRows)
          : Promise.resolve(),
      ]);
    });

    await ctx.db
      .update(sources)
      .set({ status: 'embedding', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
    await ctx.queue.enqueue('source.embed', { sourceId });

    await ctx.emit(sourceId, {
      type: 'progress',
      percent: 80,
      message: `extracted ${recs.length} recommendation(s) ${extractionSummary}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await ctx.emit(sourceId, { type: 'error', message });
    } catch {
      // emit failure shouldn't mask the real error
    }
    try {
      await ctx.db
        .update(sources)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(sources.id, sourceId));
    } catch {
      // bookkeeping failures shouldn't mask the real error
    }
    throw err;
  }
}
