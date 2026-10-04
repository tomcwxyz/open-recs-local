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
import { emitJobEvent } from '@/lib/jobs/events';
import { createProviders, type Providers } from '@/lib/providers';
import type { JobContext } from '@/lib/jobs/context';
import {
  recommendations,
  recommendationStatuses,
  recommendationsLocationScopes,
  recommendationsPurposes,
  recommendationsTargetAudienceTypes,
  recommendationsThematicAreas,
  sourceFiles,
  sourcePipelineAttempts,
  sources,
  sourcesPurposes,
  sourcesRoleRelevances,
  sourcesSourceTypes,
  sourcesTargetAudienceTypes,
  sourcesThematicAreas,
  thematicAreas,
} from '@/lib/db/schema';
import type { LlmProvider, LlmStructuredInput, LlmStructuredOutput } from '@/lib/providers/llm/types';
import { seedTaxonomy } from '@/lib/db/seed-taxonomy';
import { extractHandler } from './extract';

let pg: StartedPg;
let queue: Queue;
let dbClient: DbClient;
let env: Env;
let baseProviders: Providers;

const fixtureDir = path.resolve(process.cwd(), 'fixtures/sources');
const fixtureStem = 'sample-report';

async function loadFixtureMetadata(): Promise<{ thematic_area_slugs: string[]; target_audience_type_slugs: string[] }> {
  const raw = await readFile(path.join(fixtureDir, `${fixtureStem}.metadata.json`), 'utf8');
  return JSON.parse(raw);
}

async function loadFixtureRecs(): Promise<Array<{ title: string; body: string; thematic_area_slugs: string[] }>> {
  const raw = await readFile(path.join(fixtureDir, `${fixtureStem}.recommendations.json`), 'utf8');
  return JSON.parse(raw).recommendations;
}

async function seedSource(opts: { filename: string; canonical?: string }): Promise<{ sourceId: string }> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const [srow] = await dbClient.db
    .insert(sources)
    .values({ slug, title: opts.filename, canonicalMarkdown: opts.canonical ?? null })
    .returning({ id: sources.id });
  if (!srow) throw new Error('seed: source returned no row');
  await dbClient.db.insert(sourceFiles).values({
    sourceId: srow.id,
    role: 'original',
    storageKey: `sources/${srow.id}/${opts.filename}`,
    mimeType: 'application/pdf',
    bytes: 1,
  });
  return { sourceId: srow.id };
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

beforeAll(async () => {
  pg = await startPostgres();
  await applyMigrations(pg.url).then(({ sql }) => sql.end());
  dbClient = createDb(pg.url);
  await seedTaxonomy(dbClient.db);
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
}, 180_000);

afterAll(async () => {
  await queue?.stop();
  await dbClient?.sql.end({ timeout: 5 });
  await pg?.container.stop();
});

describe('extractHandler — Pass 1 (source metadata)', () => {
  it('persists summary, authors, publication_date, org_owner from the metadata fixture', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One\n\nText.' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const [row] = await dbClient.db
      .select({
        summary: sources.summary,
        authors: sources.authors,
        publicationDate: sources.publicationDate,
        orgOwner: sources.orgOwner,
      })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row?.summary).toMatch(/Annual governance/i);
    expect(row?.authors).toEqual(['Sample Risk Committee']);
    expect(row?.orgOwner).toBe('Sample Charity Limited');
    expect(row?.publicationDate).toBeInstanceOf(Date);

    const [attempt] = await dbClient.db
      .select()
      .from(sourcePipelineAttempts)
      .where(eq(sourcePipelineAttempts.sourceId, sourceId));
    expect(attempt).toMatchObject({
      stage: 'extract',
      attempt: 1,
      status: 'succeeded',
      provider: 'fake',
    });
  });

  it('persists source-side multi-axis M2M memberships from the metadata fixture', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const meta = await loadFixtureMetadata();

    const themes = await dbClient.db
      .select()
      .from(sourcesThematicAreas)
      .where(eq(sourcesThematicAreas.sourceId, sourceId));
    expect(themes).toHaveLength(meta.thematic_area_slugs.length);

    const types = await dbClient.db
      .select()
      .from(sourcesSourceTypes)
      .where(eq(sourcesSourceTypes.sourceId, sourceId));
    expect(types).toHaveLength(1);

    const purposes = await dbClient.db
      .select()
      .from(sourcesPurposes)
      .where(eq(sourcesPurposes.sourceId, sourceId));
    expect(purposes).toHaveLength(2);

    const roles = await dbClient.db
      .select()
      .from(sourcesRoleRelevances)
      .where(eq(sourcesRoleRelevances.sourceId, sourceId));
    expect(roles).toHaveLength(2);

    const audiences = await dbClient.db
      .select()
      .from(sourcesTargetAudienceTypes)
      .where(eq(sourcesTargetAudienceTypes.sourceId, sourceId));
    expect(audiences).toHaveLength(meta.target_audience_type_slugs.length);
  });
});

