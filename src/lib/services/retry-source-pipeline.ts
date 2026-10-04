import { and, desc, eq, sql } from 'drizzle-orm';
import {
  recommendations,
  sourcePages,
  sourcePipelineAttempts,
  sources,
  type PipelineStage,
  type SourceStatus,
} from '@/lib/db/schema';
import type { RepoContext } from '@/lib/repositories/types';

export type RetryPipelineError =
  | 'unauthorized'
  | 'not_found'
  | 'not_failed'
  | 'stale_attempt'
  | 'unsafe_retry';

export type RetryPipelineResult =
  | {
      ok: true;
      jobId: string;
      stage: PipelineStage;
      sourceId: string;
      resetEmbeddings: boolean;
    }
  | { ok: false; error: RetryPipelineError };

export type RetryPipelineEnqueue = (
  stage: PipelineStage,
  sourceId: string,
) => Promise<string>;

export type RetryPipelineInput = {
  attemptId: string;
  currentEmbeddingModel?: string | null | undefined;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canRetry(ctx: RepoContext): boolean {
  return (
    ctx.auth.isSystem ||
    ctx.auth.roles.includes('admin') ||
    ctx.auth.roles.includes('editor')
  );
}

function statusForStage(stage: PipelineStage): SourceStatus {
  if (stage === 'parse') return 'parsing';
  if (stage === 'extract') return 'extracting';
  return 'embedding';
}

/**
 * Validate and queue a retry while holding a row lock on the source.
 *
 * The source is moved away from `failed` inside the same transaction that
 * validates the latest attempt. Concurrent clicks therefore serialize: only
 * the first request sees a failed source/latest failed attempt and reaches the
 * enqueue callback.
 *
 * The enqueue happens before the transaction commits. If it throws, the source
 * status (and any embed reset) roll back. A worker may pick up the job quickly,
 * but its source UPDATE will block behind this row lock until the reservation
 * commits.
 */
export async function retrySourcePipelineStage(
  ctx: RepoContext,
  input: RetryPipelineInput,
  enqueue: RetryPipelineEnqueue,
): Promise<RetryPipelineResult> {
  if (!canRetry(ctx)) return { ok: false, error: 'unauthorized' };
  if (!UUID_RE.test(input.attemptId)) return { ok: false, error: 'not_found' };

  return ctx.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      sourceId: string;
      stage: PipelineStage;
      attempt: number;
      status: 'running' | 'succeeded' | 'failed';
      retrySafe: boolean;
      model: string | null;
      sourceStatus: SourceStatus;
    }>(sql`
      SELECT
        pa.id::text AS "id",
        pa.source_id::text AS "sourceId",
        pa.stage AS "stage",
        pa.attempt AS "attempt",
        pa.status AS "status",
        pa.retry_safe AS "retrySafe",
        pa.model AS "model",
        s.status AS "sourceStatus"
      FROM source_pipeline_attempts pa
      JOIN sources s ON s.id = pa.source_id
      WHERE pa.id = ${input.attemptId}::uuid
      FOR UPDATE OF s
    `);

    const attempt = rows[0];
    if (!attempt) return { ok: false, error: 'not_found' } as const;
    if (attempt.status !== 'failed') return { ok: false, error: 'not_failed' } as const;
    if (attempt.sourceStatus !== 'failed') return { ok: false, error: 'not_failed' } as const;

    const [latest] = await tx
      .select({
        id: sourcePipelineAttempts.id,
        attempt: sourcePipelineAttempts.attempt,
      })
      .from(sourcePipelineAttempts)
      .where(
        and(
          eq(sourcePipelineAttempts.sourceId, attempt.sourceId),
          eq(sourcePipelineAttempts.stage, attempt.stage),
        ),
      )
      .orderBy(desc(sourcePipelineAttempts.attempt))
      .limit(1);

    if (!latest || latest.id !== attempt.id) {
      return { ok: false, error: 'stale_attempt' } as const;
    }
    if (!attempt.retrySafe) return { ok: false, error: 'unsafe_retry' } as const;

    let resetEmbeddings = false;
    if (
      attempt.stage === 'embed' &&
      input.currentEmbeddingModel &&
      attempt.model !== input.currentEmbeddingModel
    ) {
      resetEmbeddings = true;
      await Promise.all([
        tx
          .update(recommendations)
          .set({ embedding: null, embeddingModel: null })
          .where(eq(recommendations.sourceId, attempt.sourceId)),
        tx
          .update(sourcePages)
          .set({ embedding: null, embeddingModel: null })
          .where(eq(sourcePages.sourceId, attempt.sourceId)),
      ]);
    }

    await tx
      .update(sources)
      .set({
        status: statusForStage(attempt.stage),
        updatedAt: new Date(),
      })
      .where(eq(sources.id, attempt.sourceId));

    const jobId = await enqueue(attempt.stage, attempt.sourceId);

    return {
      ok: true,
      jobId,
      stage: attempt.stage,
      sourceId: attempt.sourceId,
      resetEmbeddings,
    };
  });
}
