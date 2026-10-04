import { performance } from 'node:perf_hooks';
import { createOpenAICompatLlm } from '@/lib/providers/llm/openai-compat';
import { RecommendationCandidatesSchema } from '@/lib/services/extraction-schema';
import { buildRecommendationCandidatePrompt } from '@/lib/services/extraction-prompts';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const model =
    valueAfter('--model') ??
    process.env.BENCHMARK_LLM_MODEL ??
    process.env.LLM_MODEL;
  if (!model) {
    throw new Error(
      'Set --model, BENCHMARK_LLM_MODEL, or LLM_MODEL to the Ollama model id to probe.',
    );
  }

  const baseUrl =
    valueAfter('--base-url') ??
    process.env.BENCHMARK_LLM_BASE_URL ??
    process.env.LLM_BASE_URL ??
    'http://localhost:11434/v1';

  const llm = createOpenAICompatLlm({
    baseUrl,
    model,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
  });

  const started = performance.now();
  const result = await llm.generateStructured({
    system: buildRecommendationCandidatePrompt(),
    prompt: [
      'Find actionable recommendations in this page window.',
      '',
      '---',
      '[PAGE 7]',
      'The review recommends that every local authority publish an annual accessibility plan and report progress publicly.',
    ].join('\n'),
    schema: RecommendationCandidatesSchema,
  });
  const elapsedMs = Math.round(performance.now() - started);

  const first = result.value.recommendations[0];
  if (!first) throw new Error('structured-output probe returned no recommendation');
  if (first.page_start !== 7 && first.page_end !== 7) {
    throw new Error(
      'structured-output probe did not preserve the explicit page 7 provenance: ' +
        JSON.stringify(first),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: llm.name,
        model,
        base_url: baseUrl,
        elapsed_ms: elapsedMs,
        recommendation: first,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[smoke:ollama:real] failed:', error);
  process.exit(1);
});
