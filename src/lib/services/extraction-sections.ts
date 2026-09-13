/**
 * Section-aware preprocessing for the legacy `source.extract` Pass 2 call.
 *
 * This is intentionally a deterministic prioritisation layer, not the final
 * recommendation detector. Newly parsed real sources use page-aware windows;
 * this detector remains useful for fixture-backed and older sources without
 * source_pages.
 *
 * We accept H1-H3 because real reports frequently nest recommendations under
 * a chapter heading rather than rendering them as a top-level H1.
 */

const HEADING = '#{1,3}';

const REC_HEADING_PATTERNS: readonly RegExp[] = [
  // Recommendations / Key recommendations / Recommendations for government /
  // Recommendations and next steps.
  new RegExp(
    `^${HEADING}\\s+(?:Key\\s+)?Recommendations?(?:\\s+(?:and\\s+next\\s+steps|for\\s+.+))?\\s*$`,
    'im',
  ),
  // Individual headings such as "## Recommendation 4" or
  // "### Recommendation 4: Improve commissioning".
  new RegExp(`^${HEADING}\\s+Recommendation\\s+\\d+[.:]?(?:\\s+.+)?$`, 'im'),
  new RegExp(`^${HEADING}\\s+Next\\s+steps\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+Conclusions?\\s+and\\s+recommendations?\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+Actions?\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+Action\\s+plan\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+Priorities\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+We\\s+will\\s*$`, 'im'),
  new RegExp(`^${HEADING}\\s+What\\s+we\\s+recommend\\s*$`, 'im'),
];

// Deliberately do not treat generic "Summary" or "Conclusions" headings as
// recommendation sections. Those headings are common in almost every report
// and previously pushed the legacy path into a strict recommendation prompt
// even when the section was descriptive rather than prescriptive.

const STOP_HEADING_PATTERN = new RegExp(
  `^${HEADING}\\s+(?:About|Introduction|Background|Method|Methodology|Appendix|Bibliography|References|Acknowledgements?|Acknowledgments|Contact|Overview)\\s*$`,
  'im',
);

export type SectionDetectionResult = {
  processText: string;
  mode: 'sections' | 'full-document';
};

type Match = { start: number; index: number };

function findAllMatches(markdown: string, pattern: RegExp): Match[] {
  const sweep = new RegExp(pattern.source, 'gim');
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = sweep.exec(markdown)) !== null) {
    matches.push({ start: m.index, index: sweep.lastIndex });
  }
  return matches;
}

export function detectRecommendationSections(markdown: string): SectionDetectionResult {
  const recMatches: number[] = [];
  for (const pattern of REC_HEADING_PATTERNS) {
    for (const m of findAllMatches(markdown, pattern)) {
      recMatches.push(m.start);
    }
  }
  if (recMatches.length === 0) {
    return { processText: markdown, mode: 'full-document' };
  }

  const starts = Array.from(new Set(recMatches)).sort((a, b) => a - b);
  const stopMatches = findAllMatches(markdown, STOP_HEADING_PATTERN).map((m) => m.start);

  const slices: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const nextRec = starts[i + 1] ?? Infinity;
    const nextStop = stopMatches.find((p) => p > start) ?? Infinity;
    const end = Math.min(nextRec, nextStop, markdown.length);
    slices.push(markdown.slice(start, end).trimEnd());
  }
  return { processText: slices.join('\n\n'), mode: 'sections' };
}
