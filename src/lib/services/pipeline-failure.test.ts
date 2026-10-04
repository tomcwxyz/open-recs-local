import { describe, expect, it } from 'vitest';
import { classifyPipelineFailure } from './pipeline-failure';

describe('classifyPipelineFailure', () => {
  it('classifies missing parser executables as retry-safe parser availability failures', () => {
    const result = classifyPipelineFailure(
      'parse',
      new Error('pdftotext failed (ENOENT): spawn pdftotext ENOENT'),
    );
    expect(result).toMatchObject({
      category: 'parser_unavailable',
      retrySafe: true,
    });
  });

  it('classifies invalid structured output separately from model availability', () => {
    const result = classifyPipelineFailure(
      'extract',
      new Error('openai-compat structured: response failed schema validation'),
    );
    expect(result).toMatchObject({
      category: 'invalid_structured_output',
      retrySafe: true,
    });
  });

  it('marks embedding dimension mismatches as unsafe to blindly retry', () => {
    const result = classifyPipelineFailure(
      'embed',
      new Error('embed: expected 768-dim vectors, got 1024 from provider'),
    );
    expect(result).toMatchObject({
      category: 'embedding_dimension',
      retrySafe: false,
    });
  });

  it('falls back to unknown for errors without a recognised signature', () => {
    const result = classifyPipelineFailure('extract', new Error('something surprising'));
    expect(result).toMatchObject({ category: 'unknown', retrySafe: false });
  });
});
