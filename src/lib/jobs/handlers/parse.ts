import { and, asc, eq } from 'drizzle-orm';
import type { JobContext } from '../context';
import type { QueuePayloads } from '../types';
import { sourceFiles, sourcePages, sources } from '@/lib/db/schema';

/**
 * `source.parse` handler.
 *
 * Pipeline step 1: pull the uploaded file from storage, run it through the
 * configured document parser, persist canonical markdown + per-page rows,
 * then enqueue `source.extract` for the next stage.
 *
 * Event channel convention
 * ------------------------
 * Handlers receive the queue payload only — pg-boss's `jobId` is not threaded
 * through to us (see `registerHandlers` wiring). For pipeline events we use
 * `sourceId` as the channel id. A source has a natural 1:1 with a pipeline
 * run; scoping events to the source lets the UI subscribe once per source
 * and watch every stage (`parsing` → `extracting` → `embedding` → `ready`)
 * without juggling per-stage job ids. The existing
 * `/api/jobs/[id]/stream` route treats `id` as a channel id, so this works
 * without a new route.
 *
 * Status mapping
 * --------------
 * The plan wording says "set status='parsed' on success", but the schema
 * enum has no `parsed` — it exposes the pipeline *phases*: pending, parsing,
 * extracting, embedding, ready, failed. We therefore drive `sources.status`
 * directly from the phase the source is entering. After a successful parse
 * the source is ready for extraction, so we leave it in `extracting`.
 *
 * Retry policy
 * ------------
 * On any throw we best-effort emit an `error` event, flip `sources.status`
 * to `failed`, then rethrow so pg-boss sees the failure. pg-boss retries up
 * to its default (3) times; for deterministic failures that just wastes
 * work. Tuning the retry policy is a future task.
 */
export async function parseHandler(
  ctx: JobContext,
  payload: QueuePayloads['source.parse'],
): Promise<void> {
  const { sourceId } = payload;
  try {
    await ctx.emit(sourceId, { type: 'phase', phase: 'parsing' });

    // Flip status early so a crash mid-parse doesn't leave the row stuck
    // in `pending`. Matches the phase event above.
    await ctx.db
      .update(sources)
      .set({ status: 'parsing', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));

    // Look up the original upload. Schema permits multiple files per source
    // (page images, extracted assets); for parse we take the first
    // `original` row by creation order. Multi-file / re-parse handling is
    // out of scope for Task 8.
    const fileRows = await ctx.db
      .select({
        storageKey: sourceFiles.storageKey,
      })
      .from(sourceFiles)
      .where(and(eq(sourceFiles.sourceId, sourceId), eq(sourceFiles.role, 'original')))
      .orderBy(asc(sourceFiles.createdAt))
      .limit(1);
    const fileRow = fileRows[0];
    if (!fileRow) {
      throw new Error(`source.parse: no original file found for source ${sourceId}`);
    }

    const bytes = await ctx.providers.storage.get(fileRow.storageKey);
    // Fake parser resolves fixtures by `<filename-stem>.canonical.md`; real
    // adapters only care about the raw bytes. The filename is the last
    // segment of the storage key we generated at upload time.
    const filename = fileRow.storageKey.split('/').pop() ?? fileRow.storageKey;

    // `ocr` is retained as a compatibility alias while config/admin surfaces
    // still use OCR_PROVIDER. New provider factories expose the same instance
    // as `parser`, which better describes text-layer and layout parsers that
    // may perform no OCR at all.
    const parser = ctx.providers.parser ?? ctx.providers.ocr;
    const parsed = await parser.parseDocument({ filename, bytes });

    // Page inserts + sources update land together. If any page insert fails
    // we don't want a half-parsed source left around — the transaction
    // rolls everything back and we fall through to the catch below.
    await ctx.db.transaction(async (tx) => {
      // why: pg-boss retries failed jobs; clearing existing page rows first
      // keeps re-parses idempotent (no duplicate page rows per source).
      await tx.delete(sourcePages).where(eq(sourcePages.sourceId, sourceId));
      if (parsed.pages.length > 0) {
        await tx.insert(sourcePages).values(
          parsed.pages.map((page) => ({
            sourceId,
            pageNumber: page.pageNumber,
            markdown: page.markdown,
            imageRefs: page.imageRefs,
          })),
        );
      }
      await tx
        .update(sources)
        .set({
          canonicalMarkdown: parsed.markdown,
          status: 'extracting',
          updatedAt: new Date(),
        })
        .where(eq(sources.id, sourceId));
    });

    // Only hand off once the write above commits — otherwise the next
    // handler could race us and find a half-written source.
    await ctx.queue.enqueue('source.extract', { sourceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: surface the error on the event stream and mark the row
    // failed. Swallow any secondary failures so the original error still
    // escapes (pg-boss's retry/backoff decision needs to see it).
    try {
      await ctx.emit(sourceId, { type: 'error', message });
    } catch {
      // emit failures shouldn't mask the real error
    }
    try {
      await ctx.db
        .update(sources)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(sources.id, sourceId));
    } catch {
      // same: the root cause matters more than our bookkeeping
    }
    throw err;
  }
}
