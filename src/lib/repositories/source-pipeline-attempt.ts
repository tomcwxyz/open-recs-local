import { and, desc, eq, sql } from 'drizzle-orm';
import {
  sourcePipelineAttempts,
  type PipelineAttemptStatus,
  type PipelineErrorCategory,
  type PipelineStage,
} from '@/lib/db/schema';
import type { Db } from '@/lib/db/client';
import type { RepoContext } from './types';
import { classifyPipelineFailure } from '@/lib/services/pipeline-failure';

export type PipelineAttemptHandle = {
  id: string;
  sourceId: string;
  stage: PipelineStage;
  attempt: number;
  startedAt: Date;
};

export type StartPipelineAttemptInput = {
  sourceId: string;
  stage: PipelineStage;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type SourcePipelineAttemptRow = {
  id: string;
  stage: PipelineStage;
  attempt: number;
  status: PipelineAttemptStatus;
  provider: string | null;
  model: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorCategory: PipelineErrorCategory | null;
  errorMessage: string | null;
  retrySafe: boolean;
  metadata: Record<string, unknown>;
};

/**
 * Allocate a monotonically increasing attempt number for (source, stage).
 * The advisory transaction lock prevents two pg-boss retries from both
 * observing the same max(attempt) before either insert commits.
 */
export async function startSourcePipelineAttempt(
  db: Db,
  input: StartPipelineAttemptInput,
): Promise<PipelineAttemptHandle> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.sourceId}), hashtext(${input.stage}))`,
    );

    const [latest] = await tx
      .select({
        attempt: sql<number>`coalesce(max(${sourcePipelineAttempts.attempt}), 0)`,
      })
      .from(sourcePipelineAttempts)
      .where(
        and(
          eq(sourcePipelineAttempts.sourceId, input.sourceId),
          eq(sourcePipelineAttempts.stage, input.stage),
        ),
      );
    const attempt = Number(latest?.attempt ?? 0) + 1;

    const values: typeof sourcePipelineAttempts.$inferInsert = {
      sourceId: input.sourceId,
      stage: input.stage,
      attempt,
      status: 'running',
      metadata: input.metadata ?? {},
    };
    if (input.provider !== undefined) values.provider = input.provider;
    if (input.model !== undefined) values.model = input.model;

    const [inserted] = await tx
      .insert(sourcePipelineAttempts)
      .values(values)
      .returning({
        id: sourcePipelineAttempts.id,
        startedAt: sourcePipelineAttempts.startedAt,
      });
    if (!inserted) throw new Error('pipeline attempt insert returned no row');

    return {
      id: inserted.id,
      sourceId: input.sourceId,
      stage: input.stage,
      attempt,
      startedAt: inserted.startedAt,
    };
  });
}

function durationMs(handle: PipelineAttemptHandle, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - handle.startedAt.getTime());
}

export async function succeedSourcePipelineAttempt(
  db: Db,
  handle: PipelineAttemptHandle,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const finishedAt = new Date();
  const update: Partial<typeof sourcePipelineAttempts.$inferInsert> = {
    status: 'succeeded',
    finishedAt,
    durationMs: durationMs(handle, finishedAt),
    retrySafe: false,
    ...(metadata !== undefined ? { metadata } : {}),
  };
  await db
    .update(sourcePipelineAttempts)
    .set(update)
    .where(eq(sourcePipelineAttempts.id, handle.id));
}

export async function failSourcePipelineAttempt(
  db: Db,
  handle: PipelineAttemptHandle,
  error: unknown,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const finishedAt = new Date();
  const classified = classifyPipelineFailure(handle.stage, error);
  const update: Partial<typeof sourcePipelineAttempts.$inferInsert> = {
    status: 'failed',
    finishedAt,
    durationMs: durationMs(handle, finishedAt),
    errorCategory: classified.category,
    errorMessage: classified.message,
    retrySafe: classified.retrySafe,
    ...(metadata !== undefined ? { metadata } : {}),
  };
  await db
    .update(sourcePipelineAttempts)
    .set(update)
    .where(eq(sourcePipelineAttempts.id, handle.id));
}

export async function listSourcePipelineAttempts(
  ctx: RepoContext,
  sourceId: string,
  limit = 20,
): Promise<SourcePipelineAttemptRow[]> {
  const bounded = Math.max(1, Math.min(100, limit));
  return ctx.db
    .select({
      id: sourcePipelineAttempts.id,
      stage: sourcePipelineAttempts.stage,
      attempt: sourcePipelineAttempts.attempt,
      status: sourcePipelineAttempts.status,
      provider: sourcePipelineAttempts.provider,
      model: sourcePipelineAttempts.model,
      startedAt: sourcePipelineAttempts.startedAt,
      finishedAt: sourcePipelineAttempts.finishedAt,
      durationMs: sourcePipelineAttempts.durationMs,
      errorCategory: sourcePipelineAttempts.errorCategory,
      errorMessage: sourcePipelineAttempts.errorMessage,
      retrySafe: sourcePipelineAttempts.retrySafe,
      metadata: sourcePipelineAttempts.metadata,
    })
    .from(sourcePipelineAttempts)
    .where(eq(sourcePipelineAttempts.sourceId, sourceId))
    .orderBy(desc(sourcePipelineAttempts.startedAt))
    .limit(bounded);
}
