import type { SourcePipelineAttemptRow } from '@/lib/repositories/source-pipeline-attempt';

export type PipelineHistoryProps = {
  attempts: SourcePipelineAttemptRow[];
  showErrorDetails?: boolean;
};

const STAGE_LABEL = {
  parse: 'Parse',
  extract: 'Extract',
  embed: 'Embed',
} as const;

function statusState(status: SourcePipelineAttemptRow['status']): string {
  if (status === 'succeeded') return 'done';
  if (status === 'failed') return 'failed';
  return 'active';
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return 'running';
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatStartedAt(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function labelError(value: string): string {
  return value.replaceAll('_', ' ');
}

export function PipelineHistory({
  attempts,
  showErrorDetails = false,
}: PipelineHistoryProps) {
  if (attempts.length === 0) return null;

  return (
    <section className="space-y-3 border-y border-rule py-4" aria-labelledby="pipeline-history-title">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="section-num">Pipeline</div>
          <h2 id="pipeline-history-title" className="text-sm font-medium">
            Processing history
          </h2>
        </div>
        <span className="ref">{attempts.length} recent attempt{attempts.length === 1 ? '' : 's'}</span>
      </div>

      <ul className="divide-y divide-rule">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="grid gap-2 py-3 md:grid-cols-[7rem_7rem_1fr_auto] md:items-baseline">
            <div>
              <span className="text-sm font-medium">{STAGE_LABEL[attempt.stage]}</span>
              <span className="ref ml-2">#{attempt.attempt}</span>
            </div>
            <span className="status w-fit" data-state={statusState(attempt.status)}>
              {attempt.status}
            </span>
            <div className="min-w-0 text-sm text-muted-foreground">
              <span>
                {attempt.provider ?? 'unknown provider'}
                {attempt.model ? ` · ${attempt.model}` : ''}
              </span>
              {attempt.errorCategory && (
                <div className="mt-1">
                  <span className="font-medium text-foreground">
                    {labelError(attempt.errorCategory)}
                  </span>
                  <span> · {attempt.retrySafe ? 'safe to retry' : 'review before retrying'}</span>
                </div>
              )}
              {showErrorDetails && attempt.errorMessage && (
                <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                  {attempt.errorMessage}
                </p>
              )}
            </div>
            <div className="ref text-right tabular-nums">
              <div>{formatDuration(attempt.durationMs)}</div>
              <div>{formatStartedAt(attempt.startedAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
