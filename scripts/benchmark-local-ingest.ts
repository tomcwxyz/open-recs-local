import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  BenchmarkCorpusManifestSchema,
  aggregateRecommendationScores,
  scoreRecommendations,
  type BenchmarkCorpusEntry,
} from '@/lib/benchmarks/local-ingest';
import { createOpenAICompatEmbedding } from '@/lib/providers/embedding/openai-compat';
import { createOpenAICompatLlm } from '@/lib/providers/llm/openai-compat';
import { createTesseractPdfOcr, hasUsableText } from '@/lib/providers/ocr/tesseract-pdf';
import {
  RecommendationCandidatesSchema,
  RecommendationEnrichmentsSchema,
  SourceMetadataSchema,
  type RecommendationCandidate,
  type RecommendationEnrichment,
  type RecommendationInput,
} from '@/lib/services/extraction-schema';
import { mergeCandidateEnrichments } from '@/lib/services/extraction-enrichment';
import {
  buildPass1Prompt,
  buildRecommendationCandidatePrompt,
  buildRecommendationEnrichmentPrompt,
  type TaxonomySlugLists,
} from '@/lib/services/extraction-prompts';
import {
  applyWindowProvenance,
  buildExtractionWindows,
  dedupeRecommendations,
} from '@/lib/services/extraction-windows';
import {
  LOCATION_SCOPES,
  PRIORITY_TIMESCALES,
  PURPOSES,
  ROLE_RELEVANCES,
  SOURCE_TYPES,
  TARGET_AUDIENCE_TYPES,
  THEMATIC_AREAS,
} from '../seeds/taxonomy';

const execFileAsync = promisify(execFile);
const ENRICHMENT_BATCH_SIZE = 8;
const EMBEDDING_BATCH_SIZE = 32;
const MAX_PASS1_MARKDOWN = 10_000;

type StructuredStats = {
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  errors: string[];
};

type BenchmarkOptions = {
  manifestPath: string;
  models: string[];
  llmBaseUrl: string;
  llmTimeoutMs: number;
  embeddingModel: string | null;
  embeddingBaseUrl: string;
  skipEmbeddings: boolean;
  windowPages?: number;
  windowChars?: number;
  overlapPages?: number;
  matchThreshold: number;
  caseIds: Set<string> | null;
  outputPath: string;
};

const TAXONOMY_SLUGS: TaxonomySlugLists = {
  thematic_area: THEMATIC_AREAS.map((row) => row.slug),
  source_type: SOURCE_TYPES.map((row) => row.slug),
  purpose: PURPOSES.map((row) => row.slug),
  role_relevance: ROLE_RELEVANCES.map((row) => row.slug),
  target_audience_type: TARGET_AUDIENCE_TYPES.map((row) => row.slug),
  location_scope: LOCATION_SCOPES.map((row) => row.slug),
  priority_timescale: PRIORITY_TIMESCALES.map((row) => row.slug),
};

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberAfter(flag: string): number | undefined {
  const raw = valueAfter(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(flag + ' must be numeric');
  return value;
}

function safeFilename(value: string): string {
  return value.toLocaleLowerCase('en-GB').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseOptions(): BenchmarkOptions {
  const manifestPath = path.resolve(
    valueAfter('--manifest') ??
      process.env.BENCHMARK_CORPUS ??
      'benchmarks/local-ingest/corpus.fixture.json',
  );

  const rawModels =
    valueAfter('--models') ??
    valueAfter('--model') ??
    process.env.BENCHMARK_LLM_MODELS ??
    process.env.BENCHMARK_LLM_MODEL ??
    process.env.LLM_MODEL;
  if (!rawModels) {
    throw new Error(
      'Set --models/--model, BENCHMARK_LLM_MODELS, BENCHMARK_LLM_MODEL, or LLM_MODEL.',
    );
  }
  const models = rawModels.split(',').map((value) => value.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('No benchmark models supplied');

  const llmBaseUrl =
    valueAfter('--base-url') ??
    process.env.BENCHMARK_LLM_BASE_URL ??
    process.env.LLM_BASE_URL ??
    'http://localhost:11434/v1';

  const embeddingModel =
    process.argv.includes('--skip-embeddings')
      ? null
      : valueAfter('--embedding-model') ??
        process.env.BENCHMARK_EMBEDDING_MODEL ??
        process.env.EMBEDDING_MODEL ??
        null;
  const skipEmbeddings = process.argv.includes('--skip-embeddings');
  if (!skipEmbeddings && !embeddingModel) {
    throw new Error(
      'Set --embedding-model, BENCHMARK_EMBEDDING_MODEL, EMBEDDING_MODEL, or use --skip-embeddings.',
    );
  }

  const embeddingBaseUrl =
    valueAfter('--embedding-base-url') ??
    process.env.BENCHMARK_EMBEDDING_BASE_URL ??
    process.env.EMBEDDING_BASE_URL ??
    llmBaseUrl;

  const caseRaw = valueAfter('--case');
  const caseIds = caseRaw
    ? new Set(caseRaw.split(',').map((value) => value.trim()).filter(Boolean))
    : null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultName =
    models.length === 1
      ? stamp + '-' + safeFilename(models[0]!) + '.json'
      : stamp + '-model-comparison.json';
  const outputPath = path.resolve(
    valueAfter('--output') ??
      path.join('benchmarks/local-ingest/results', defaultName),
  );

  const windowPages = numberAfter('--window-pages');
  const windowChars = numberAfter('--window-chars');
  const overlapPages = numberAfter('--overlap-pages');

  return {
    manifestPath,
    models,
    llmBaseUrl,
    llmTimeoutMs: numberAfter('--timeout-ms') ?? Number(process.env.LLM_TIMEOUT_MS ?? 120000),
    embeddingModel,
    embeddingBaseUrl,
    skipEmbeddings,
    ...(windowPages !== undefined ? { windowPages } : {}),
    ...(windowChars !== undefined ? { windowChars } : {}),
    ...(overlapPages !== undefined ? { overlapPages } : {}),
    matchThreshold: numberAfter('--match-threshold') ?? 0.46,
    caseIds,
    outputPath,
  };
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort/i.test(name + ' ' + message);
}

async function tracked<T>(
  stats: StructuredStats,
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  stats.calls += 1;
  try {
    const result = await call();
    stats.successes += 1;
    return result;
  } catch (error) {
    stats.failures += 1;
    if (isTimeoutError(error)) stats.timeouts += 1;
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push(label + ': ' + message);
    throw error;
  }
}

async function ollamaRssMb(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'rss=,comm='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    let kb = 0;
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      if (match[2]!.toLocaleLowerCase('en-GB').includes('ollama')) {
        kb += Number(match[1]);
      }
    }
    return kb / 1024;
  } catch {
    return 0;
  }
}

class MemorySampler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  peakHarnessRssMb = 0;
  peakOllamaRssMb = 0;

  private async sample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.peakHarnessRssMb = Math.max(
        this.peakHarnessRssMb,
        process.memoryUsage().rss / 1024 / 1024,
      );
      this.peakOllamaRssMb = Math.max(this.peakOllamaRssMb, await ollamaRssMb());
    } finally {
      this.busy = false;
    }
  }

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => {
      void this.sample();
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sample();
  }
}

