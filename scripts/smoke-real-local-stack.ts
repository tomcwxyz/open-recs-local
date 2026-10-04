import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '../tests/helpers/migrate';
import { startPostgres } from '../tests/helpers/pg-container';
import { createDb } from '@/lib/db/client';
import { seedTaxonomy } from '@/lib/db/seed-taxonomy';
import { recommendations, sourceFiles, sourcePages, sources } from '@/lib/db/schema';
import { loadEnv } from '@/lib/env';
import type { JobContext } from '@/lib/jobs/context';
import type { Queue } from '@/lib/jobs/queue';
import { embedHandler } from '@/lib/jobs/handlers/embed';
import { extractHandler } from '@/lib/jobs/handlers/extract';
import { parseHandler } from '@/lib/jobs/handlers/parse';
import { createProviders } from '@/lib/providers';
import type { RepoContext } from '@/lib/repositories/types';
import { uploadSource } from '@/lib/services/upload-source';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function recordingQueue(): Queue {
  let sequence = 0;
  return {
    enqueue: async () => {
      sequence += 1;
      return 'smoke-job-' + sequence;
    },
    register: async () => undefined,
    schedule: async () => undefined,
    waitForResult: async () => {
      throw new Error('waitForResult is not used by the real local stack smoke');
    },
    rawQuery: async () => [],
    stop: async () => undefined,
  } as Queue;
}

async function main(): Promise<void> {
  const pdfPath = path.resolve(
    valueAfter('--pdf') ??
      process.env.REAL_STACK_PDF ??
      'fixtures/sources/sample-report.pdf',
  );
  const minRecommendations = Number(valueAfter('--min-recommendations') ?? '1');
  const storageDir = await mkdtemp(path.join(tmpdir(), 'open-recs-real-stack-'));
  const pg = await startPostgres();

  const sourceEnv: Record<string, string | undefined> = {
    ...process.env,
    APP_MODE: 'local',
    DATABASE_URL: pg.url,
    STORAGE_PROVIDER: 'fs',
    STORAGE_FS_PATH: storageDir,
    OCR_PROVIDER:
      valueAfter('--parser') ??
      process.env.OCR_PROVIDER ??
      'tesseract-pdf',
  };

  const model = valueAfter('--model');
  const baseUrl = valueAfter('--base-url');
  if (model) {
    sourceEnv.LLM_PROVIDER = 'openai-compatible';
    sourceEnv.LLM_MODEL = model;
  }
  if (baseUrl) sourceEnv.LLM_BASE_URL = baseUrl;

  const embeddingModel = valueAfter('--embedding-model');
  const embeddingBaseUrl = valueAfter('--embedding-base-url');
  if (embeddingModel) {
    sourceEnv.EMBEDDING_PROVIDER = 'openai-compatible';
    sourceEnv.EMBEDDING_MODEL = embeddingModel;
  }
  if (embeddingBaseUrl) sourceEnv.EMBEDDING_BASE_URL = embeddingBaseUrl;
  if (embeddingModel && !sourceEnv.EMBEDDING_BASE_URL && sourceEnv.LLM_BASE_URL) {
    sourceEnv.EMBEDDING_BASE_URL = sourceEnv.LLM_BASE_URL;
  }

  const env = loadEnv(sourceEnv);
  if (env.LLM_PROVIDER === 'fake') throw new Error('real stack smoke refuses LLM_PROVIDER=fake');
  if (env.EMBEDDING_PROVIDER === 'fake') {
    throw new Error('real stack smoke refuses EMBEDDING_PROVIDER=fake');
  }
  if (env.OCR_PROVIDER === 'fake') throw new Error('real stack smoke refuses OCR_PROVIDER=fake');

  await applyMigrations(pg.url).then(({ sql }) => sql.end());
  const client = createDb(pg.url);
  const providers = createProviders(env);
  const queue = recordingQueue();
  let sourceId: string | null = null;

  try {
    await seedTaxonomy(client.db);

    const bytes = await readFile(pdfPath);
    const repoCtx: RepoContext = {
      db: client.db,
      auth: { user: { id: 'system', name: 'system' }, roles: ['admin'], isSystem: true },
    };

    const uploaded = await uploadSource(
      repoCtx,
      {
        filename: path.basename(pdfPath),
        contentType: 'application/pdf',
        bytes,
        title: 'Real local stack smoke',
      },
      { storage: providers.storage, queue },
    );
    sourceId = uploaded.sourceId;

    const jobCtx: JobContext = {
      db: client.db,
      queue,
      providers,
      env,
      emit: async () => undefined,
    };

    await parseHandler(jobCtx, { sourceId });
    await extractHandler(jobCtx, { sourceId });
    await embedHandler(jobCtx, { sourceId });

    const [source] = await client.db
      .select({
        status: sources.status,
        title: sources.title,
      })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    const recRows = await client.db
      .select({ id: recommendations.id, embedding: recommendations.embedding })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));
    const pageRows = await client.db
      .select({ id: sourcePages.id, embedding: sourcePages.embedding })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId));

    if (source?.status !== 'ready') {
      throw new Error('expected source status ready, got ' + String(source?.status));
    }
    if (recRows.length < minRecommendations) {
      throw new Error(
        'expected at least ' +
          minRecommendations +
          ' recommendation(s), got ' +
          recRows.length,
      );
    }
    if (pageRows.length === 0) throw new Error('real stack smoke produced no source pages');
    if (recRows.some((row) => row.embedding === null)) {
      throw new Error('one or more recommendations were not embedded');
    }
    if (pageRows.some((row) => row.embedding === null)) {
      throw new Error('one or more source pages were not embedded');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          source_id: sourceId,
          status: source.status,
          pages: pageRows.length,
          recommendations: recRows.length,
          parser: providers.parser?.name ?? providers.ocr.name,
          llm: providers.llm.name,
          embedding: {
            provider: providers.embedding.name,
            model: providers.embedding.model,
            dimensions: providers.embedding.dimensions,
          },
          database: 'disposable pgvector/pg16 testcontainer',
          storage: 'disposable fs directory',
        },
        null,
        2,
      ),
    );
  } finally {
    if (sourceId) {
      const fileRows = await client.db
        .select({ storageKey: sourceFiles.storageKey })
        .from(sourceFiles)
        .where(eq(sourceFiles.sourceId, sourceId))
        .catch(() => []);
      for (const file of fileRows) {
        await providers.storage.delete(file.storageKey).catch(() => undefined);
      }
      await client.db.delete(sources).where(eq(sources.id, sourceId)).catch(() => undefined);
    }
    await client.sql.end({ timeout: 5 }).catch(() => undefined);
    await pg.container.stop().catch(() => undefined);
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[smoke:local-stack:real] failed:', error);
  process.exit(1);
});
