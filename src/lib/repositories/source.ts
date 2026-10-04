import { and, asc, eq } from 'drizzle-orm';
import { ownershipRequests, sourceFiles, sourcePages, sources } from '../db/schema';
import { AuthorizationError, NotFoundError, type RepoContext } from './types';

type SourceRow = {
  id: string;
  slug: string;
  title: string;
  isPrivate: boolean;
  ownerUserId: string | null;
};

function canWrite(ctx: RepoContext): boolean {
  if (ctx.auth.isSystem) return true;
  return ctx.auth.roles.includes('admin') || ctx.auth.roles.includes('editor');
}

async function canRead(ctx: RepoContext, row: SourceRow): Promise<boolean> {
  if (!row.isPrivate) return true;
  if (ctx.auth.isSystem) return true;
  if (row.ownerUserId !== null && ctx.auth.user.id === row.ownerUserId) return true;

  const email = ctx.auth.user.email;
  if (!email) return false;

  const grants = await ctx.db
    .select({ id: ownershipRequests.id })
    .from(ownershipRequests)
    .where(
      and(
        eq(ownershipRequests.sourceId, row.id),
        eq(ownershipRequests.requesterEmail, email),
        eq(ownershipRequests.status, 'approved'),
      ),
    )
    .limit(1);

  return grants.length > 0;
}

export async function createSource(
  ctx: RepoContext,
  input: { slug: string; title: string; isPrivate?: boolean; ownerUserId?: string | null },
): Promise<{ id: string; slug: string }> {
  if (!canWrite(ctx)) throw new AuthorizationError('cannot create source');
  // exactOptionalPropertyTypes: only copy optional props when defined
  const values: {
    slug: string;
    title: string;
    isPrivate?: boolean;
    ownerUserId?: string | null;
  } = { slug: input.slug, title: input.title };
  if (input.isPrivate !== undefined) values.isPrivate = input.isPrivate;
  if (input.ownerUserId !== undefined) values.ownerUserId = input.ownerUserId;
  const [inserted] = await ctx.db
    .insert(sources)
    .values(values)
    .returning({ id: sources.id, slug: sources.slug });
  if (!inserted) throw new Error('createSource: no row returned');
  return inserted;
}

export async function findSourceBySlug(
  ctx: RepoContext,
  slug: string,
): Promise<SourceRow | null> {
  const rows = await ctx.db
    .select({
      id: sources.id,
      slug: sources.slug,
      title: sources.title,
      isPrivate: sources.isPrivate,
      ownerUserId: sources.ownerUserId,
    })
    .from(sources)
    .where(eq(sources.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await canRead(ctx, row)) ? row : null;
}

/**
 * Insert a `source_files` row. Pipelines use this for the `original` upload
 * plus any derived assets (page images, extracted attachments). Write access
 * is the same as `createSource` — anyone who can create the parent can
 * attach files to it.
 */
export async function createSourceFile(
  ctx: RepoContext,
  input: {
    sourceId: string;
    role: 'original' | 'page-image' | 'extracted-asset';
    storageKey: string;
    mimeType: string;
    bytes: number;
  },
): Promise<{ id: string }> {
  if (!canWrite(ctx)) throw new AuthorizationError('cannot create source file');
  const [inserted] = await ctx.db
    .insert(sourceFiles)
    .values(input)
    .returning({ id: sourceFiles.id });
  if (!inserted) throw new Error('createSourceFile: no row returned');
  return inserted;
}

export type SourceFileLookup = {
  storageKey: string;
  mimeType: string;
  sourceId: string;
  role: 'original' | 'page-image' | 'extracted-asset';
};

/**
 * Look up a `source_files` row by its storage key, returning null if no row
 * matches OR the joined source isn't visible to the viewer. The signed-URL
 * route relies on this for ownership gating — the HMAC token only proves the
 * key was minted by us, not that the current viewer can see it.
 */
export async function findSourceFileByKey(
  ctx: RepoContext,
  storageKey: string,
): Promise<SourceFileLookup | null> {
  const rows = await ctx.db
    .select({
      storageKey: sourceFiles.storageKey,
      mimeType: sourceFiles.mimeType,
      sourceId: sourceFiles.sourceId,
      role: sourceFiles.role,
      isPrivate: sources.isPrivate,
      ownerUserId: sources.ownerUserId,
      slug: sources.slug,
      title: sources.title,
      sourceIdJoin: sources.id,
    })
    .from(sourceFiles)
    .innerJoin(sources, eq(sources.id, sourceFiles.sourceId))
    .where(eq(sourceFiles.storageKey, storageKey))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const sourceRow: SourceRow = {
    id: row.sourceIdJoin,
    slug: row.slug,
    title: row.title,
    isPrivate: row.isPrivate,
    ownerUserId: row.ownerUserId,
  };
  if (!(await canRead(ctx, sourceRow))) return null;

  return {
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sourceId: row.sourceId,
    role: row.role,
  };
}

export type SourcePageRow = {
  pageNumber: number;
  markdown: string;
  imageRefs: string[];
};

export type SourceWithPages = {
  source: {
    id: string;
    slug: string;
    title: string;
    isPrivate: boolean;
    ownerUserId: string | null;
  };
  pages: SourcePageRow[];
  /** Storage key of the `role: 'original'` file, or null if not uploaded yet. */
  originalPdfKey: string | null;
};

/**
 * Source-detail page reader. Throws NotFoundError when the slug doesn't
 * exist OR the joined source isn't visible to the viewer — same error in
 * both cases so the route layer doesn't need to distinguish (and we don't
 * leak slug existence to anonymous viewers).
 */
export async function getSourceWithPagesBySlug(
  ctx: RepoContext,
  slug: string,
): Promise<SourceWithPages> {
  const [src] = await ctx.db
    .select({
      id: sources.id,
      slug: sources.slug,
      title: sources.title,
      isPrivate: sources.isPrivate,
      ownerUserId: sources.ownerUserId,
    })
    .from(sources)
    .where(eq(sources.slug, slug))
    .limit(1);
  if (!src || !(await canRead(ctx, src))) throw new NotFoundError(`source not found: ${slug}`);

  const [pageRows, pdfRows] = await Promise.all([
    ctx.db
      .select({
        pageNumber: sourcePages.pageNumber,
        markdown: sourcePages.markdown,
        imageRefs: sourcePages.imageRefs,
      })
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, src.id))
      .orderBy(asc(sourcePages.pageNumber)),
    ctx.db
      .select({ storageKey: sourceFiles.storageKey })
      .from(sourceFiles)
      .where(and(eq(sourceFiles.sourceId, src.id), eq(sourceFiles.role, 'original')))
      .limit(1),
  ]);

  return {
    source: src,
    pages: pageRows.map((r) => ({
      pageNumber: r.pageNumber,
      markdown: r.markdown,
      imageRefs: r.imageRefs ?? [],
    })),
    originalPdfKey: pdfRows[0]?.storageKey ?? null,
  };
}

