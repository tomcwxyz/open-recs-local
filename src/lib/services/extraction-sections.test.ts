import { describe, expect, it } from 'vitest';
import { detectRecommendationSections } from './extraction-sections';

describe('detectRecommendationSections', () => {
  it('returns mode=full-document when no recommendation heading is found', () => {
    const md = '# About\n\nSome text.\n\n# Methodology\n\nMore text.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('full-document');
    expect(result.processText).toBe(md);
  });

  it('detects "# Recommendations" and slices from heading to end of doc', () => {
    const md = '# Intro\n\nIntro text.\n\n# Recommendations\n\n1. Do X.\n2. Do Y.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('# Recommendations');
    expect(result.processText).toContain('Do X');
    expect(result.processText).not.toContain('Intro text');
  });

  it('detects nested H2/H3 recommendation headings', () => {
    const md = '# Findings\n\nContext.\n\n## Recommendations\n\nDo X.\n\n### Recommendation 2: Do Y\n\nMore detail.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('## Recommendations');
    expect(result.processText).toContain('### Recommendation 2: Do Y');
    expect(result.processText).not.toContain('Context.');
  });

  it('detects "Key recommendations"', () => {
    const md = '# Findings\n\nText.\n\n## Key recommendations\n\n1. Fund the service.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('Key recommendations');
  });

  it('detects "Recommendations for ..." headings', () => {
    const md = '# Findings\n\nText.\n\n## Recommendations for government\n\nCreate a national plan.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('Recommendations for government');
  });

  it('detects "# Next steps" as a recommendation section', () => {
    const md = '# Background\n\nText.\n\n# Next steps\n\nAct now.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('# Next steps');
  });

  it('detects "# Conclusions and recommendations"', () => {
    const md = '# Setup\n\nA.\n\n# Conclusions and recommendations\n\nFoo.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('Conclusions and recommendations');
  });

  it('detects actions, action plans and priorities', () => {
    for (const heading of ['# Actions', '## Action plan', '### Priorities']) {
      const md = `# Findings\n\nText.\n\n${heading}\n\nDo this.`;
      const result = detectRecommendationSections(md);
      expect(result.mode).toBe('sections');
      expect(result.processText).toContain('Do this.');
    }
  });

  it('detects "# We will" as a commitment-style section', () => {
    const md = '# Context\n\nText.\n\n# We will\n\nCommit to X.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('We will');
  });

  it('detects "What we recommend"', () => {
    const md = '# Context\n\nText.\n\n## What we recommend\n\nCreate a shared standard.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('What we recommend');
  });

  it('concatenates multiple matched sections', () => {
    const md = '# Intro\n\nA.\n\n# Recommendations\n\n1. X.\n\n# About\n\nIgnore.\n\n# Next steps\n\nY.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
    expect(result.processText).toContain('# Recommendations');
    expect(result.processText).toContain('# Next steps');
  });

  it('stops a recommendation section at a nested non-recommendation heading', () => {
    const md = '## Recommendations\n\n1. X.\n\n## Appendix\n\nDo not include.';
    const result = detectRecommendationSections(md);
    expect(result.processText).toContain('1. X.');
    expect(result.processText).not.toContain('Do not include');
  });

  it('is case-insensitive on the heading text', () => {
    const md = '# RECOMMENDATIONS\n\n1. X.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('sections');
  });

  it('does not match recommendation-like words inside body text', () => {
    const md = '# About\n\nThe recommendations of this report are summarised below.\n\n# Methodology\n\nText.';
    const result = detectRecommendationSections(md);
    expect(result.mode).toBe('full-document');
  });
});
