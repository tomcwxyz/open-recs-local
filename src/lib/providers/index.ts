import type { Env } from '../env';
import type { AuthProvider } from './auth/types';
import type { LlmProvider } from './llm/types';
import type { EmbeddingProvider } from './embedding/types';
import type { OcrProvider } from './ocr/types';
import type { StorageProvider } from './storage/types';
import type { EmailProvider } from './email/types';
import { localAuth } from './auth/local';
import { createBetterAuthProvider } from './auth/better-auth';
import { createAuth } from '../auth/config';
import { createDb } from '../db/client';
import { createConsoleEmail } from './email/console';
import { createResendEmail } from './email/resend';
import { createFakeLlm } from './llm/fake';
import { createOpenAICompatLlm } from './llm/openai-compat';
import { createFakeEmbedding } from './embedding/fake';
import { createOpenAICompatEmbedding } from './embedding/openai-compat';
import { createFakeOcr } from './ocr/fake';
import { createDoclingOcr } from './ocr/docling';
import { createMistralOcr } from './ocr/mistral';
import { createTesseractPdfOcr } from './ocr/tesseract-pdf';
import { createFakeStorage } from './storage/fake';
import { createFsStorage } from './storage/fs';

export type Providers = {
  auth: AuthProvider;
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  ocr: OcrProvider;
  storage: StorageProvider;
  email: EmailProvider;
};

function notWired(kind: string, value: string): never {
  throw new Error(`provider ${kind}=${value} is not wired yet`);
}

// Lazily-constructed hosted-mode singletons. Auth + the underlying DB client
// have side-effects (cookie reads, pool connections) so we share them across
// requests within a process. Tests construct their own pair via
// `createBetterAuthProvider(createAuth({...}), client.db)`.
let hostedAuthSingleton: AuthProvider | null = null;

function selectAuth(env: Env): AuthProvider {
  if (env.APP_MODE === 'local') return localAuth;
  if (!hostedAuthSingleton) {
    const client = createDb(env.DATABASE_URL);
    const auth = createAuth({
      db: client.db,
      email: createConsoleEmail(),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
    });
    hostedAuthSingleton = createBetterAuthProvider(auth, client.db);
  }
  return hostedAuthSingleton;
}

function selectLlm(env: Env): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case 'fake':
      return createFakeLlm();
    case 'openai-compatible': {
      // env schema refinement already guarantees these when provider === 'openai-compatible',
      // but narrow explicitly so the adapter's config type stays required-only.
      if (!env.LLM_BASE_URL || !env.LLM_MODEL) {
        throw new Error(
          'LLM_PROVIDER=openai-compatible requires LLM_BASE_URL and LLM_MODEL',
        );
      }
      return createOpenAICompatLlm({
        baseUrl: env.LLM_BASE_URL,
        model: env.LLM_MODEL,
        ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
        ...(env.LLM_TIMEOUT_MS ? { timeoutMs: env.LLM_TIMEOUT_MS } : {}),
      });
    }
    default:
      return notWired('llm', env.LLM_PROVIDER);
  }
}

function selectEmbedding(env: Env): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'fake':
      return createFakeEmbedding();
    case 'openai-compatible': {
      if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_MODEL) {
        throw new Error(
          'EMBEDDING_PROVIDER=openai-compatible requires EMBEDDING_BASE_URL and EMBEDDING_MODEL',
        );
      }
      return createOpenAICompatEmbedding({
        baseUrl: env.EMBEDDING_BASE_URL,
        model: env.EMBEDDING_MODEL,
        ...(env.EMBEDDING_API_KEY ? { apiKey: env.EMBEDDING_API_KEY } : {}),
      });
    }
    default:
      return notWired('embedding', env.EMBEDDING_PROVIDER);
  }
}

function selectOcr(env: Env): OcrProvider {
  switch (env.OCR_PROVIDER) {
    case 'fake':
      return createFakeOcr();
    case 'docling': {
      if (!env.DOCLING_BASE_URL) {
        throw new Error('OCR_PROVIDER=docling requires DOCLING_BASE_URL');
      }
      return createDoclingOcr({ baseUrl: env.DOCLING_BASE_URL });
    }
    case 'mistral': {
      if (!env.MISTRAL_API_KEY) {
        throw new Error('OCR_PROVIDER=mistral requires MISTRAL_API_KEY');
      }
      return createMistralOcr({
        apiKey: env.MISTRAL_API_KEY,
        ...(env.MISTRAL_BASE_URL ? { baseUrl: env.MISTRAL_BASE_URL } : {}),
      });
    }
    case 'tesseract-pdf':
      return createTesseractPdfOcr();
    default:
      return notWired('ocr', env.OCR_PROVIDER);
  }
}

// Module-level singleton for the fake storage so every createProviders()
// call within a process shares the same in-memory Map. Real adapters
// (S3, GCS, etc.) are stateless from the provider's perspective — their
// "backend" is external. The fake's backend is the Map; we mirror the
// real-adapter contract by reusing it.
let fakeStorageSingleton: StorageProvider | null = null;

function selectStorage(env: Env): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case 'fake':
      if (!fakeStorageSingleton) fakeStorageSingleton = createFakeStorage();
      return fakeStorageSingleton;
    case 'fs': {
      // Env schema's superRefine guarantees this is set when provider===fs,
      // but narrow explicitly so the adapter's config stays required-only.
      if (!env.STORAGE_FS_PATH) {
        throw new Error('STORAGE_PROVIDER=fs requires STORAGE_FS_PATH');
      }
      return createFsStorage({ basePath: env.STORAGE_FS_PATH });
    }
    default:
      return notWired('storage', env.STORAGE_PROVIDER);
  }
}

function selectEmail(env: Env): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'resend': {
      // Env schema's superRefine guarantees these when provider === 'resend',
      // but narrow explicitly so the adapter's config type stays required-only.
      if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
        throw new Error(
          'EMAIL_PROVIDER=resend requires RESEND_API_KEY and RESEND_FROM',
        );
      }
      return createResendEmail({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM });
    }
    case 'console':
    default:
      return createConsoleEmail();
  }
}

export function createProviders(env: Env): Providers {
  return {
    auth: selectAuth(env),
    llm: selectLlm(env),
    embedding: selectEmbedding(env),
    ocr: selectOcr(env),
    storage: selectStorage(env),
    email: selectEmail(env),
  };
}