describe('extractHandler — Pass 2 (recommendations)', () => {
  it('inserts every recommendation from the fixture with the expected columns', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const fixtureRecs = await loadFixtureRecs();

    const recRows = await dbClient.db
      .select({
        title: recommendations.title,
        body: recommendations.body,
        confidence: recommendations.confidence,
        priorityTimescaleId: recommendations.priorityTimescaleId,
        targetOrganization: recommendations.targetOrganization,
      })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));
    expect(recRows).toHaveLength(fixtureRecs.length);
    expect(recRows.map((r) => r.title).sort()).toEqual(fixtureRecs.map((f) => f.title).sort());

    for (const row of recRows) {
      expect(row.confidence).toMatch(/^(high|medium|low)$/);
      expect(row.priorityTimescaleId).toBeTruthy();
    }
  });

  it('seeds an initial open status per recommendation', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const fixtureRecs = await loadFixtureRecs();

    const recIds = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));

    for (const { id } of recIds) {
      const statusRows = await dbClient.db
        .select({ status: recommendationStatuses.status })
        .from(recommendationStatuses)
        .where(eq(recommendationStatuses.recommendationId, id));
      expect(statusRows.map((s) => s.status)).toEqual(['open']);
    }
    expect(recIds).toHaveLength(fixtureRecs.length);
  });

  it('persists rec-side multi-axis M2M memberships', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });

    const recIds = (
      await dbClient.db
        .select({ id: recommendations.id })
        .from(recommendations)
        .where(eq(recommendations.sourceId, sourceId))
    ).map((r) => r.id);

    // Every fixture rec has at least one theme, one purpose, one audience,
    // one location. Spot-check that at least one rec has memberships in
    // each of the four M2M tables.
    for (const id of recIds) {
      const themes = await dbClient.db
        .select()
        .from(recommendationsThematicAreas)
        .where(eq(recommendationsThematicAreas.recommendationId, id));
      expect(themes.length).toBeGreaterThan(0);
      const purposes = await dbClient.db
        .select()
        .from(recommendationsPurposes)
        .where(eq(recommendationsPurposes.recommendationId, id));
      expect(purposes.length).toBeGreaterThan(0);
      const audiences = await dbClient.db
        .select()
        .from(recommendationsTargetAudienceTypes)
        .where(eq(recommendationsTargetAudienceTypes.recommendationId, id));
      expect(audiences.length).toBeGreaterThan(0);
      const locations = await dbClient.db
        .select()
        .from(recommendationsLocationScopes)
        .where(eq(recommendationsLocationScopes.recommendationId, id));
      expect(locations.length).toBeGreaterThan(0);
    }
  });
});

describe('extractHandler — unknown slugs', () => {
  it('auto-creates unknown taxonomy slugs as unverified=true', async () => {
    // Override fake LLM with a custom response that includes an unknown slug
    // on both Pass 1 and Pass 2.
    const customLlm: LlmProvider = {
      name: 'fake-with-unknown',
      async generateText() {
        return { text: '' };
      },
      async generateStructured<T>(input: LlmStructuredInput<T>): Promise<LlmStructuredOutput<T>> {
        if (input.key?.endsWith(':metadata')) {
          return {
            value: input.schema.parse({
              summary: 'Test',
              authors: ['Author'],
              publication_date: null,
              org_owner: null,
              thematic_area_slugs: ['quantum-ethics'],
              source_type_slugs: [],
              purpose_slugs: [],
              role_relevance_slugs: [],
              target_audience_type_slugs: [],
            }),
          } as LlmStructuredOutput<T>;
        }
        return {
          value: input.schema.parse({
            recommendations: [
              {
                title: 'Made-up rec for unknown slug test',
                body: 'This rec uses both a known slug (governance) and an unknown one.',
                thematic_area_slugs: ['governance', 'newly-coined-area'],
                purpose_slugs: [],
                target_audience_type_slugs: [],
                location_scope_slugs: [],
                priority_timescale_slug: null,
                target_organization: null,
                notes: null,
                confidence: 'medium',
                page_start: null,
                page_end: null,
              },
            ],
          }),
        } as LlmStructuredOutput<T>;
      },
    };
    const providers: Providers = { ...baseProviders, llm: customLlm };
    const { sourceId } = await seedSource({ filename: 'unknown-slug-test.pdf', canonical: '# X' });
    await extractHandler(ctxWithProviders(providers), { sourceId });

    const [quantum] = await dbClient.db
      .select({ unverified: thematicAreas.unverified })
      .from(thematicAreas)
      .where(eq(thematicAreas.slug, 'quantum-ethics'));
    expect(quantum?.unverified).toBe(true);

    const [coined] = await dbClient.db
      .select({ unverified: thematicAreas.unverified })
      .from(thematicAreas)
      .where(eq(thematicAreas.slug, 'newly-coined-area'));
    expect(coined?.unverified).toBe(true);
  });
});

