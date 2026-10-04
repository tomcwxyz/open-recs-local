import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createDb } from '@/lib/db/client';
import { loadEnv } from '@/lib/env';
import { signFileToken } from '@/lib/files/sign';
import { createProviders } from '@/lib/providers';
import { describeSourceAccess } from '@/lib/repositories/ownership-request';
import { getSourceWithPagesBySlug } from '@/lib/repositories/source';
import { NotFoundError } from '@/lib/repositories/types';
import type { RepoContext } from '@/lib/repositories/types';
import { SourceViewer } from '@/components/source-viewer/source-viewer';
import { RequestAccessForm } from '@/components/sources/request-access-form';
import type { SourcePage } from '@/components/source-viewer/source-markdown';
import { TagChips } from '@/components/tags/tag-chips';
import {
  listSourcePurposes,
  listSourceRoleRelevances,
  listSourceSourceTypes,
  listSourceTargetAudienceTypes,
  listSourceThematicAreas,
} from '@/lib/repositories/source-tags';
import {
  requestSourceAccess,
  withdrawSourceAccessRequest,
} from './actions';
import { listSourcePipelineAttempts } from '@/lib/repositories/source-pipeline-attempt';
import { PipelineHistory } from '@/components/sources/pipeline-history';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

export default async function SourceDetailPage({ params }: PageProps) {
  const { slug } = await params;

  const env = loadEnv();
  const providers = createProviders(env);
  const client = createDb(env.DATABASE_URL);

  try {
    const headersList = await headers();
    const req = new Request(`http://localhost/sources/${slug}`, { headers: headersList });
    const auth = await providers.auth.getContext(req);
    const ctx: RepoContext = { db: client.db, auth };

    // Inspect the slug's visibility first. In local mode the source is always
    // visible to the system context; in hosted mode it may be private to
    // another user. Branching here avoids leaking existence via the 404
    // semantics of the public-only loader.
    const access = await describeSourceAccess(ctx, slug);
    if (access.kind === 'not-found') notFound();

    if (access.kind === 'private') {
      // Anonymous viewers: don't expose request-access UI. Treat as not-found
      // so the existence isn't leaked to non-signed-in visitors.
      if (!ctx.auth.user.email) notFound();
      return (
        <RequestAccessForm
          sourceId={access.sourceId}
          sourceTitle={access.title}
          pendingRequestId={access.pendingRequestId}
          action={requestSourceAccess}
          withdrawAction={withdrawSourceAccessRequest}
        />
      );
    }

    let data;
    try {
      data = await getSourceWithPagesBySlug(ctx, slug);
    } catch (err) {
      if (err instanceof NotFoundError) notFound();
      throw err;
    }

    const canSeePipelineDiagnostics =
      ctx.auth.isSystem ||
      ctx.auth.roles.includes('admin') ||
      ctx.auth.roles.includes('editor');
    const pipelineAttempts = canSeePipelineDiagnostics
      ? await listSourcePipelineAttempts(ctx, data.source.id, 12)
      : [];

    if (!data.originalPdfKey) {
      return (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">{data.source.title}</h1>
          <p className="text-muted-foreground">This source is still being processed. Check back shortly.</p>
          {canSeePipelineDiagnostics && (
            <PipelineHistory attempts={pipelineAttempts} showErrorDetails />
          )}
        </div>
      );
    }

    const pdfToken = signFileToken(env.FILE_TOKEN_SECRET, { key: data.originalPdfKey });
    const pdfUrl = `/api/files/${pdfToken}`;

    const [themes, types, purposes, roles, audiences] = await Promise.all([
      listSourceThematicAreas(ctx, data.source.id),
      listSourceSourceTypes(ctx, data.source.id),
      listSourcePurposes(ctx, data.source.id),
      listSourceRoleRelevances(ctx, data.source.id),
      listSourceTargetAudienceTypes(ctx, data.source.id),
    ]);

    const pages: SourcePage[] = data.pages.map((p) => {
      const imageUrls: Record<string, string> = {};
      for (const ref of p.imageRefs) {
        imageUrls[ref] = `/api/files/${signFileToken(env.FILE_TOKEN_SECRET, { key: ref })}`;
      }
      return {
        pageNumber: p.pageNumber,
        markdown: p.markdown,
        imageUrls,
      };
    });

    const hasAnyChips =
      themes.length > 0 ||
      types.length > 0 ||
      purposes.length > 0 ||
      roles.length > 0 ||
      audiences.length > 0;

    return (
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <Link
            href="/sources"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-accent hover:underline"
          >
            ← All sources
          </Link>
          <div className="flex items-baseline gap-4">
            <Link
              href={`/sources/${slug}/edit`}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-accent hover:underline"
            >
              Edit
            </Link>
            <Link
              href={`/sources/${slug}/analytics`}
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              View analytics →
            </Link>
          </div>
        </div>
        {hasAnyChips && (
          <div className="space-y-2 border-b border-rule pb-4">
            <TagChips tags={themes} />
            <TagChips tags={types} />
            <TagChips tags={purposes} />
            <TagChips tags={roles} />
            <TagChips tags={audiences} />
          </div>
        )}
        {canSeePipelineDiagnostics && (
          <PipelineHistory attempts={pipelineAttempts} showErrorDetails />
        )}
        <SourceViewer title={data.source.title} pages={pages} pdfUrl={pdfUrl} />
      </div>
    );
  } finally {
    await client.sql.end({ timeout: 5 }).catch(() => {});
  }
}
