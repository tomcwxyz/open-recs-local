import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ownershipRequests,
  sources,
  type OwnershipRequestStatus,
} from '../db/schema';
import { AuthorizationError, type RepoContext } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdmin(ctx: RepoContext): boolean {
  if (ctx.auth.isSystem) return true;
  return ctx.auth.roles.includes('admin');
}

export type SourceAccessCheck =
  | { kind: 'visible'; sourceId: string }
  | {
      kind: 'private';
      sourceId: string;
      title: string;
      isOwner: boolean;
      pendingRequestId: string | null;
    }
  | { kind: 'not-found' };

/**
 * Inspect a source slug from a request-access perspective:
 *
 *   - `visible` — the viewer can see the source (public, or they own it, or
 *     they're system). Caller renders the source as usual.
 *   - `private` — the source exists but the viewer can't see it. Caller
 *     renders the request-access form (unless `isOwner` says they actually
 *     own it but the viewer ctx hasn't refreshed yet).
 *   - `not-found` — slug doesn't exist anywhere. Caller 404s.
 *
 * Bypasses the standard auth filter on purpose: the whole point of the
 * "request access" flow is to surface that a private source exists.
 */
export async function describeSourceAccess(
  ctx: RepoContext,
  slug: string,
): Promise<SourceAccessCheck> {
  const rows = await ctx.db
    .select({
      id: sources.id,
      title: sources.title,
      isPrivate: sources.isPrivate,
      ownerUserId: sources.ownerUserId,
    })
    .from(sources)
    .where(eq(sources.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: 'not-found' };

  const viewerId = ctx.auth.user.id;
  const isOwner = !!row.ownerUserId && row.ownerUserId === viewerId;
  if (!row.isPrivate || isOwner || ctx.auth.isSystem) {
    return { kind: 'visible', sourceId: row.id };
  }

  let pendingRequestId: string | null = null;
  const email = ctx.auth.user.email;
  if (email) {
    const existing = await ctx.db
      .select({ id: ownershipRequests.id, status: ownershipRequests.status })
      .from(ownershipRequests)
      .where(
        and(
          eq(ownershipRequests.sourceId, row.id),
          eq(ownershipRequests.requesterEmail, email),
        ),
      )
      .orderBy(desc(ownershipRequests.createdAt));

    if (existing.some((request) => request.status === 'approved')) {
      return { kind: 'visible', sourceId: row.id };
    }
    pendingRequestId = existing.find((request) => request.status === 'pending')?.id ?? null;
  }
  return {
    kind: 'private',
    sourceId: row.id,
    title: row.title,
    isOwner,
    pendingRequestId,
  };
}

export type CreateOwnershipRequestInput = {
  sourceId: string;
  note?: string | undefined;
};

export type CreateOwnershipRequestResult = {
  id: string;
  status: OwnershipRequestStatus;
};

/**
 * Logged-in users create an ownership request against a private source they
 * don't own. Identifier is the user's email (matches the v1 schema). Refuses
 * duplicate pending requests from the same requester for the same source.
 */
export async function createOwnershipRequest(
  ctx: RepoContext,
  input: CreateOwnershipRequestInput,
): Promise<CreateOwnershipRequestResult | { error: 'unauthenticated' | 'duplicate' | 'unknown-source' }> {
  if (!UUID_RE.test(input.sourceId)) return { error: 'unknown-source' };
  const email = ctx.auth.user.email;
  if (!email) return { error: 'unauthenticated' };

  // De-dupe within the source × email × status='pending' scope. A partial
  // unique index (ownership_requests_one_pending_per_requester_idx) backs
  // this check at the database layer so concurrent submissions can't slip
  // through the read-then-write window. We still pre-check to surface a
  // typed error instead of the raw constraint violation; the catch below
  // covers the race.
  try {
    const [inserted] = await ctx.db
      .insert(ownershipRequests)
      .values({
        sourceId: input.sourceId,
        requesterEmail: email,
        ...(ctx.auth.user.name ? { requesterName: ctx.auth.user.name } : {}),
        ...(input.note ? { note: input.note } : {}),
      })
      .returning({ id: ownershipRequests.id, status: ownershipRequests.status });
    if (!inserted) throw new Error('ownership request insert returned no row');
    return { id: inserted.id, status: inserted.status };
  } catch (err) {
    // Postgres unique_violation = 23505. Drizzle wraps postgres-js errors,
    // so check both the surface error and its `cause`. The partial index
    // (ownership_requests_one_pending_per_requester_idx) catches the race.
    const pgCode = extractPgCode(err);
    if (pgCode === '23505') return { error: 'duplicate' };
    throw err;
  }
}

function extractPgCode(err: unknown): string | null {
  for (let cur = err; cur != null; ) {
    if (typeof cur === 'object' && 'code' in cur && typeof cur.code === 'string') {
      return cur.code;
    }
    if (typeof cur === 'object' && 'cause' in cur) {
      cur = cur.cause;
    } else {
      break;
    }
  }
  return null;
}

export type PendingOwnershipRequestRow = {
  id: string;
  sourceId: string;
  sourceSlug: string;
  sourceTitle: string;
  requesterEmail: string;
  requesterName: string | null;
  note: string | null;
  createdAt: Date;
};

/** Admin-only — list pending requests, newest first, joined with the source. */
export async function listPendingOwnershipRequests(
  ctx: RepoContext,
): Promise<PendingOwnershipRequestRow[]> {
  if (!isAdmin(ctx)) throw new AuthorizationError('only admins can list ownership requests');
  const rows = await ctx.db
    .select({
      id: ownershipRequests.id,
      sourceId: ownershipRequests.sourceId,
      sourceSlug: sources.slug,
      sourceTitle: sources.title,
      requesterEmail: ownershipRequests.requesterEmail,
      requesterName: ownershipRequests.requesterName,
      note: ownershipRequests.note,
      createdAt: ownershipRequests.createdAt,
    })
    .from(ownershipRequests)
    .innerJoin(sources, eq(sources.id, ownershipRequests.sourceId))
    .where(eq(ownershipRequests.status, 'pending'))
    .orderBy(desc(ownershipRequests.createdAt));
  return rows;
}

/**
 * Admin-only — approve a pending request as an access grant. Ownership stays
 * with the existing source owner; the approved request itself is the durable
 * grant used by source visibility checks. We still resolve the requester to a
 * user so stale requests for deleted accounts cannot be approved.
 */
export async function approveOwnershipRequest(
  ctx: RepoContext,
  id: string,
): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'no_user_for_email' }> {
  if (!isAdmin(ctx)) throw new AuthorizationError('only admins can approve ownership requests');
  if (!UUID_RE.test(id)) return { ok: false, error: 'not_found' };

  const found = await ctx.db.execute<{ userId: string | null }>(sql`
    SELECT u.id::text AS "userId"
    FROM ownership_requests orq
    LEFT JOIN users u ON u.email = orq.requester_email
    WHERE orq.id = ${id}::uuid AND orq.status = 'pending'
    LIMIT 1
  `);
  const row = found[0];
  if (!row) return { ok: false, error: 'not_found' };
  if (!row.userId) return { ok: false, error: 'no_user_for_email' };

  const adminId = ctx.auth.user.id && UUID_RE.test(ctx.auth.user.id) ? ctx.auth.user.id : null;
  await ctx.db.execute(sql`
    UPDATE ownership_requests
    SET status = 'approved',
        resolved_at = now(),
        resolved_by = ${adminId ? sql`${adminId}::uuid` : sql`NULL`}
    WHERE id = ${id}::uuid AND status = 'pending'
  `);
  return { ok: true };
}

