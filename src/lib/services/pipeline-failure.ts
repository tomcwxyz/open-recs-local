import type { PipelineErrorCategory, PipelineStage } from '@/lib/db/schema';

export type ClassifiedPipelineFailure = {
  category: PipelineErrorCategory;
  retrySafe: boolean;
  message: string;
};

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
};

function errorChain(error: unknown): { text: string; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.name, current.message);
      const asLike = current as Error & { code?: unknown; cause?: unknown };
      if (typeof asLike.code === 'string') codes.push(asLike.code);
      current = asLike.cause;
      continue;
    }
    if (typeof current === 'object') {
      const asLike = current as ErrorLike;
      if (typeof asLike.name === 'string') messages.push(asLike.name);
      if (typeof asLike.message === 'string') messages.push(asLike.message);
      if (typeof asLike.code === 'string') codes.push(asLike.code);
      current = asLike.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }

  return {
    text: messages.join(' ').toLocaleLowerCase('en-GB'),
    codes,
  };
}

function surfaceMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Small, explainable failure taxonomy used by durable pipeline attempts and,
 * later, retry/UI policy. Classification never changes the thrown error.
 */
export function classifyPipelineFailure(
  stage: PipelineStage,
  error: unknown,
): ClassifiedPipelineFailure {
  const message = surfaceMessage(error);
  const { text, codes } = errorChain(error);

  if (stage === 'parse') {
    if (
      /(?:pdftotext|ocrmypdf|tesseract|docling).*(?:enoent|not found|unavailable|econnrefused|fetch failed|connection refused)/i.test(
        text,
      )
    ) {
      return { category: 'parser_unavailable', retrySafe: true, message };
    }
    if (/timeout|timed out|aborterror|aborted/.test(text)) {
      return { category: 'parser_timeout', retrySafe: true, message };
    }
    if (/no extractable text|no usable text|produced no .*text/.test(text)) {
      return { category: 'no_usable_text', retrySafe: false, message };
    }
    if (
      /no original file|storage|storage key|enoent|no such file|blob.*not found/.test(text)
    ) {
      return { category: 'storage_unreadable', retrySafe: true, message };
    }
  }

  if (stage === 'extract') {
    if (/timeout|timed out|aborterror|aborted/.test(text)) {
      return { category: 'model_timeout', retrySafe: true, message };
    }
    if (
      /structured|schema validation|valid json|invalid json|zod|response.*schema/.test(text)
    ) {
      return { category: 'invalid_structured_output', retrySafe: true, message };
    }
    if (
      /econnrefused|fetch failed|connection refused|model.*not found|404.*model|provider .*not wired/.test(
        text,
      )
    ) {
      return { category: 'model_unavailable', retrySafe: true, message };
    }
  }

  if (stage === 'embed') {
    if (/dimension mismatch|expected \d+-dim|expected 768-dim/.test(text)) {
      return { category: 'embedding_dimension', retrySafe: false, message };
    }
    if (/context.*(?:length|window|limit)|token.*(?:limit|maximum|too long)|input.*too long/.test(text)) {
      return { category: 'embedding_context', retrySafe: false, message };
    }
    if (/timeout|timed out|aborterror|aborted/.test(text)) {
      return { category: 'model_timeout', retrySafe: true, message };
    }
    if (/econnrefused|fetch failed|connection refused|model.*not found|404.*model/.test(text)) {
      return { category: 'model_unavailable', retrySafe: true, message };
    }
  }

  // postgres SQLSTATE codes are five characters. Treat a surfaced DB error as
  // a persistence failure after provider-specific checks have had first refusal.
  if (
    codes.some((code) => /^[0-9A-Z]{5}$/i.test(code)) ||
    /postgres|drizzle|database.*(?:error|failed)|duplicate key|foreign key|constraint|relation .* does not exist/.test(
      text,
    )
  ) {
    return { category: 'database_persistence', retrySafe: true, message };
  }

  return { category: 'unknown', retrySafe: false, message };
}
