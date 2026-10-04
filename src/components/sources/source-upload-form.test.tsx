import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceUploadForm } from './source-upload-form';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

class FakeEventSource {
  static urls: string[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    FakeEventSource.urls.push(String(url));
  }

  close() {}
}

describe('SourceUploadForm', () => {
  beforeEach(() => {
    refresh.mockReset();
    FakeEventSource.urls = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('subscribes to progress with sourceId rather than the initial queue jobId', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const jobId = '22222222-2222-4222-8222-222222222222';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sourceId, jobId, status: 'queued' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    render(<SourceUploadForm />);
    const user = userEvent.setup();
    const fileInput = screen.getByLabelText(/^PDF$/i);
    const file = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' });

    await user.upload(fileInput, file);
    await user.click(screen.getByRole('button', { name: /Upload PDF/i }));

    await waitFor(() => {
      expect(FakeEventSource.urls).toEqual([`/api/jobs/${sourceId}/stream`]);
    });
    expect(FakeEventSource.urls[0]).not.toContain(jobId);
  });
});
