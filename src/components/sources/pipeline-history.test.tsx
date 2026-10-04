import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipelineHistory } from './pipeline-history';
import type { SourcePipelineAttemptRow } from '@/lib/repositories/source-pipeline-attempt';

const failedAttempt: SourcePipelineAttemptRow = {
  id: 'attempt-1',
  stage: 'extract',
  attempt: 2,
  status: 'failed',
  provider: 'openai-compat',
  model: 'qwen-test',
  startedAt: new Date('2026-10-04T20:00:00Z'),
  finishedAt: new Date('2026-10-04T20:00:02Z'),
  durationMs: 2_000,
  errorCategory: 'invalid_structured_output',
  errorMessage: 'internal provider detail that should stay privileged',
  retrySafe: true,
  metadata: {},
};

describe('PipelineHistory', () => {
  it('shows actionable category/retry state without raw error detail by default', () => {
    render(<PipelineHistory attempts={[failedAttempt]} />);

    expect(screen.getByText('invalid structured output')).toBeInTheDocument();
    expect(screen.getByText(/safe to retry/i)).toBeInTheDocument();
    expect(screen.queryByText(/internal provider detail/i)).not.toBeInTheDocument();
  });

  it('shows raw error detail only when the caller explicitly allows it', () => {
    render(<PipelineHistory attempts={[failedAttempt]} showErrorDetails />);

    expect(screen.getByText(/internal provider detail/i)).toBeInTheDocument();
  });
});
