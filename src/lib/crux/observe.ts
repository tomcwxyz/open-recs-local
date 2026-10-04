import { randomUUID } from 'node:crypto';

export type CruxAIObservation = {
  workflow: string;
  provider: string;
  operation: string;
  requestModel?: string;
  responseModel?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
};

type CruxEmitterConfig = {
  ingestUrl: string;
  ingestToken: string;
  systemVersionRef: string;
  producerId: string;
};

const readConfig = (): CruxEmitterConfig | null => {
  const ingestUrl = process.env.CRUX_INGEST_URL;
  const ingestToken = process.env.CRUX_INGEST_TOKEN;
  const systemVersionRef = process.env.CRUX_SYSTEM_VERSION_REF;
  const producerId = process.env.CRUX_PRODUCER_ID;
  if (!ingestUrl || !ingestToken || !systemVersionRef || !producerId) return null;
  return { ingestUrl, ingestToken, systemVersionRef, producerId };
};

export function buildCruxIngestBatch(
  input: CruxAIObservation,
  config: Pick<CruxEmitterConfig, 'systemVersionRef' | 'producerId'>,
  occurredAt = new Date().toISOString(),
  runId = `run:${config.producerId}:${randomUUID()}`,
) {
  const eventId = `event:${runId.replace(/^run:/, '')}:1`;

  return {
    format: 'crux-ingest/0.1' as const,
    request_id: `request:${runId.replace(/^run:/, '')}`,
    producer: {
      id: config.producerId,
      kind: 'application' as const,
      name: 'Open Recommendations Local',
    },
    system_version_ref: config.systemVersionRef,
    runs: [
      {
        schema_version: '0.1' as const,
        id: runId,
        system_version_ref: config.systemVersionRef,
        started_at: occurredAt,
        completed_at: occurredAt,
        status: 'completed' as const,
        capture_mode: 'metadata_only' as const,
        disclosure: 'internal' as const,
        external_refs: [] as string[],
      },
    ],
    events: [
      {
        schema_version: '0.1' as const,
        id: eventId,
        run_ref: runId,
        sequence: 1,
        occurred_at: occurredAt,
        type: 'ai_invocation' as const,
        attributes: {
          workflow: input.workflow,
          provider: input.provider,
          operation: input.operation,
          ...(input.requestModel ? { request_model: input.requestModel } : {}),
          ...(input.responseModel ? { response_model: input.responseModel } : {}),
          ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
          ...(input.inputTokens !== undefined ? { input_tokens: input.inputTokens } : {}),
          ...(input.outputTokens !== undefined ? { output_tokens: input.outputTokens } : {}),
        },
        disclosure: 'internal' as const,
      },
    ],
    observations: [],
    evidence_envelopes: [],
  };
}

export async function emitCruxAIInvocation(input: CruxAIObservation): Promise<void> {
  const config = readConfig();
  if (!config) return;

  const body = buildCruxIngestBatch(input, config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.ingestToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[crux] observation rejected with HTTP ${response.status}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.name : typeof error;
    console.warn(`[crux] observation delivery skipped: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}
