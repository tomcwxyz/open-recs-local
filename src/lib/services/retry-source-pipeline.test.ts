import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, type DbClient } from '@/lib/db/client';
import {
  recommendations,
  sourcePages,
  sourcePipelineAttempts,
  sources,
} from '@/lib/db/schema';
import type { RepoContext } from '@/lib/repositories/types';
import { applyMigrations } from '../../tests/helpers/migrate';
import { startPostgres, type StartedPg } from '../../tests/helpers/pg-container';
import { retrySourcePipelineStage } from './retry-source-pipeline';

let pg: StartedPg;
let client: DbClient;

function ctx(roles: Array<'admin' | 'editor' | 'viewer'> = ['admin']): RepoContext {
  return {
    db: client.db,
    auth: {
      user: { id: randomUUID(), email: 'retry@test' },
      roles,
      isSystem: false,
    },
  };
}

async function seedFailedSource(): Promise<string> {
  const [row] = await client.db
    .insert(sources)
    .values({
      slug: `retry-${randomUUID().slice(0, 8)}`,
      title: 'Retry test',
      status: 'failed',
    })
    .returning({ id: sources.id });
  if (!row) throw new Error('seed source returned no row');
  return row.id;
}

async function seedAttempt(
  sourceId: string,
  input: {
    stage: 'parse' | 'extract' | 'embed';
    attempt: number;
    status?: 'running' | 'succeeded' | 'failed';
    retrySafe?: boolean;
    model?: string | null;
  },
): Promise<string> {
  const [row] = await client.db
    .insert(sourcePipelineAttempts)
    .values({
      sourceId,
      stage: input.stage,
      attempt: input.attempt,
      status: input.status ?? 'failed',
      retrySafe: input.retrySafe ?? true,
      model: input.model ?? null,
      finishedAt: new Date(),
    })
    .returning({ id: sourcePipelineAttempts.id });
  if (!row) throw new Error('seed attempt returned no row');
  return row.id;
}

beforeAll(async () => {
  pg = await startPostgres();
  await applyMigrations(pg.url).then(({ sql }) => sql.end());
  client = createDb(pg.url);
}, 120_000);

afterAll(async () => {
  await client?.sql.end({ timeout: 5 });
  await pg?.container.stop();
});

describe('retrySourcePipelineStage', () => {
  it('queues the latest retry-safe failed stage and moves source back into that phase', async () => {
    const sourceId = await seedFailedSource();
    const attemptId = await seedAttempt(sourceId, { stage: 'extract', attempt: 1 });
    const enqueued: Array<{ stage: string; sourceId: string }> = [];

    const result = await retrySourcePipelineStage(
      ctx(),
      { attemptId },
      async (stage, id) => {
        enqueued.push({ stage, sourceId: id });
        return 'job-1';
      },
    );

    expect(result).toMatchObject({
      ok: true,
      jobId: 'job-1',
      stage: 'extract',
      sourceId,
      resetEmbeddings: false,
    });
    expect(enqueued).toEqual([{ stage: 'extract', sourceId }]);

    const [source] = await client.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(source?.status).toBe('extracting');
  });

  it('refuses viewers, unsafe attempts, and stale attempts', async () => {
    const sourceId = await seedFailedSource();
    const unsafeId = await seedAttempt(sourceId, {
      stage: 'parse',
      attempt: 1,
      retrySafe: false,
    });

    const viewer = await retrySourcePipelineStage(
      ctx(['viewer']),
      { attemptId: unsafeId },
      async () => 'never',
    );
    expect(viewer).toEqual({ ok: false, error: 'unauthorized' });

    const unsafe = await retrySourcePipelineStage(
      ctx(),
      { attemptId: unsafeId },
      async () => 'never',
    );
    expect(unsafe).toEqual({ ok: false, error: 'unsafe_retry' });

    await client.db
      .update(sourcePipelineAttempts)
      .set({ retrySafe: true })
      .where(eq(sourcePipelineAttempts.id, unsafeId));
    await seedAttempt(sourceId, {
      stage: 'parse',
      attempt: 2,
      status: 'succeeded',
      retrySafe: false,
    });

    const stale = await retrySourcePipelineStage(
      ctx(),
      { attemptId: unsafeId },
      async () => 'never',
    );
    expect(stale).toEqual({ ok: false, error: 'stale_attempt' });
  });

  it('rolls back source state when enqueue fails', async () => {
    const sourceId = await seedFailedSource();
    const attemptId = await seedAttempt(sourceId, { stage: 'parse', attempt: 1 });

    await expect(
      retrySourcePipelineStage(ctx(), { attemptId }, async () => {
        throw new Error('queue unavailable');
      }),
    ).rejects.toThrow(/queue unavailable/);

    const [source] = await client.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(source?.status).toBe('failed');
  });

  it('clears partial vectors before an embed retry when the configured model changed', async () => {
    const sourceId = await seedFailedSource();
    const attemptId = await seedAttempt(sourceId, {
      stage: 'embed',
      attempt: 1,
      model: 'old-embedding-model',
    });

    const [rec] = await client.db
      .insert(recommendations)
      .values({
        sourceId,
        slug: `retry-rec-${randomUUID().slice(0, 8)}`,
        title: 'A recommendation',
        body: 'Body long enough for a realistic recommendation.',
      })
      .returning({ id: recommendations.id });
    const [page] = await client.db
      .insert(sourcePages)
      .values({
        sourceId,
        pageNumber: 1,
        markdown: 'A page with enough text to embed.',
      })
      .returning({ id: sourcePages.id });
    if (!rec || !page) throw new Error('seed embed rows failed');

    const zeroVector = `[${new Array(768).fill(0).join(',')}]`;
    await client.sql`
      update recommendations
      set embedding = ${zeroVector}::vector, embedding_model = 'old-embedding-model'
      where id = ${rec.id}
    `;
    await client.sql`
      update source_pages
      set embedding = ${zeroVector}::vector, embedding_model = 'old-embedding-model'
      where id = ${page.id}
    `;

    const result = await retrySourcePipelineStage(
      ctx(),
      { attemptId, currentEmbeddingModel: 'new-embedding-model' },
      async () => 'job-embed',
    );
    expect(result).toMatchObject({ ok: true, resetEmbeddings: true });

    const [recAfter] = await client.db
      .select({ embedding: recommendations.embedding })
      .from(recommendations)
      .where(and(eq(recommendations.sourceId, sourceId), isNull(recommendations.embedding)));
    const [pageAfter] = await client.db
      .select({ embedding: sourcePages.embedding })
      .from(sourcePages)
      .where(and(eq(sourcePages.sourceId, sourceId), isNull(sourcePages.embedding)));
    expect(recAfter?.embedding).toBeNull();
    expect(pageAfter?.embedding).toBeNull();
  });
});
