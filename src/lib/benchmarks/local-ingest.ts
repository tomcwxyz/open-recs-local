import { z } from 'zod';

export const BENCHMARK_CATEGORIES = [
  'short-born-digital',
  'long-born-digital',
  'scanned',
  'multi-column',
  'table-heavy',
  'no-recommendations',
  'implicit-scattered',
] as const;

export const BenchmarkGoldRecommendationSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1).optional(),
  page_start: z.number().int().positive().nullable().optional(),
  page_end: z.number().int().positive().nullable().optional(),
});

export const BenchmarkCorpusEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pdf: z.string().min(1),
  category: z.enum(BENCHMARK_CATEGORIES),
  expected_phrases: z.array(z.string().min(1)).default([]),
  gold: z.array(BenchmarkGoldRecommendationSchema).default([]),
  notes: z.string().optional(),
});

export const BenchmarkCorpusManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(BenchmarkCorpusEntrySchema).min(1),
});

export type BenchmarkGoldRecommendation = z.infer<typeof BenchmarkGoldRecommendationSchema>;
export type BenchmarkCorpusEntry = z.infer<typeof BenchmarkCorpusEntrySchema>;
export type BenchmarkCorpusManifest = z.infer<typeof BenchmarkCorpusManifestSchema>;

export type BenchmarkPrediction = {
  title: string;
  body: string;
  page_start?: number | null | undefined;
  page_end?: number | null | undefined;
};

export type RecommendationMatch = {
  goldIndex: number;
  predictionIndex: number;
  similarity: number;
  pageAnchorCorrect: boolean | null;
};