/** Admin-only — mark a pending request rejected (no source change). */
export async function rejectOwnershipRequest(
  ctx: RepoContext,
  id: string,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  if (!isAdmin(ctx)) throw new AuthorizationError('only admins can reject ownership requests');
  if (!UUID_RE.test(id)) return { ok: false, error: 'not_found' };

  const adminId = ctx.auth.user.id && UUID_RE.test(ctx.auth.user.id) ? ctx.auth.user.id : null;
  const result = await ctx.db.execute<{ id: string }>(sql`
    UPDATE ownership_requests
    SET status = 'rejected', resolved_at = now(),
        resolved_by = ${adminId ? sql`${adminId}::uuid` : sql`NULL`},
        note = COALESCE(${note ?? null}, note)
    WHERE id = ${id}::uuid AND status = 'pending'
    RETURNING id::text AS id
  `);
  if (result.length === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}

/** Requester-only — withdraw a pending request. The requester is identified by ctx.user.email. */
export async function withdrawOwnershipRequest(
  ctx: RepoContext,
  id: string,
): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'unauthenticated' }> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'not_found' };
  const email = ctx.auth.user.email;
  if (!email) return { ok: false, error: 'unauthenticated' };

  const result = await ctx.db.execute<{ id: string }>(sql`
    UPDATE ownership_requests
    SET status = 'withdrawn', resolved_at = now()
    WHERE id = ${id}::uuid
      AND status = 'pending'
      AND requester_email = ${email}
    RETURNING id::text AS id
  `);
  if (result.length === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}
