import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '@/lib/db/client';
import { sources } from '@/lib/db/schema';
import { applyMigrations } from '../../../tests/helpers/migrate';
import { startPostgres, type StartedPg } from '../../../tests/helpers/pg-container';
import type { RepoContext } from './types';
import {
  failSourcePipelineAttempt,
  listSourcePipelineAttempts,
  startSourcePipelineAttempt,
  succeedSourcePipelineAttempt,
} from './source-pipeline-attempt';

let pg: StartedPg;
let client: DbClient;

function systemCtx(): RepoContext {
  return {
    db: client.db,
    auth: { user: { id: 'system' }, roles: ['admin'], isSystem: true },
  };
}

async function seedSource(): Promise<string> {
  const [row] = await client.db
    .insert(sources)
    .values({
      slug: `pipeline-attempt-${randomUUID().slice(0, 8)}`,
      title: 'Pipeline attempt test',
    })
    .returning({ id: sources.id });
  if (!row) throw new Error('seed source returned no row');
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

describe('source pipeline attempts', () => {
  it('allocates concurrent attempt numbers without collisions', async () => {
    const sourceId = await seedSource();

    const [first, second] = await Promise.all([
      startSourcePipelineAttempt(client.db, {
        sourceId,
        stage: 'extract',
        provider: 'fake',
        model: 'fixture-model',
      }),
      startSourcePipelineAttempt(client.db, {
        sourceId,
        stage: 'extract',
        provider: 'fake',
        model: 'fixture-model',
      }),
    ]);

    expect([first.attempt, second.attempt].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('persists success/failure detail and classifies retry safety', async () => {
    const sourceId = await seedSource();

    const parse = await startSourcePipelineAttempt(client.db, {
      sourceId,
      stage: 'parse',
      provider: 'tesseract-pdf',
    });
    await succeedSourcePipelineAttempt(client.db, parse, {
      pageCount: 12,
      ocrFallbackUsed: true,
    });

    const extract = await startSourcePipelineAttempt(client.db, {
      sourceId,
      stage: 'extract',
      provider: 'openai-compat',
      model: 'local-model',
    });
    await failSourcePipelineAttempt(
      client.db,
      extract,
      new Error('openai-compat structured: response failed schema validation'),
    );

    const rows = await listSourcePipelineAttempts(systemCtx(), sourceId);
    expect(rows).toHaveLength(2);

    const parseRow = rows.find((row) => row.stage === 'parse');
    expect(parseRow).toMatchObject({
      attempt: 1,
      status: 'succeeded',
      provider: 'tesseract-pdf',
      retrySafe: false,
    });
    expect(parseRow?.durationMs).toBeTypeOf('number');
    expect(parseRow?.metadata).toMatchObject({ pageCount: 12, ocrFallbackUsed: true });

    const extractRow = rows.find((row) => row.stage === 'extract');
    expect(extractRow).toMatchObject({
      attempt: 1,
      status: 'failed',
      provider: 'openai-compat',
      model: 'local-model',
      errorCategory: 'invalid_structured_output',
      retrySafe: true,
    });
    expect(extractRow?.errorMessage).toMatch(/schema validation/);
  });
});
