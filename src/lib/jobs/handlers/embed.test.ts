import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startPostgres, type StartedPg } from '../../../../tests/helpers/pg-container';
import { applyMigrations } from '../../../../tests/helpers/migrate';
import { createDb, type DbClient } from '@/lib/db/client';
import { loadEnv, type Env } from '@/lib/env';
import { createQueue, type Queue } from '@/lib/jobs/queue';
import { emitJobEvent, subscribeJobEvents } from '@/lib/jobs/events';
import { createProviders, type Providers } from '@/lib/providers';
import type { JobContext, JobEvent } from '@/lib/jobs/context';
import { recommendations, sourcePages, sourcePipelineAttempts, sources } from '@/lib/db/schema';
import { createFakeEmbedding } from '@/lib/providers/embedding/fake';
import type { EmbeddingProvider } from '@/lib/providers/embedding/types';
import { embedHandler } from './embed';

let pg: StartedPg;
let queue: Queue;
let dbClient: DbClient;
let env: Env;
let baseProviders: Providers;

/**
 * Wrap an EmbeddingProvider with a spy that records every batch of texts it
 * was called with. Thin — delegates straight to the inner provider so the
 * returned vectors are still the real fake hash output.
 */
function spyEmbedding(inner: EmbeddingProvider): {
  provider: EmbeddingProvider;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    provider: {
      name: inner.name,
      model: inner.model,
      dimensions: inner.dimensions,
      async embed(texts: string[]): Promise<number[][]> {
        calls.push([...texts]);
        return inner.embed(texts);
      },
    },
  };
}

async function seedSource(): Promise<{ sourceId: string }> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const [srow] = await dbClient.db
    .insert(sources)
    .values({ slug, title: 'embed-test', status: 'embedding' })
    .returning({ id: sources.id });
  if (!srow) throw new Error('seed: no source row');
  return { sourceId: srow.id };
}

async function seedPages(sourceId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [row] = await dbClient.db
      .insert(sourcePages)
      .values({
        sourceId,
        pageNumber: i + 1,
        markdown: `Page ${i + 1} markdown content — meaningful prose about topic ${i}.`,
      })
      .returning({ id: sourcePages.id });
    if (!row) throw new Error('seed: no page row');
    ids.push(row.id);
  }
  return ids;
}

async function seedRecs(sourceId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [row] = await dbClient.db
      .insert(recommendations)
      .values({
        sourceId,
        slug: `rec-${sourceId.slice(0, 8)}-${i}-${randomUUID().slice(0, 6)}`,
        title: `Rec ${i} title`,
        body: `Rec ${i} body — long enough to be a realistic piece of text for embedding.`,
      })
      .returning({ id: recommendations.id });
    if (!row) throw new Error('seed: no rec row');
    ids.push(row.id);
  }
  return ids;
}

/**
 * A DbClient that counts every `UPDATE` statement sent to Postgres, via
 * postgres-js's `debug` hook. Lets a test assert that bulk writes collapse
 * N per-row updates into a single statement, rather than asserting an
 * implementation detail like which Drizzle method was called.
 */
function countingDb(url: string): { client: DbClient; updateCount: () => number } {
  let updates = 0;
  const sql = postgres(url, {
    max: 5,
    prepare: false,
    debug: (_conn, query) => {
      if (/^\s*update\b/i.test(query)) updates += 1;
    },
  });
  return { client: { db: drizzle(sql), sql }, updateCount: () => updates };
}

function ctxWithProviders(providers: Providers): JobContext {
  return {
    queue,
    db: dbClient.db,
    providers,
    env,
    emit: (channelId, event) => emitJobEvent(dbClient.sql, channelId, event),
  };
}

