'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

if (typeof window !== 'undefined') {
  // The worker is copied into public/ by scripts/copy-pdf-worker.ts at predev/prebuild.
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
}

export type SourcePdfViewerProps = {
  pdfUrl: string;
  activePage: number;
  totalPages?: number | undefined;
  onPageChange: (page: number) => void;
  onTotalPagesChange?: (count: number) => void;
};

/**
 * Continuous-scroll PDF viewer. All pages render in a vertical column; the
 * currently-active page is whichever has the most viewport coverage.
 * `activePage` from the parent drives an imperative scrollIntoView so the
 * markdown side can move us; `onPageChange` reports back when the user
 * scrolls within this pane.
 */
export function SourcePdfViewer({
  pdfUrl,
  activePage,
  totalPages,
  onPageChange,
  onTotalPagesChange,
}: SourcePdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [internalTotal, setInternalTotal] = useState<number | undefined>(totalPages);
  const known = typeof internalTotal === 'number' && internalTotal > 0;

  const pageNumbers = useMemo(
    () => (known ? Array.from({ length: internalTotal ?? 0 }, (_, i) => i + 1) : []),
    [known, internalTotal],
  );

  // IO: same shape as SourceMarkdown's — pick the page with the highest
  // intersection ratio in the container's viewport.
  useEffect(() => {
    if (!containerRef.current || pageNumbers.length === 0) return;
    const root = containerRef.current;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page]'));
    if (targets.length === 0) return;

    const visible = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset['pdfPage']);
          if (Number.isFinite(page)) visible.set(page, entry.intersectionRatio);
        }
        let bestPage = -1;
        let bestRatio = -1;
        for (const [p, r] of visible) {
          if (r > bestRatio) {
            bestRatio = r;
            bestPage = p;
          }
        }
        if (bestPage > 0 && bestRatio > 0) onPageChange(bestPage);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const t of targets) io.observe(t);
    return () => io.disconnect();
  }, [pageNumbers, onPageChange]);

  // Imperative scroll when activePage changes externally.
  useEffect(() => {
    if (!containerRef.current) return;
    const target = containerRef.current.querySelector<HTMLElement>(
      `[data-pdf-page="${activePage}"]`,
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activePage]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-background/80 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          Page {activePage}
          {known ? ` / ${internalTotal}` : ''}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto bg-muted/30 p-4">
        <Document
          file={pdfUrl}
          onLoadSuccess={(info: { numPages: number }) => {
            setInternalTotal(info.numPages);
            onTotalPagesChange?.(info.numPages);
          }}
          loading={<p className="text-sm text-muted-foreground">Loading PDF…</p>}
        >
          {pageNumbers.map((n) => (
            <div key={n} data-pdf-page={n} className="mb-4">
              <Page pageNumber={n} />
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
