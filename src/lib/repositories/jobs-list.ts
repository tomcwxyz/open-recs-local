import { sql } from 'drizzle-orm';
import { ownershipRequests, sources, type SourceStatus } from '../db/schema';
import type { RepoContext } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecentJob = {
  id: string;
  name: string;
  state: string;
  createdOn: Date;
  completedOn: Date | null;
};

type RawRow = {
  id: string;
  name: string;
  state: string;
  createdOn: Date | string;
  completedOn: Date | string | null;
};

// Postgres SQLSTATE for "undefined_table" — raised when the pgboss schema
// hasn't been created yet (fresh DB before the worker has run boss.start()).
const PG_UNDEFINED_TABLE = '42P01';

function isUndefinedTableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === PG_UNDEFINED_TABLE) return true;
  // Drizzle wraps postgres-js errors in its own Error and tucks the original
  // PostgresError onto `cause`. The SQLSTATE we want is on the cause.
  if (e.cause !== undefined && isUndefinedTableError(e.cause)) return true;
  return (
    typeof e.message === 'string' &&
    e.message.includes('pgboss') &&
    e.message.includes('does not exist')
  );
}

/**
 * Reads pg-boss's own job table to surface recent activity on the dashboard.
 * Couples us to pg-boss's schema (currently v12: pgboss.job columns are
 * id, name, state, created_on, completed_on). Pin pg-boss in package.json
 * — a major bump may rename columns and need an update here.
 *
 * Returns [] when the pgboss schema isn't installed yet — happens on a
 * fresh database before the worker has called boss.start(), and we'd
 * rather show an empty card than crash the dashboard render.
 *
 * Phase 8 will extend this to intersect with sources the viewer can see.
 */
export async function listRecentJobs(
  _ctx: RepoContext,
  args: { limit?: number } = {},
): Promise<RecentJob[]> {
  const limit = args.limit ?? 20;
  let rows: RawRow[];
  try {
    rows = await _ctx.db.execute<RawRow>(sql`
      SELECT
        id::text     AS "id",
        name         AS "name",
        state        AS "state",
        created_on   AS "createdOn",
        completed_on AS "completedOn"
      FROM pgboss.job
      ORDER BY created_on DESC
      LIMIT ${limit}
    `);
  } catch (err) {
    if (isUndefinedTableError(err)) return [];
    throw err;
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    createdOn: row.createdOn instanceof Date ? row.createdOn : new Date(row.createdOn),
    completedOn:
      row.completedOn === null
        ? null
        : row.completedOn instanceof Date
          ? row.completedOn
          : new Date(row.completedOn),
  }));
}

export type RecentSource = {
  id: string;
  slug: string;
  title: string;
  status: string;
  createdAt: Date;
};

/**
 * Recent sources for the dashboard, filtered by viewer visibility:
 * isSystem sees everything; a logged-in user sees public + their own
 * private sources; an anonymous viewer sees only public.
 *
 * Mirrors the auth-filter pattern from src/lib/repositories/recommendation.ts
 * so flipping APP_MODE doesn't change the query shape.
 */
export async function listRecentSources(
  ctx: RepoContext,
  args: { limit?: number; q?: string; status?: SourceStatus } = {},
): Promise<RecentSource[]> {
  const limit = args.limit ?? 20;
  const viewerId = ctx.auth.user?.id;
  const viewerEmail = ctx.auth.user.email;
  const authFilter = ctx.auth.isSystem
    ? sql`TRUE`
    : viewerId && UUID_RE.test(viewerId)
      ? viewerEmail
        ? sql`(
            s.is_private = FALSE
            OR s.owner_user_id = ${viewerId}::uuid
            OR EXISTS (
              SELECT 1
              FROM ${ownershipRequests} access_request
              WHERE access_request.source_id = s.id
                AND access_request.requester_email = ${viewerEmail}
                AND access_request.status = 'approved'
            )
          )`
        : sql`(s.is_private = FALSE OR s.owner_user_id = ${viewerId}::uuid)`
      : sql`s.is_private = FALSE`;

  // Build a single WHERE clause that always applies the auth filter, then
  // optionally narrows on title ILIKE and/or exact status. Each term is
  // parameterized by drizzle's `sql` template — no string concatenation of
  // user input reaches the driver.
  const conditions: ReturnType<typeof sql>[] = [authFilter];
  if (args.q !== undefined && args.q.length > 0) {
    conditions.push(sql`s.title ILIKE '%' || ${args.q} || '%'`);
  }
  if (args.status !== undefined) {
    conditions.push(sql`s.status = ${args.status}`);
  }
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const rows = await ctx.db.execute<{
    id: string;
    slug: string;
    title: string;
    status: string;
    createdAt: Date | string;
  }>(sql`
    SELECT
      s.id::text       AS "id",
      s.slug           AS "slug",
      s.title          AS "title",
      s.status         AS "status",
      s.created_at     AS "createdAt"
    FROM ${sources} s
    WHERE ${where}
    ORDER BY s.created_at DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  }));
}