describe('extractHandler — duplicate rec titles', () => {
  it('gives each recommendation its own taxonomy tags even when two recs share a title', async () => {
    // Two recs with an identical title but distinct thematic areas. The
    // per-rec tag mapping must key on rec identity, not title — otherwise the
    // second rec overwrites the first and both end up with the same tags.
    const customLlm: LlmProvider = {
      name: 'fake-dup-titles',
      async generateText() {
        return { text: '' };
      },
      async generateStructured<T>(input: LlmStructuredInput<T>): Promise<LlmStructuredOutput<T>> {
        if (input.key?.endsWith(':metadata')) {
          return {
            value: input.schema.parse({
              summary: 'Test',
              authors: [],
              publication_date: null,
              org_owner: null,
              thematic_area_slugs: [],
              source_type_slugs: [],
              purpose_slugs: [],
              role_relevance_slugs: [],
              target_audience_type_slugs: [],
            }),
          } as LlmStructuredOutput<T>;
        }
        const makeRec = (body: string, themeSlug: string) => ({
          title: 'Increase funding',
          body,
          thematic_area_slugs: [themeSlug],
          purpose_slugs: [],
          target_audience_type_slugs: [],
          location_scope_slugs: [],
          priority_timescale_slug: null,
          target_organization: null,
          notes: null,
          confidence: 'medium' as const,
          page_start: null,
          page_end: null,
        });
        return {
          value: input.schema.parse({
            recommendations: [
              makeRec('First rec body, with at least twenty characters of text.', 'dup-theme-alpha'),
              makeRec('Second rec body, with at least twenty characters of text.', 'dup-theme-beta'),
            ],
          }),
        } as LlmStructuredOutput<T>;
      },
    };
    const providers: Providers = { ...baseProviders, llm: customLlm };
    const { sourceId } = await seedSource({ filename: 'dup-title-test.pdf', canonical: '# X' });
    await extractHandler(ctxWithProviders(providers), { sourceId });

    const recRows = await dbClient.db
      .select({ id: recommendations.id, slug: recommendations.slug })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId))
      .orderBy(recommendations.slug);
    expect(recRows).toHaveLength(2);

    const themeSlugsFor = async (recId: string): Promise<string[]> => {
      const rows = await dbClient.db
        .select({ slug: thematicAreas.slug })
        .from(recommendationsThematicAreas)
        .innerJoin(thematicAreas, eq(thematicAreas.id, recommendationsThematicAreas.thematicAreaId))
        .where(eq(recommendationsThematicAreas.recommendationId, recId));
      return rows.map((r) => r.slug).sort();
    };

    // slug suffix `-0` / `-1` makes the ordering deterministic.
    expect(await themeSlugsFor(recRows[0]!.id)).toEqual(['dup-theme-alpha']);
    expect(await themeSlugsFor(recRows[1]!.id)).toEqual(['dup-theme-beta']);
  });
});

describe('extractHandler — idempotency', () => {
  it('re-runs are safe: delete-then-insert means rec count stays stable across retries', async () => {
    const { sourceId } = await seedSource({ filename: `${fixtureStem}.pdf`, canonical: '# Page One' });
    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const firstCount = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));

    await extractHandler(ctxWithProviders(baseProviders), { sourceId });
    const secondCount = await dbClient.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(eq(recommendations.sourceId, sourceId));
    expect(secondCount.length).toBe(firstCount.length);
  });
});

describe('extractHandler — failure path', () => {
  it('flips sources.status to failed when the LLM call throws', async () => {
    const brokenLlm: LlmProvider = {
      name: 'broken',
      async generateText() {
        return { text: '' };
      },
      async generateStructured<T>(): Promise<LlmStructuredOutput<T>> {
        throw new Error('synthetic LLM failure');
      },
    };
    const providers: Providers = { ...baseProviders, llm: brokenLlm };
    const { sourceId } = await seedSource({ filename: 'fail.pdf', canonical: '# X' });
    await expect(extractHandler(ctxWithProviders(providers), { sourceId })).rejects.toThrow(
      /synthetic LLM failure/,
    );
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
      stage: 'extract',
      status: 'failed',
      provider: 'broken',
      errorCategory: 'unknown',
      retrySafe: false,
    });
  });
});
