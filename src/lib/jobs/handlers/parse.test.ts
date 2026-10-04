import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPostgres, type StartedPg } from '../../../../tests/helpers/pg-container';
import { applyMigrations } from '../../../../tests/helpers/migrate';
import { createDb, type DbClient } from '@/lib/db/client';
import { loadEnv, type Env } from '@/lib/env';
import { createQueue, type Queue } from '@/lib/jobs/queue';
import { emitJobEvent, subscribeJobEvents } from '@/lib/jobs/events';
import { createProviders, type Providers } from '@/lib/providers';
import type { JobContext, JobEvent } from '@/lib/jobs/context';
import { sourceFiles, sourcePages, sources } from '@/lib/db/schema';
import type { OcrProvider, ParsedDocument } from '@/lib/providers/ocr/types';
import { parseHandler } from './parse';

let pg: StartedPg;
let queue: Queue;
let dbClient: DbClient;
let env: Env;
let baseProviders: Providers;

const fixtureDir = path.resolve(process.cwd(), 'fixtures/sources');
const fixtureFile = 'sample-report.pdf';

async function seedSource(opts: { filename: string }): Promise<{ sourceId: string; storageKey: string; bytes: Buffer }> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const [srow] = await dbClient.db
    .insert(sources)
    .values({ slug, title: opts.filename })
    .returning({ id: sources.id });
  if (!srow) throw new Error('seed: no source row');
  const sourceId = srow.id;

  // Load the fixture PDF so the storage fake has something realistic to
  // return (the fake OCR only uses filename, but we keep the shape honest).
  const bytes = await readFile(path.join(fixtureDir, opts.filename));
  const storageKey = `sources/${sourceId}/${opts.filename}`;
  await baseProviders.storage.put(storageKey, bytes, { contentType: 'application/pdf' });
  await dbClient.db.insert(sourceFiles).values({
    sourceId,
    role: 'original',
    storageKey,
    mimeType: 'application/pdf',
    bytes: bytes.length,
  });
  return { sourceId, storageKey, bytes };
}

function ctxWithProviders(providers: Providers): JobContext {
  return {
    queue,
    db: dbClient.db,
    providers,
    env,
    // Real emit via pg_notify so failure-path tests can subscribe.
    emit: (channelId, event) => emitJobEvent(dbClient.sql, channelId, event),
  };
}

describe('source.parse handler', () => {
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
    // The fake OCR reads FIXTURES_DIR at call time; point it at our fixtures.
    process.env.FIXTURES_DIR = fixtureDir;
    baseProviders = createProviders(env);
  }, 120_000);

  afterAll(async () => {
    await queue?.stop();
    await dbClient?.sql.end({ timeout: 5 });
    await pg?.container.stop();
  });

  it('happy path: writes pages, sets status=extracting, enqueues source.extract', async () => {
    const { sourceId } = await seedSource({ filename: fixtureFile });
    const ctx = ctxWithProviders(baseProviders);

    await parseHandler(ctx, { sourceId });

    const [updated] = await dbClient.db
      .select({ status: sources.status, canonical: sources.canonicalMarkdown })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(updated?.status).toBe('extracting');
    expect(updated?.canonical).toBeTruthy();

    const pages = await dbClient.db
      .select({ pn: sourcePages.pageNumber, md: sourcePages.markdown })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));
    expect(pages.length).toBeGreaterThan(0);
    // Page numbers should be 1-based and complete.
    const numbers = pages.map((p) => p.pn).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers.at(-1)).toBe(pages.length);

    // Confirm `source.extract` was enqueued for this sourceId.
    const rows = await queue.rawQuery(
      `select data from pgboss.job where name = 'source.extract' and data->>'sourceId' = '${sourceId}'`,
    );
    expect(rows.length).toBe(1);
  }, 60_000);

  it('failure path: OCR throws -> status=failed, error event emitted, no extract enqueued', async () => {
    const { sourceId } = await seedSource({ filename: fixtureFile });

    const failingOcr: OcrProvider = {
      name: 'failing-fake',
      async parseDocument(): Promise<ParsedDocument> {
        throw new Error('simulated OCR failure');
      },
    };
    const ctx = ctxWithProviders({ ...baseProviders, parser: failingOcr, ocr: failingOcr });

    // Subscribe BEFORE running so we don't race the NOTIFY. Use a dedicated
    // postgres client — subscribeJobEvents issues LISTEN, which pins the
    // connection to that subscription.
    const events: JobEvent[] = [];
    const subDb = createDb(pg.url);
    const unsub = await subscribeJobEvents(subDb.sql, sourceId, (e) => {
      events.push(e);
    });

    await expect(parseHandler(ctx, { sourceId })).rejects.toThrow(/simulated OCR failure/);

    // Give the NOTIFY a beat to arrive.
    await new Promise((r) => setTimeout(r, 250));
    await unsub();
    await subDb.sql.end({ timeout: 5 });

    const [row] = await dbClient.db
      .select({ status: sources.status })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.status).toBe('failed');

    expect(events.some((e) => e.type === 'error' && /simulated OCR failure/.test(e.message))).toBe(true);

    const pagesAfter = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));
    expect(pagesAfter.length).toBe(0);

    const extractRows = await queue.rawQuery(
      `select id from pgboss.job where name = 'source.extract' and data->>'sourceId' = '${sourceId}'`,
    );
    expect(extractRows.length).toBe(0);
  }, 60_000);

  it('idempotent: running the handler twice does not accumulate duplicate page rows', async () => {
    const { sourceId } = await seedSource({ filename: fixtureFile });
    const ctx = ctxWithProviders(baseProviders);

    await parseHandler(ctx, { sourceId });
    const firstPages = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));
    const firstCount = firstPages.length;
    expect(firstCount).toBeGreaterThan(0);

    await parseHandler(ctx, { sourceId });
    const secondPages = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));
    expect(secondPages.length).toBe(firstCount);
  }, 60_000);

it('empty pages: OCR returns zero pages -> succeeds, no page rows, still enqueues extract', async () => {
    const { sourceId } = await seedSource({ filename: fixtureFile });

    const emptyOcr: OcrProvider = {
      name: 'empty-fake',
      async parseDocument(): Promise<ParsedDocument> {
        return { markdown: '', pages: [], metadata: {} };
      },
    };
    const ctx = ctxWithProviders({ ...baseProviders, parser: emptyOcr, ocr: emptyOcr });

    await parseHandler(ctx, { sourceId });

    const [row] = await dbClient.db
      .select({ status: sources.status, canonical: sources.canonicalMarkdown })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.status).toBe('extracting');
    expect(row?.canonical).toBe('');

    const pages = await dbClient.db
      .select({ id: sourcePages.id })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));
    expect(pages.length).toBe(0);

    const extractRows = await queue.rawQuery(
      `select id from pgboss.job where name = 'source.extract' and data->>'sourceId' = '${sourceId}'`,
    );
    expect(extractRows.length).toBe(1);
  }, 60_000);
});