/**
 * Row shape with the full PR 1 / PR 2 metadata columns. Used by the edit
 * page (`/sources/[slug]/edit`) so the form has all the fields it needs to
 * populate as defaults. Auth filter mirrors `findSourceBySlug`.
 */
export type SourceWithMetadata = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  authors: string[];
  publicationDate: Date | null;
  orgOwner: string | null;
  originalUrl: string | null;
  attachmentUrl: string | null;
  datasets: Array<{ description: string; url: string }>;
  isPrivate: boolean;
  ownerUserId: string | null;
};

export async function findSourceBySlugWithMetadata(
  ctx: RepoContext,
  slug: string,
): Promise<SourceWithMetadata | null> {
  const rows = await ctx.db
    .select({
      id: sources.id,
      slug: sources.slug,
      title: sources.title,
      summary: sources.summary,
      authors: sources.authors,
      publicationDate: sources.publicationDate,
      orgOwner: sources.orgOwner,
      originalUrl: sources.originalUrl,
      attachmentUrl: sources.attachmentUrl,
      datasets: sources.datasets,
      isPrivate: sources.isPrivate,
      ownerUserId: sources.ownerUserId,
    })
    .from(sources)
    .where(eq(sources.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // The auth filter reuses `canRead` via a compatible projection shape.
  if (!(await canRead(ctx, { id: row.id, slug: row.slug, title: row.title, isPrivate: row.isPrivate, ownerUserId: row.ownerUserId }))) return null;
  return row;
}

/**
 * UPDATE source metadata columns and optionally `is_private`. Used by the
 * source edit page's server action. Tags + M2M memberships are handled by
 * the action via `resolveOrCreate*` + `replaceSource*`; this function just
 * touches the direct columns on the `sources` row.
 */
export type UpdateSourceMetadataInput = {
  title: string;
  summary: string | null;
  authors: string[];
  publicationDate: Date | null;
  orgOwner: string | null;
  originalUrl: string | null;
  attachmentUrl: string | null;
  datasets: Array<{ description: string; url: string }>;
  isPrivate?: boolean;
};

export async function updateSourceMetadata(
  ctx: RepoContext,
  sourceId: string,
  input: UpdateSourceMetadataInput,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle update set value typing
  const updateSet: Record<string, any> = {
    title: input.title,
    summary: input.summary,
    authors: input.authors,
    publicationDate: input.publicationDate,
    orgOwner: input.orgOwner,
    originalUrl: input.originalUrl,
    attachmentUrl: input.attachmentUrl,
    datasets: input.datasets,
    updatedAt: new Date(),
  };
  if (input.isPrivate !== undefined) {
    updateSet['isPrivate'] = input.isPrivate;
  }
  await ctx.db.update(sources).set(updateSet).where(eq(sources.id, sourceId));
}