export type RecommendationScore = {
  goldCount: number;
  predictionCount: number;
  matchedCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  recall: number;
  precision: number;
  f1: number;
  pageAnchorAccuracy: number | null;
  pageAnchorsEvaluated: number;
  matches: RecommendationMatch[];
  falsePositiveIndexes: number[];
  falseNegativeIndexes: number[];
};

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokenSet(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase('en-GB').match(TOKEN_RE) ?? [])
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function diceCoefficient(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

/**
 * Transparent lexical matcher for gold-set scoring.
 *
 * Titles carry most of the weight because benchmark gold bodies may be more
 * detailed than model output. When a gold body is available we also compare
 * complete recommendation text so a generic title alone cannot create a high
 * score. This is intentionally deterministic and dependency-free: benchmark
 * results should not depend on another embedding/LLM model.
 */
export function recommendationSimilarity(
  gold: BenchmarkGoldRecommendation,
  prediction: BenchmarkPrediction,
): number {
  const title = diceCoefficient(gold.title, prediction.title);
  if (!gold.body) return title;

  const body = diceCoefficient(gold.body, prediction.body);
  const combined = diceCoefficient(
    gold.title + ' ' + gold.body,
    prediction.title + ' ' + prediction.body,
  );
  return Math.max(title * 0.7 + body * 0.3, combined);
}

function normaliseSpan(
  start: number | null | undefined,
  end: number | null | undefined,
): [number, number] | null {
  const first = start ?? end ?? null;
  const last = end ?? start ?? null;
  if (first === null || last === null) return null;
  return first <= last ? [first, last] : [last, first];
}

function pageAnchorCorrect(
  gold: BenchmarkGoldRecommendation,
  prediction: BenchmarkPrediction,
): boolean | null {
  const goldSpan = normaliseSpan(gold.page_start, gold.page_end);
  if (!goldSpan) return null;
  const predictedSpan = normaliseSpan(prediction.page_start, prediction.page_end);
  if (!predictedSpan) return false;
  return predictedSpan[0] <= goldSpan[1] && goldSpan[0] <= predictedSpan[1];
}

function harmonicMean(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Greedy one-to-one matching over every gold/prediction pair above threshold.
 * Pairs are considered in descending similarity order, which prevents one
 * prediction from satisfying multiple gold recommendations.
 */
export function scoreRecommendations(
  gold: BenchmarkGoldRecommendation[],
  predictions: BenchmarkPrediction[],
  threshold = 0.46,
): RecommendationScore {
  const pairs: Array<{ goldIndex: number; predictionIndex: number; similarity: number }> = [];

  for (let goldIndex = 0; goldIndex < gold.length; goldIndex += 1) {
    for (let predictionIndex = 0; predictionIndex < predictions.length; predictionIndex += 1) {
      const similarity = recommendationSimilarity(gold[goldIndex]!, predictions[predictionIndex]!);
      if (similarity >= threshold) {
        pairs.push({ goldIndex, predictionIndex, similarity });
      }
    }
  }

  pairs.sort((a, b) => b.similarity - a.similarity);

  const usedGold = new Set<number>();
  const usedPredictions = new Set<number>();
  const matches: RecommendationMatch[] = [];

  for (const pair of pairs) {
    if (usedGold.has(pair.goldIndex) || usedPredictions.has(pair.predictionIndex)) continue;
    usedGold.add(pair.goldIndex);
    usedPredictions.add(pair.predictionIndex);
    matches.push({
      ...pair,
      pageAnchorCorrect: pageAnchorCorrect(
        gold[pair.goldIndex]!,
        predictions[pair.predictionIndex]!,
      ),
    });
  }

  const matchedCount = matches.length;
  const falsePositiveIndexes = predictions
    .map((_, index) => index)
    .filter((index) => !usedPredictions.has(index));
  const falseNegativeIndexes = gold
    .map((_, index) => index)
    .filter((index) => !usedGold.has(index));

  const recall =
    gold.length === 0 ? 1 : matchedCount / gold.length;
  const precision =
    predictions.length === 0
      ? gold.length === 0
        ? 1
        : 0
      : matchedCount / predictions.length;

  const pageMatches = matches.filter((match) => match.pageAnchorCorrect !== null);
  const correctPageMatches = pageMatches.filter((match) => match.pageAnchorCorrect === true);

  return {
    goldCount: gold.length,
    predictionCount: predictions.length,
    matchedCount,
    falsePositiveCount: falsePositiveIndexes.length,
    falseNegativeCount: falseNegativeIndexes.length,
    recall,
    precision,
    f1: harmonicMean(precision, recall),
    pageAnchorAccuracy:
      pageMatches.length === 0 ? null : correctPageMatches.length / pageMatches.length,
    pageAnchorsEvaluated: pageMatches.length,
    matches,
    falsePositiveIndexes,
    falseNegativeIndexes,
  };
}

export function aggregateRecommendationScores(scores: RecommendationScore[]): RecommendationScore {
  const goldCount = scores.reduce((sum, score) => sum + score.goldCount, 0);
  const predictionCount = scores.reduce((sum, score) => sum + score.predictionCount, 0);
  const matchedCount = scores.reduce((sum, score) => sum + score.matchedCount, 0);
  const pageAnchorsEvaluated = scores.reduce(
    (sum, score) => sum + score.pageAnchorsEvaluated,
    0,
  );
  const pageAnchorsCorrect = scores.reduce(
    (sum, score) =>
      sum + score.matches.filter((match) => match.pageAnchorCorrect === true).length,
    0,
  );

  const recall = goldCount === 0 ? 1 : matchedCount / goldCount;
  const precision =
    predictionCount === 0 ? (goldCount === 0 ? 1 : 0) : matchedCount / predictionCount;

  return {
    goldCount,
    predictionCount,
    matchedCount,
    falsePositiveCount: predictionCount - matchedCount,
    falseNegativeCount: goldCount - matchedCount,
    recall,
    precision,
    f1: harmonicMean(precision, recall),
    pageAnchorAccuracy:
      pageAnchorsEvaluated === 0 ? null : pageAnchorsCorrect / pageAnchorsEvaluated,
    pageAnchorsEvaluated,
    matches: [],
    falsePositiveIndexes: [],
    falseNegativeIndexes: [],
  };
}
