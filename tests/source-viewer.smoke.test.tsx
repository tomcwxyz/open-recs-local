import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceViewer } from '@/components/source-viewer/source-viewer';

vi.mock('next/dynamic', () => ({
  default: () =>
    function StubSourcePdfViewer({
      activePage,
      totalPages,
    }: {
      activePage: number;
      totalPages?: number;
    }) {
      return (
        <div data-testid="stub-pdf-viewer">
          <span>
            Page {activePage}
            {totalPages ? ` / ${totalPages}` : ''}
          </span>
          {Array.from({ length: totalPages ?? 0 }, (_, index) => (
            <div key={index + 1} data-testid="stub-page" data-page={index + 1} />
          ))}
        </div>
      );
    },
}));

beforeEach(() => {
  class StubIO {
    constructor(_cb: unknown) {}
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', StubIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fixturePages = [
  {
    pageNumber: 1,
    markdown: '# Sample report\n\nFirst page body with a [[ref]].',
    imageUrls: { 'src/p1.png': '/api/files/T-P1' },
  },
  {
    pageNumber: 2,
    markdown: '# Page two\n\n![](src/p1.png)',
    imageUrls: { 'src/p1.png': '/api/files/T-P1' },
  },
];

describe('Source viewer smoke', () => {
  it('renders the title, both panes, and the page indicator', () => {
    render(
      <SourceViewer
        title="Sample report"
        pages={fixturePages}
        pdfUrl="/api/files/T-PDF"
      />,
    );

    // "Sample report" appears in both the header and the markdown H1.
    expect(screen.getAllByText('Sample report').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('section[data-page]')).toHaveLength(2);
    // Continuous-scroll PDF: one stub-page per fixture page.
    const stubs = screen.getAllByTestId('stub-page');
    expect(stubs).toHaveLength(2);
    expect(stubs[0]?.getAttribute('data-page')).toBe('1');
    expect(screen.getAllByText(/page 1 \/ 2/i).length).toBeGreaterThan(0);
  });

  it('rewrites markdown image refs to the supplied signed URLs', () => {
    render(
      <SourceViewer
        title="x"
        pages={fixturePages}
        pdfUrl="/api/files/T-PDF"
      />,
    );

    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/files/T-P1');
  });

  it('exposes the resizable separator', () => {
    render(
      <SourceViewer
        title="x"
        pages={fixturePages}
        pdfUrl="/api/files/T-PDF"
      />,
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