describe('source.embed handler', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    await applyMigrations(pg.url).then(({ sql }) => sql.end());
    dbClient = createDb(pg.url);
    queue = await createQueue({ connectionString: pg.url });
    env = loadEnv({
      APP_MODE: 'local',
      DATABASE_URL: pg.url,
      LLM_PROVIDER: 'fake',
      EMBEDDING_PROVIDER: 'fake',
      OCR_PROVIDER: 'fake',
      STORAGE_PROVIDER: 'fake',
    });
    baseProviders = createProviders(env);
  }, 120_000);

  afterAll(async () => {
    await queue?.stop();
    await dbClient?.sql.end({ timeout: 5 });
    await pg?.container.stop();
  });

  it('happy path: embeds all recs AND source pages to 768-dim vectors, source.status=ready, phase=ready event', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 3);
    await seedPages(sourceId, 2);

    const events: JobEvent[] = [];
    const subDb = createDb(pg.url);
    const unsub = await subscribeJobEvents(subDb.sql, sourceId, (e) => {
      events.push(e);
    });

    const ctx = ctxWithProviders(baseProviders);
    await embedHandler(ctx, { sourceId });

    await new Promise((r) => setTimeout(r, 250));
    await unsub();
    await subDb.sql.end({ timeout: 5 });

    // Pull embeddings via raw SQL: we want array_length to assert the
    // on-disk vector dim, not just that `embedding IS NOT NULL`.
    const recRows = await dbClient.sql<
      { id: string; dim: number }[]
    >`select id, array_length(embedding::real[], 1) as dim
      from recommendations where source_id = ${sourceId}`;
    expect(recRows.length).toBe(3);
    for (const r of recRows) {
      expect(r.dim).toBe(768);
    }

    const pageRows = await dbClient.sql<
      { id: string; dim: number }[]
    >`select id, array_length(embedding::real[], 1) as dim
      from source_pages where source_id = ${sourceId}`;
    expect(pageRows.length).toBe(2);
    for (const r of pageRows) {
      expect(r.dim).toBe(768);
    }

    const [sourceRow] = await dbClient.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(sourceRow?.status).toBe('ready');

    const [attempt] = await dbClient.db
      .select()
      .from(sourcePipelineAttempts)
      .where(eq(sourcePipelineAttempts.sourceId, sourceId));
    expect(attempt).toMatchObject({
      stage: 'embed',
      attempt: 1,
      status: 'succeeded',
      provider: 'fake',
      model: 'fake-embedding-v0',
    });

    expect(events.some((e) => e.type === 'phase' && e.phase === 'embedding')).toBe(true);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'ready')).toBe(true);
  }, 60_000);

  it('idempotent: recs already embedded are skipped on retry', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 5);

    // First run embeds everything.
    const spy1 = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy1.provider }), {
      sourceId,
    });
    const totalFirst = spy1.calls.flat().length;
    expect(totalFirst).toBe(5);

    // Second run: nothing NULL left, so no provider calls.
    const spy2 = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy2.provider }), {
      sourceId,
    });
    expect(spy2.calls).toHaveLength(0);

    // Total rec count unchanged.
    const all = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));
    expect(all).toHaveLength(5);
  }, 60_000);

  it('partial-resume: only NULL-embedding recs are sent to the provider', async () => {
    const { sourceId } = await seedSource();
    const recIds = await seedRecs(sourceId, 4);

    // Pre-embed the first two rows to simulate a partial previous run. Use
    // raw sql to write a 768-dim zero vector — its contents don't matter,
    // only that embedding IS NOT NULL.
    const zeroVec = `[${new Array(768).fill(0).join(',')}]`;
    for (const id of recIds.slice(0, 2)) {
      await dbClient.sql`update recommendations set embedding = ${zeroVec}::vector where id = ${id}`;
    }

    const spy = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy.provider }), {
      sourceId,
    });

    // Only the two unembedded recs were sent.
    const totalEmbedded = spy.calls.flat().length;
    expect(totalEmbedded).toBe(2);

    const allForSource = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));
    const embeddedForSource = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.sourceId, sourceId), isNotNull(recommendations.embedding)));
    expect(allForSource).toHaveLength(4);
    expect(embeddedForSource).toHaveLength(4);
  }, 60_000);

  it('source_pages: re-running on a source with embedded pages skips them (idempotent)', async () => {
    const { sourceId } = await seedSource();
    await seedPages(sourceId, 4);

    const spy1 = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy1.provider }), {
      sourceId,
    });
    expect(spy1.calls.flat().length).toBe(4);

    const spy2 = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy2.provider }), {
      sourceId,
    });
    expect(spy2.calls).toHaveLength(0);

    const embedded = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(and(eq(sourcePages.sourceId, sourceId), isNotNull(sourcePages.embedding)));
    expect(embedded).toHaveLength(4);
  }, 60_000);

  it('source_pages: partial-resume only re-embeds pages with NULL embedding', async () => {
    const { sourceId } = await seedSource();
    const pageIds = await seedPages(sourceId, 3);

    // Pre-embed page #1 with a 768-dim zero vector to simulate a partial
    // previous run.
    const zeroVec = `[${new Array(768).fill(0).join(',')}]`;
    const firstPageId = pageIds[0];
    if (!firstPageId) throw new Error('seed: no page id');
    await dbClient.sql`update source_pages set embedding = ${zeroVec}::vector where id = ${firstPageId}`;

    const spy = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy.provider }), {
      sourceId,
    });
    expect(spy.calls.flat().length).toBe(2);

    const embedded = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(and(eq(sourcePages.sourceId, sourceId), isNotNull(sourcePages.embedding)));
    expect(embedded).toHaveLength(3);
  }, 60_000);

  it('batching: 70 recs produce 3 provider calls (32 + 32 + 6)', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 70);

    const spy = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy.provider }), {
      sourceId,
    });

    expect(spy.calls.map((c) => c.length)).toEqual([32, 32, 6]);
  }, 60_000);

  it('bulk update: a batch of recs is written in one UPDATE, not one per row', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 10); // 10 <= BATCH_SIZE → a single batch

    const counting = countingDb(pg.url);
    const ctx: JobContext = {
      queue,
      db: counting.client.db,
      providers: baseProviders,
      env,
      emit: (channelId, event) => emitJobEvent(counting.client.sql, channelId, event),
    };
    await embedHandler(ctx, { sourceId });
    await counting.client.sql.end({ timeout: 5 });

    // One bulk UPDATE for the recs + source.status + the durable attempt row.
    // The old per-row loop issued one UPDATE per recommendation.
    expect(counting.updateCount()).toBe(3);

    // And the data is actually written — 768-dim vectors on every row.
    const rows = await dbClient.sql<{ dim: number }[]>`
      select array_length(embedding::real[], 1) as dim
      from recommendations where source_id = ${sourceId}`;
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.dim).toBe(768);
  }, 60_000);

  it('bulk update: a batch of source pages is written in one UPDATE, not one per row', async () => {
    const { sourceId } = await seedSource();
    await seedPages(sourceId, 8);

    const counting = countingDb(pg.url);
    const ctx: JobContext = {
      queue,
      db: counting.client.db,
      providers: baseProviders,
      env,
      emit: (channelId, event) => emitJobEvent(counting.client.sql, channelId, event),
    };
    await embedHandler(ctx, { sourceId });
    await counting.client.sql.end({ timeout: 5 });

    // One bulk UPDATE for pages + source.status + the durable attempt row.
    expect(counting.updateCount()).toBe(3);

    const rows = await dbClient.sql<{ dim: number }[]>`
      select array_length(embedding::real[], 1) as dim
      from source_pages where source_id = ${sourceId}`;
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.dim).toBe(768);
  }, 60_000);

  it('empty case: no recs → status=ready, no provider calls', async () => {
    const { sourceId } = await seedSource();

    const spy = spyEmbedding(createFakeEmbedding());
    await embedHandler(ctxWithProviders({ ...baseProviders, embedding: spy.provider }), {
      sourceId,
    });

    expect(spy.calls).toHaveLength(0);
    const [row] = await dbClient.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.status).toBe('ready');
  }, 60_000);

  it('dim mismatch: provider returns wrong-dim vector → handler throws, status=failed', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 2);

    const badProvider: EmbeddingProvider = {
      name: 'bad',
      model: 'bad',
      dimensions: 768,
      async embed(texts) {
        // Return 10-dim instead of 768.
        return texts.map(() => new Array(10).fill(0));
      },
    };

    const events: JobEvent[] = [];
    const subDb = createDb(pg.url);
    const unsub = await subscribeJobEvents(subDb.sql, sourceId, (e) => {
      events.push(e);
    });

    await expect(
      embedHandler(ctxWithProviders({ ...baseProviders, embedding: badProvider }), { sourceId }),
    ).rejects.toThrow(/expected 768-dim/);

    await new Promise((r) => setTimeout(r, 250));
    await unsub();
    await subDb.sql.end({ timeout: 5 });

    const [row] = await dbClient.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.status).toBe('failed');

    const [attempt] = await dbClient.db
      .select()
      .from(sourcePipelineAttempts)
      .where(eq(sourcePipelineAttempts.sourceId, sourceId));
    expect(attempt).toMatchObject({
      stage: 'embed',
      status: 'failed',
      provider: 'bad',
      model: 'bad',
      errorCategory: 'embedding_dimension',
      retrySafe: false,
    });

    expect(events.some((e) => e.type === 'error' && /expected 768-dim/.test(e.message))).toBe(true);
  }, 60_000);

  it('failure path: provider throws mid-run → status=failed, partial embeddings persist', async () => {
    const { sourceId } = await seedSource();
    await seedRecs(sourceId, 40); // two batches: 32 + 8

    let batch = 0;
    const failingProvider: EmbeddingProvider = {
      name: 'flaky',
      model: 'flaky',
      dimensions: 768,
      async embed(texts) {
        batch += 1;
        if (batch === 2) throw new Error('simulated embed failure');
        return createFakeEmbedding().embed(texts);
      },
    };

    await expect(
      embedHandler(ctxWithProviders({ ...baseProviders, embedding: failingProvider }), {
        sourceId,
      }),
    ).rejects.toThrow(/simulated embed failure/);

    const [row] = await dbClient.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.status).toBe('failed');

    // First batch of 32 should be persisted (per-batch writes, no outer tx).
    const embedded = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.sourceId, sourceId), isNotNull(recommendations.embedding)));
    expect(embedded.length).toBe(32);
  }, 60_000);
});