async function embedInBatches(
  provider: ReturnType<typeof createOpenAICompatEmbedding>,
  texts: string[],
): Promise<number> {
  let count = 0;
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const vectors = await provider.embed(batch);
    count += vectors.length;
  }
  return count;
}

async function runCase(
  entry: BenchmarkCorpusEntry,
  manifestDir: string,
  model: string,
  options: BenchmarkOptions,
): Promise<Record<string, unknown>> {
  const pdfPath = path.resolve(manifestDir, entry.pdf);
  const structured: StructuredStats = {
    calls: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    errors: [],
  };
  const memory = new MemorySampler();
  const parser = createTesseractPdfOcr();
  const llm = createOpenAICompatLlm({
    baseUrl: options.llmBaseUrl,
    model,
    timeoutMs: options.llmTimeoutMs,
  });
  const embedding =
    !options.skipEmbeddings && options.embeddingModel
      ? createOpenAICompatEmbedding({
          baseUrl: options.embeddingBaseUrl,
          model: options.embeddingModel,
        })
      : null;

  const timing: Record<string, number> = {};
  const started = performance.now();
  await memory.start();

  try {
    const bytes = await readFile(pdfPath);

    let stage = performance.now();
    const parsed = await parser.parseDocument({ filename: path.basename(pdfPath), bytes });
    timing.parse_ms = Math.round(performance.now() - stage);

    const phraseChecks = entry.expected_phrases.map((phrase) => ({
      phrase,
      found: parsed.markdown
        .toLocaleLowerCase('en-GB')
        .includes(phrase.toLocaleLowerCase('en-GB')),
    }));

    stage = performance.now();
    await tracked(structured, 'source metadata', () =>
      llm.generateStructured({
        prompt:
          'Extract the source-level metadata for the following document.\n\n---\n' +
          parsed.markdown.slice(0, MAX_PASS1_MARKDOWN),
        system: buildPass1Prompt(TAXONOMY_SLUGS),
        schema: SourceMetadataSchema,
      }),
    );
    timing.metadata_ms = Math.round(performance.now() - stage);

    const usablePages = parsed.pages.filter((page) => page.markdown.trim().length > 0);
    const windows = buildExtractionWindows(
      usablePages.map((page) => ({
        pageNumber: page.pageNumber,
        markdown: page.markdown,
      })),
      {
        ...(options.windowPages !== undefined ? { maxPages: options.windowPages } : {}),
        ...(options.windowChars !== undefined ? { maxChars: options.windowChars } : {}),
        ...(options.overlapPages !== undefined ? { overlapPages: options.overlapPages } : {}),
      },
    );

    stage = performance.now();
    const rawCandidates: RecommendationCandidate[] = [];
    for (const window of windows) {
      const result = await tracked(structured, 'candidate window ' + window.index, () =>
        llm.generateStructured({
          prompt:
            'Find actionable recommendations in this page window.\n\n---\n' + window.text,
          system: buildRecommendationCandidatePrompt(),
          schema: RecommendationCandidatesSchema,
        }),
      );
      for (const candidate of result.value.recommendations) {
        rawCandidates.push(applyWindowProvenance(candidate, window));
      }
    }
    const candidates = dedupeRecommendations(rawCandidates);
    timing.candidate_ms = Math.round(performance.now() - stage);

    stage = performance.now();
    const enrichments: RecommendationEnrichment[] = [];
    for (let offset = 0; offset < candidates.length; offset += ENRICHMENT_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + ENRICHMENT_BATCH_SIZE);
      const indexedBatch = batch.map((candidate, localIndex) => ({
        candidate_index: offset + localIndex,
        title: candidate.title,
        body: candidate.body,
        page_start: candidate.page_start ?? null,
        page_end: candidate.page_end ?? null,
      }));
      const result = await tracked(
        structured,
        'enrichment batch ' + Math.floor(offset / ENRICHMENT_BATCH_SIZE),
        () =>
          llm.generateStructured({
            prompt: [
              'Classify these recommendation candidates.',
              'Return one enrichment for every candidate_index.',
              '',
              JSON.stringify(indexedBatch, null, 2),
            ].join('\n'),
            system: buildRecommendationEnrichmentPrompt(TAXONOMY_SLUGS),
            schema: RecommendationEnrichmentsSchema,
          }),
      );
      enrichments.push(...result.value.enrichments);
    }
    const recommendations: RecommendationInput[] = mergeCandidateEnrichments(
      candidates,
      enrichments,
    );
    timing.enrichment_ms = Math.round(performance.now() - stage);

    let embeddedVectors = 0;
    if (embedding) {
      stage = performance.now();
      embeddedVectors += await embedInBatches(
        embedding,
        recommendations.map((recommendation) =>
          recommendation.title + '\n\n' + recommendation.body,
        ),
      );
      embeddedVectors += await embedInBatches(
        embedding,
        parsed.pages.map((page) => page.markdown),
      );
      timing.embedding_ms = Math.round(performance.now() - stage);
    } else {
      timing.embedding_ms = 0;
    }

    const score = scoreRecommendations(entry.gold, recommendations, options.matchThreshold);
    timing.total_ms = Math.round(performance.now() - started);

    await memory.stop();

    return {
      status: 'ok',
      case_id: entry.id,
      label: entry.label,
      category: entry.category,
      pdf: pdfPath,
      model,
      parser: parsed.metadata['parser'] ?? parser.name,
      parser_quality: {
        page_count: parsed.pages.length,
        usable_pages: parsed.pages.filter(hasUsableText).length,
        expected_phrase_hits: phraseChecks,
        sparse_page_numbers: parsed.metadata['sparsePageNumbers'] ?? [],
        remaining_sparse_page_numbers:
          parsed.metadata['remainingSparsePageNumbers'] ?? [],
        ocr_fallback_used: parsed.metadata['ocrFallbackUsed'] ?? false,
      },
      extraction: {
        windows: windows.length,
        candidates_before_dedupe: rawCandidates.length,
        candidates_after_dedupe: candidates.length,
        recommendations: recommendations.length,
        structured_calls: structured.calls,
        structured_successes: structured.successes,
        structured_failures: structured.failures,
        structured_validity_rate:
          structured.calls === 0 ? 1 : structured.successes / structured.calls,
        timeout_failures: structured.timeouts,
        errors: structured.errors,
      },
      embeddings: {
        enabled: embedding !== null,
        model: options.embeddingModel,
        vectors: embeddedVectors,
      },
      score,
      timing,
      memory: {
        peak_harness_rss_mb: Math.round(memory.peakHarnessRssMb * 10) / 10,
        peak_ollama_rss_mb: Math.round(memory.peakOllamaRssMb * 10) / 10,
      },
      predictions: recommendations.map((recommendation) => ({
        title: recommendation.title,
        body: recommendation.body,
        page_start: recommendation.page_start ?? null,
        page_end: recommendation.page_end ?? null,
      })),
    };
  } catch (error) {
    timing.total_ms = Math.round(performance.now() - started);
    await memory.stop();
    return {
      status: 'failed',
      case_id: entry.id,
      label: entry.label,
      category: entry.category,
      pdf: pdfPath,
      model,
      error: error instanceof Error ? error.message : String(error),
      extraction: {
        structured_calls: structured.calls,
        structured_successes: structured.successes,
        structured_failures: structured.failures,
        structured_validity_rate:
          structured.calls === 0 ? 0 : structured.successes / structured.calls,
        timeout_failures: structured.timeouts,
        errors: structured.errors,
      },
      timing,
      memory: {
        peak_harness_rss_mb: Math.round(memory.peakHarnessRssMb * 10) / 10,
        peak_ollama_rss_mb: Math.round(memory.peakOllamaRssMb * 10) / 10,
      },
    };
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const rawManifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as unknown;
  const manifest = BenchmarkCorpusManifestSchema.parse(rawManifest);
  const manifestDir = path.dirname(options.manifestPath);

  const entries = options.caseIds
    ? manifest.entries.filter((entry) => options.caseIds!.has(entry.id))
    : manifest.entries;
  if (entries.length === 0) throw new Error('No corpus entries matched --case');

  const results: Array<Record<string, unknown>> = [];
  for (const model of options.models) {
    console.log('[benchmark] model=' + model);
    for (const entry of entries) {
      console.log('[benchmark]   case=' + entry.id + ' (' + entry.category + ')');
      const result = await runCase(entry, manifestDir, model, options);
      results.push(result);
      const status = result['status'];
      if (status === 'ok') {
        const score = result['score'] as { recall: number; precision: number; pageAnchorAccuracy: number | null };
        console.log(
          '[benchmark]   ok recall=' +
            score.recall.toFixed(3) +
            ' precision=' +
            score.precision.toFixed(3) +
            ' page=' +
            (score.pageAnchorAccuracy === null ? 'n/a' : score.pageAnchorAccuracy.toFixed(3)),
        );
      } else {
        console.log('[benchmark]   FAILED ' + String(result['error']));
      }
    }
  }

  const aggregateByModel = options.models.map((model) => {
    const modelResults = results.filter((result) => result['model'] === model);
    const successful = modelResults.filter((result) => result['status'] === 'ok');
    const scores = successful.map((result) => result['score'] as ReturnType<typeof scoreRecommendations>);
    const structuredCalls = modelResults.reduce(
      (sum, result) =>
        sum + Number((result['extraction'] as Record<string, unknown>)['structured_calls'] ?? 0),
      0,
    );
    const structuredSuccesses = modelResults.reduce(
      (sum, result) =>
        sum + Number((result['extraction'] as Record<string, unknown>)['structured_successes'] ?? 0),
      0,
    );
    return {
      model,
      cases: modelResults.length,
      cases_succeeded: successful.length,
      case_success_rate: modelResults.length === 0 ? 0 : successful.length / modelResults.length,
      recommendation_score:
        scores.length === 0 ? null : aggregateRecommendationScores(scores),
      structured_calls: structuredCalls,
      structured_successes: structuredSuccesses,
      structured_validity_rate:
        structuredCalls === 0 ? 0 : structuredSuccesses / structuredCalls,
      total_wall_clock_ms: modelResults.reduce(
        (sum, result) =>
          sum + Number((result['timing'] as Record<string, unknown>)['total_ms'] ?? 0),
        0,
      ),
      peak_harness_rss_mb: modelResults.reduce(
        (peak, result) =>
          Math.max(
            peak,
            Number((result['memory'] as Record<string, unknown>)['peak_harness_rss_mb'] ?? 0),
          ),
        0,
      ),
      peak_ollama_rss_mb: modelResults.reduce(
        (peak, result) =>
          Math.max(
            peak,
            Number((result['memory'] as Record<string, unknown>)['peak_ollama_rss_mb'] ?? 0),
          ),
        0,
      ),
    };
  });

  const report = {
    format: 'open-recs-local-ingest-benchmark/1',
    generated_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      node: process.version,
    },
    config: {
      manifest: options.manifestPath,
      models: options.models,
      llm_base_url: options.llmBaseUrl,
      llm_timeout_ms: options.llmTimeoutMs,
      embedding_model: options.embeddingModel,
      embedding_base_url: options.embeddingBaseUrl,
      skip_embeddings: options.skipEmbeddings,
      window_pages: options.windowPages ?? 6,
      window_chars: options.windowChars ?? 12000,
      overlap_pages: options.overlapPages ?? 1,
      match_threshold: options.matchThreshold,
    },
    aggregate_by_model: aggregateByModel,
    results,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('[benchmark] wrote ' + options.outputPath);
  console.log(JSON.stringify(aggregateByModel, null, 2));

  if (results.some((result) => result['status'] !== 'ok')) process.exitCode = 2;
}

main().catch((error) => {
  console.error('[benchmark:local-ingest] failed:', error);
  process.exit(1);
});
