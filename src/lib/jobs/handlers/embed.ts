import { and, eq, isNull, sql } from 'drizzle-orm';
import type { JobContext } from '../context';
import type { QueuePayloads } from '../types';
import {
  EMBEDDING_DIM,
  recommendations,
  sourcePages,
  sources,
} from '@/lib/db/schema';
import type { EmbeddingProvider } from '@/lib/providers/embedding/types';
import {
  failSourcePipelineAttempt,
  startSourcePipelineAttempt,
  succeedSourcePipelineAttempt,
} from '@/lib/repositories/source-pipeline-attempt';

/**
 * Batch size for embedding calls. 32 is small enough to keep memory bounded
 * for long documents and big enough to amortise per-call overhead against
 * typical embedding providers. Keep this a module-local constant so tests
 * can assert the exact batching behaviour.
 */
const BATCH_SIZE = 32;

/**
 * `source.embed` handler — terminal stage of the pipeline.
 *
 * Pipeline step 3: embed every still-NULL row in `recommendations` AND
 * `source_pages` for the source, then flip `sources.status` to `ready` and
 * emit the terminal `phase: 'ready'` event.
 *
 * Two tables, one handler — recommendations power the recs index search
 * and `/recommendations/[id]` similarity rail; source_pages power the
 * `/chat` retrieval layer (`searchSourcePages` requires `embedding IS NOT
 * NULL`). If we only embedded recs the chat surface would always answer
 * "no passages retrieved", which is exactly the bug this commit fixes.
 *
 * Idempotency
 * -----------
 * On pg-boss retry the `embedding IS NULL` filter on each table naturally
 * scopes work to rows that haven't been embedded yet. A partial previous
 * run doesn't need cleanup — the retry just picks up the remaining NULL
 * rows. No outer transaction: each batch's UPDATEs are atomic on their own
 * and the final `sources.status='ready'` flip is a separate statement.
 *
 * Dim validation
 * --------------
 * We reject vectors whose length doesn't match {@link EMBEDDING_DIM} before
 * writing. Catches a provider / model swap that would otherwise surface as
 * a pgvector "expected N dimensions" error deep in the UPDATE.
 */
export async function embedHandler(
  ctx: JobContext,
  payload: QueuePayloads['source.embed'],
): Promise<void> {
  const { sourceId } = payload;
  const attempt = await startSourcePipelineAttempt(ctx.db, {
    sourceId,
    stage: 'embed',
    provider: ctx.providers.embedding.name,
    model: ctx.providers.embedding.model,
    metadata: { dimensions: ctx.providers.embedding.dimensions },
  });

  try {
    await ctx.emit(sourceId, { type: 'phase', phase: 'embedding' });

    // Pull every row that still needs embedding from both tables. For
    // realistic source sizes (tens to low hundreds of recs + pages) a
    // single pair of selects is fine; if we ever chew through thousands
    // we can paginate.
    const pendingRecs = await ctx.db
      .select({
        id: recommendations.id,
        title: recommendations.title,
        body: recommendations.body,
      })
      .from(recommendations)
      .where(and(eq(recommendations.sourceId, sourceId), isNull(recommendations.embedding)));

    const pendingPages = await ctx.db
      .select({
        id: sourcePages.id,
        markdown: sourcePages.markdown,
      })
      .from(sourcePages)
      .where(and(eq(sourcePages.sourceId, sourceId), isNull(sourcePages.embedding)));

    const total = pendingRecs.length + pendingPages.length;
    let done = 0;

    const emitProgress = async (): Promise<void> => {
      // Cap progress at 99 — phase:'ready' below is the signal for 100%.
      const percent = Math.min(99, Math.round((done / Math.max(total, 1)) * 100));
      if (percent >= 1) {
        await ctx.emit(sourceId, {
          type: 'progress',
          percent,
          message: `${done}/${total} embedded`,
        });
      }
    };

    // -- recommendations -----------------------------------------------------
    for (let start = 0; start < pendingRecs.length; start += BATCH_SIZE) {
      const batch = pendingRecs.slice(start, start + BATCH_SIZE);
      const texts = batch.map((r) => `${r.title}\n\n${r.body}`);
      const vectors = await embedAndValidate(ctx.providers.embedding, texts);

      const modelTag = ctx.providers.embedding.model;
      const rows = batch.map((row, i) => ({ id: row.id, vector: vectors[i]! }));
      // One bulk UPDATE per batch (UPDATE ... FROM (VALUES ...)) instead of one
      // statement per row — 100 recs become a handful of round-trips, not 100.
      await ctx.db.execute(sql`
        update recommendations as r
        set embedding = data.embedding,
            embedding_model = ${modelTag},
            updated_at = now()
        from (values ${vectorValues(rows)}) as data(id, embedding)
        where r.id = data.id
      `);

      done += batch.length;
      await emitProgress();
    }

    // -- source pages --------------------------------------------------------
    for (let start = 0; start < pendingPages.length; start += BATCH_SIZE) {
      const batch = pendingPages.slice(start, start + BATCH_SIZE);
      const texts = batch.map((p) => p.markdown);
      const vectors = await embedAndValidate(ctx.providers.embedding, texts);

      const modelTag = ctx.providers.embedding.model;
      const rows = batch.map((row, i) => ({ id: row.id, vector: vectors[i]! }));
      await ctx.db.execute(sql`
        update source_pages as p
        set embedding = data.embedding,
            embedding_model = ${modelTag}
        from (values ${vectorValues(rows)}) as data(id, embedding)
        where p.id = data.id
      `);

      done += batch.length;
      await emitProgress();
    }

    await ctx.db
      .update(sources)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));

    await ctx.emit(sourceId, { type: 'phase', phase: 'ready' });
    await succeedSourcePipelineAttempt(ctx.db, attempt, {
      dimensions: ctx.providers.embedding.dimensions,
      recommendationCount: pendingRecs.length,
      pageCount: pendingPages.length,
      embeddedCount: total,
    });
  } catch (err) {
    await failSourcePipelineAttempt(ctx.db, attempt, err).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
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
      // bookkeeping failures shouldn't mask the real error
    }
    throw err;
  }
}

/**
 * Build the `(id::uuid, embedding::vector), ...` tuple list for a bulk
 * `UPDATE ... FROM (VALUES ...)`. Each value is parameterised; the per-row
 * casts pin the column types so Postgres infers `data(id, embedding)`
 * correctly. The embedding is passed as a pgvector text literal (`[a,b,...]`)
 * — the same shape the driver writes for the typed column.
 */
function vectorValues(rows: ReadonlyArray<{ id: string; vector: number[] }>) {
  return sql.join(
    rows.map((row) => sql`(${row.id}::uuid, ${`[${row.vector.join(',')}]`}::vector)`),
    sql`, `,
  );
}

async function embedAndValidate(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  const vectors = await provider.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(
      `embed: provider returned ${vectors.length} vectors for ${texts.length} inputs`,
    );
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(
        `embed: expected ${EMBEDDING_DIM}-dim vectors, got ${v.length} from provider`,
      );
    }
  }
  return vectors;
}
