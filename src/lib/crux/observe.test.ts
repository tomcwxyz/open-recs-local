import { describe, expect, it } from 'vitest';
import { buildCruxIngestBatch } from './observe';

describe('buildCruxIngestBatch', () => {
  it('emits metadata-only runtime provenance without source or prompt content', () => {
    const batch = buildCruxIngestBatch(
      {
        workflow: 'source.extract',
        provider: 'local-openai-compatible',
        operation: 'recommendation_extract',
      },
      {
        systemVersionRef: 'system-version:open-recs:0.1',
        producerId: 'producer:open-recs',
      },
      '2026-09-18T20:45:00.000Z',
      'run:open-recs:test-1',
    );

    expect(batch.system_version_ref).toBe('system-version:open-recs:0.1');
    expect(batch.runs[0]?.capture_mode).toBe('metadata_only');
    expect(batch.events[0]?.attributes).toEqual({
      workflow: 'source.extract',
      provider: 'local-openai-compatible',
      operation: 'recommendation_extract',
    });

    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain('prompt');
    expect(serialised).not.toContain('completion');
    expect(serialised).not.toContain('reasoning');
    expect(serialised).not.toContain('canonicalMarkdown');
  });
});
