import type { z } from 'zod';

export type LlmTextInput = {
  prompt: string;
  system?: string;
  temperature?: number;
};

export type LlmTextOutput = {
  text: string;
};

export type LlmStructuredInput<T> = {
  prompt: string;
  schema: z.ZodType<T>;
  system?: string;
  /** Structured extraction should normally use 0 for deterministic JSON. */
  temperature?: number;
  /** Key used by the fake to look up a canned response. Ignored by real adapters. */
  key?: string;
};

export type LlmStructuredOutput<T> = {
  value: T;
};

export interface LlmProvider {
  readonly name: string;
  generateText(input: LlmTextInput): Promise<LlmTextOutput>;
  generateStructured<T>(input: LlmStructuredInput<T>): Promise<LlmStructuredOutput<T>>;
}
