import { and, asc, eq } from 'drizzle-orm';
import type { JobContext } from '../context';
import type { QueuePayloads } from '../types';
import {
  recommendations,
  recommendationStatuses,
  sourceFiles,
  sources,
} from '@/lib/db/schema';
import {
  RecommendationsSchema,
  SourceMetadataSchema,
  type RecommendationInput,
  type SourceMetadataOutput,
} from '@/lib/services/extraction-schema';
import { detectRecommendationSections } from '@/lib/services/extraction-sections';
import {
  buildPass1Prompt,
  buildPass2LooserPrompt,
  buildPass2StrictPrompt,
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
// Pass 2 used to truncate at 100k chars (~25k tokens), which is more than
// any local 8B model can chew through in a reasonable time on Apple
// Silicon — a 122k-char doc took 6+ minutes and intermittently left the
// worker stuck on a hung fetch. 30k chars (~7.5k tokens) fits in a 12k
// context window and lets a single Pass 2 call finish in roughly a
// minute. Sources with explicit rec sections usually return far less
// than this from `detectRecommendationSections` anyway.
//
// This head-truncation fallback is still a known recall problem for long
// reports whose recommendations appear late in the document. The local-ingest
// roadmap replaces it with page-aware extraction windows; keep the current cap
// until that work lands so this reliability change stays behaviourally small.
const MAX_PASS2_MARKDOWN = 30_000;

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

/**
 * `source.extract` handler — two-pass, section-aware.
 *
 * Pass 1: source metadata (summary, authors, dates, taxonomies for the
 * source itself). Reads the first ~10k chars of canonical markdown so the
 * LLM sees front matter + executive summary without the whole document.
 *
 * Pass 2: recommendations. Detects recommendation-shaped headings; if
 * found, sends just those sections with a strict prompt; otherwise sends
 * the (truncated) full document with a looser prompt. Persists every rec
 * with its multi-axis tags + priority_timescale FK + confidence.
 *
 * Local concurrency: cloud APIs benefit from running the two independent
 * passes concurrently, but a 16 GB local inference host does not. In local
 * mode we deliberately run Pass 1 then Pass 2 so Ollama does not have to
 * queue/parallelise two long-context structured generations whose deadlines
 * are already ticking. Hosted mode retains the parallel path.
 *
 * Idempotency: pg-boss retries trigger a full re-run. Both passes are
 * idempotent — Pass 1 UPDATEs source columns and calls `replaceSource*`
 * (set membership, not append); Pass 2 deletes existing recs for the
 * source before inserting, and `replaceRecommendation*` is set membership.
 *
 * Unknown slugs: the LLM is asked to coin a new slug when no listed slug
 * fits. `resolveOrCreate*` auto-creates those with `unverified=true` so
 * an admin can promote / rename / merge / delete via /admin/tags (PR 3).
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

    // Locate the original upload so the fake LLM provider can find the
    // matching fixture file. Real LLM adapters ignore `key`.
    const fileRows = await ctx.db
      .select({ storageKey: sourceFiles.storageKey })
      .from(sourceFiles)
      .where(and(eq(sourceFiles.sourceId, sourceId), eq(sourceFiles.role, 'original')))
      .orderBy(asc(sourceFiles.createdAt))
      .limit(1);
    const fixtureKey = fileRows[0] ? fixtureKeyFromStorageKey(fileRows[0].storageKey) : sourceRow.slug;

    // RepoContext for the taxonomy + tag-membership repo functions. Uses
    // the same db handle as the rest of the handler; auth is system context
    // because extraction runs under the worker, not a user request.
    const repoCtx: RepoContext = {
      db: ctx.db,
      auth: { user: { id: 'system', name: 'system' }, roles: ['admin'], isSystem: true },
    };

    // Load every taxonomy axis up front. The slugs are interpolated into
    // both prompts so the LLM picks from known vocabulary.
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
    const section = detectRecommendationSections(canonicalMarkdown);
    const pass2Input = truncate(section.processText, MAX_PASS2_MARKDOWN);
    const pass2System =
      section.mode === 'sections'
        ? buildPass2StrictPrompt(taxonomySlugs)
        : buildPass2LooserPrompt(taxonomySlugs);

    const runPass1 = () =>
      ctx.providers.llm.generateStructured({
        prompt: `Extract the source-level metadata for the following document.\n\n---\n${pass1Input}`,
        system: buildPass1Prompt(taxonomySlugs),
        schema: SourceMetadataSchema,
        key: `${fixtureKey}:metadata`,
      });
    const runPass2 = () =>
      ctx.providers.llm.generateStructured({
        prompt: `Extract every actionable recommendation from the text below.\n\n---\n${pass2Input}`,
        system: pass2System,
        schema: RecommendationsSchema,
        key: fixtureKey,
      });

    let pass1Result: Awaited<ReturnType<typeof runPass1>>;
    let pass2Result: Awaited<ReturnType<typeof runPass2>>;

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
      pass2Result = await runPass2();
    } else {
      [pass1Result, pass2Result] = await Promise.all([runPass1(), runPass2()]);
    }

    const metadata: SourceMetadataOutput = pass1Result.value;
    const recs: RecommendationInput[] = pass2Result.value.recommendations;

    // ----- Source metadata (from Pass 1) — all 5 axes in parallel ---------
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

    // Each axis is independent: resolve-or-create slugs, then replace M2M.
    // Running all 5 in parallel cuts 5 sequential round-trips to 1.
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

    // ----- Recommendations (from Pass 2) ------------------------------------
    // Batch-resolve all 5 taxonomy axes upfront (N+1 -> 1 DB call per axis).
    // Priority timescale is single-valued per rec but still batched across recs.
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
        // Priority timescale: single slug per rec, but we batch all unique
        // slugs across recs into one resolveOrCreatePriorityTimescales call.
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

    // Single transaction: delete old recs → bulk insert new recs → bulk insert
    // statuses → bulk insert all M2M rows. If any step fails the transaction
    // rolls back and no partial state remains.
    await ctx.db.transaction(async (tx) => {
      // Idempotency: delete existing recs for this source. Cascades clear
      // recommendation_statuses + every rec-side M2M row automatically.
      await tx.delete(recommendations).where(eq(recommendations.sourceId, sourceId));

      if (recs.length === 0) return;

      // Bulk insert all recommendations, returning IDs for M2M linking.
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

      // Bulk insert initial 'open' status for every rec.
      await tx.insert(recommendationStatuses).values(
        insertedRecs.map((r) => ({
          recommendationId: r.id,
          status: 'open' as const,
          note: 'initial',
        })),
      );

      // Bulk insert M2M rows per axis. Since CASCADE on delete cleared all
      // existing M2M rows, we just insert fresh — no diff needed.
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

      // Insert all M2M rows in parallel (one INSERT per axis).
      await Promise.all([
        themeRows.length > 0 ? tx.insert(recommendationsThematicAreas).values(themeRows) : Promise.resolve(),
        purposeRows.length > 0 ? tx.insert(recommendationsPurposes).values(purposeRows) : Promise.resolve(),
        audienceRows.length > 0 ? tx.insert(recommendationsTargetAudienceTypes).values(audienceRows) : Promise.resolve(),
        locationRows.length > 0 ? tx.insert(recommendationsLocationScopes).values(locationRows) : Promise.resolve(),
      ]);
    });

    // Final phase update — source advances to `embedding` (the next pipeline
    // stage). The actual `source.embed` enqueue lives in the queue wiring.
    await ctx.db
      .update(sources)
      .set({ status: 'embedding', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
    await ctx.queue.enqueue('source.embed', { sourceId });

    await ctx.emit(sourceId, {
      type: 'progress',
      percent: 80,
      message: `extracted ${recs.length} recommendation(s); ${section.mode === 'sections' ? 'from sections' : 'from full document'}`,
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
