'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useScrollSync } from '@/lib/hooks/use-scroll-sync';
import { SourceMarkdown, type SourcePage } from './source-markdown';

// react-pdf/pdfjs touches browser-only globals (notably DOMMatrix) while its
// module graph is evaluated. A static import from a Client Component is still
// visible to the server/build pipeline, which caused hosted source pages to
// crash during server evaluation. Keep the entire PDF renderer behind a
// client-only dynamic boundary.
const SourcePdfViewer = dynamic(
  () => import('./source-pdf-viewer').then((module) => module.SourcePdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading PDF…</p>
      </div>
    ),
  },
);

const SPLIT_KEY = 'source-viewer:split';
// Tailwind's `md:` breakpoint is 768px. Match that here so the JS layout
// flip happens at exactly the same width Tailwind's utilities do.
const MD_QUERY = '(min-width: 768px)';

export type SourceViewerProps = {
  title: string;
  pages: SourcePage[];
  pdfUrl: string;
};

/**
 * Parse a `#page=N` hash from the URL into a 1-based page number.
 * Returns `undefined` when the hash is absent or doesn't match the
 * expected shape, so callers can fall back to page 1.
 */
function pageFromHash(hash: string): number | undefined {
  const match = /[#&?]page=(\d+)/.exec(hash);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export function SourceViewer({ title, pages, pdfUrl }: SourceViewerProps) {
  const [savedSize, setSavedSize] = useLocalStorage<number>(SPLIT_KEY, 50);
  const [totalPages, setTotalPages] = useState<number | undefined>(pages.length || undefined);
  // Citation deep-linking: honour a `#page=N` hash so URLs generated from
  // citations jump straight to the referenced page. Read it once on mount
  // (lazy init so SSR doesn't touch `window`) and keep listening for
  // hashchange so in-page navigation to a different page anchor also works.
  const [initialPage, setInitialPage] = useState<number>(() =>
    typeof window === 'undefined' ? 1 : pageFromHash(window.location.hash) ?? 1,
  );
  const { activePage, setActivePage } = useScrollSync({ initialPage });
  const isWide = useMediaQuery(MD_QUERY);

  useEffect(() => {
    const apply = () => {
      const page = pageFromHash(window.location.hash);
      if (page !== undefined) {
        setActivePage(page);
        setInitialPage(page);
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [setActivePage]);

  const handleTotalPages = (count: number) => setTotalPages(count);

  const markdownNode = (
    <SourceMarkdown
      pages={pages}
      activePage={activePage}
      onActivePageChange={setActivePage}
    />
  );

  const pdfNode = (
    <SourcePdfViewer
      pdfUrl={pdfUrl}
      activePage={activePage}
      {...(totalPages !== undefined ? { totalPages } : {})}
      onPageChange={setActivePage}
      onTotalPagesChange={handleTotalPages}
    />
  );

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[40rem] flex-col border border-rule-strong bg-background">
      <header className="flex items-center justify-between gap-4 border-b border-rule-strong bg-paper-2 px-5 py-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="section-num shrink-0">Source</span>
          <h1 className="truncate text-base font-medium">{title}</h1>
        </div>
        <span className="ref tabular-nums shrink-0">
          Page {activePage}
          {totalPages ? ` of ${totalPages}` : ''}
        </span>
      </header>
      {isWide ? (
        // ≥ md: resizable horizontal split (existing behaviour).
        <Group orientation="horizontal" className="flex-1">
          <Panel
            defaultSize={`${savedSize}%`}
            minSize="25%"
            maxSize="75%"
            onResize={(size) => {
              const numeric = typeof size === 'number' ? size : parseFloat(String(size));
              if (Number.isFinite(numeric)) setSavedSize(numeric);
            }}
          >
            {markdownNode}
          </Panel>
          <Separator className="w-px bg-rule-strong transition-colors hover:w-1 hover:bg-accent" />
          <Panel minSize="25%" maxSize="75%">{pdfNode}</Panel>
        </Group>
      ) : (
        // < md: stacked vertically, each pane scrolls independently. No
        // resizer — narrow screens don't have the real estate for one.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto border-b border-rule-strong">
            {markdownNode}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{pdfNode}</div>
        </div>
      )}
    </div>
  );
}
