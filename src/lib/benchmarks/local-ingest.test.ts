import { describe, expect, it } from 'vitest';
import {
  BenchmarkCorpusManifestSchema,
  recommendationSimilarity,
  scoreRecommendations,
} from './local-ingest';

describe('local ingest benchmark scoring', () => {
  it('matches semantically similar lexical recommendations one-to-one', () => {
    const gold = [
      {
        title: 'Publish an annual safeguarding report',
        body: 'Publish an annual safeguarding report within three months of year-end.',
        page_start: 2,
        page_end: 2,
      },
    ];
    const predictions = [
      {
        title: 'Publish annual safeguarding report',
        body: 'The organisation should publish an annual safeguarding report within three months.',
        page_start: 2,
        page_end: 2,
      },
    ];

    expect(recommendationSimilarity(gold[0]!, predictions[0]!)).toBeGreaterThan(0.6);
    const score = scoreRecommendations(gold, predictions);
    expect(score.matchedCount).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.pageAnchorAccuracy).toBe(1);
  });

  it('counts unmatched predictions as false positives', () => {
    const score = scoreRecommendations(
      [{ title: 'Create a risk committee', page_start: 1, page_end: 1 }],
      [
        { title: 'Create a risk committee', body: 'Create a risk committee now.', page_start: 1 },
        { title: 'Buy more office chairs', body: 'Buy more office chairs next week.', page_start: 4 },
      ],
    );
    expect(score.matchedCount).toBe(1);
    expect(score.falsePositiveCount).toBe(1);
    expect(score.precision).toBe(0.5);
  });

  it('treats a clean no-recommendation document as a perfect negative', () => {
    const score = scoreRecommendations([], []);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.f1).toBe(1);
  });

  it('parses a corpus manifest with the required benchmark categories', () => {
    const parsed = BenchmarkCorpusManifestSchema.parse({
      version: 1,
      entries: [
        {
          id: 'sample',
          label: 'Sample',
          pdf: '../../fixtures/sources/sample-report.pdf',
          category: 'short-born-digital',
          expected_phrases: ['risk committee'],
          gold: [{ title: 'Create a risk committee' }],
        },
      ],
    });
    expect(parsed.entries[0]?.category).toBe('short-born-digital');
  });
});
