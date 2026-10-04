import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPostgres, type StartedPg } from '../../../tests/helpers/pg-container';
import { applyMigrations } from '../../../tests/helpers/migrate';
import { createDb, type Db, type DbClient } from '../db/client';
import { seedUser } from '../../../tests/helpers/seed-user';
import { sources } from '../db/schema';
import {
  approveOwnershipRequest,
  createOwnershipRequest,
  describeSourceAccess,
  listPendingOwnershipRequests,
  rejectOwnershipRequest,
  withdrawOwnershipRequest,
} from './ownership-request';
import { AuthorizationError, type RepoContext } from './types';

let pg: StartedPg;
let client: DbClient;

function ctxSystem(db: Db): RepoContext {
  return { db, auth: { user: { id: 'system' }, roles: ['admin'], isSystem: true } };
}
function ctxAdmin(db: Db, userId: string, email: string): RepoContext {
  return {
    db,
    auth: { user: { id: userId, email }, roles: ['admin'], isSystem: false },
  };
}
function ctxUser(db: Db, userId: string, email: string): RepoContext {
  return {
    db,
    auth: { user: { id: userId, email }, roles: ['viewer'], isSystem: false },
  };
}
function ctxAnon(db: Db): RepoContext {
  return {
    db,
    auth: { user: { id: 'anonymous' }, roles: [], isSystem: false },
  };
}

async function seedPrivateSource(args: {
  slug: string;
  title: string;
  ownerUserId: string;
}): Promise<string> {
  const [row] = await client.db
    .insert(sources)
    .values({ slug: args.slug, title: args.title, isPrivate: true, ownerUserId: args.ownerUserId })
    .returning({ id: sources.id });
  if (!row) throw new Error('seed: no source row');
  return row.id;
}

beforeAll(async () => {
  pg = await startPostgres();
  await applyMigrations(pg.url).then(({ sql }) => sql.end());
  client = createDb(pg.url);
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await pg?.container.stop();
});

describe('describeSourceAccess', () => {
  it('returns visible for a public source', async () => {
    await client.db
      .insert(sources)
      .values({ slug: 'or-pub', title: 'pub', isPrivate: false });
    const result = await describeSourceAccess(ctxAnon(client.db), 'or-pub');
    expect(result.kind).toBe('visible');
  });

  it('returns private with isOwner=false for a stranger on a private source', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-owner-1@test' });
    await seedPrivateSource({ slug: 'or-priv-1', title: 'Priv 1', ownerUserId: ownerId });
    const strangerId = await seedUser(client.db, { email: 'or-stranger-1@test' });
    const result = await describeSourceAccess(
      ctxUser(client.db, strangerId, 'or-stranger-1@test'),
      'or-priv-1',
    );
    if (result.kind !== 'private') throw new Error('expected private');
    expect(result.isOwner).toBe(false);
    expect(result.title).toBe('Priv 1');
    expect(result.pendingRequestId).toBeNull();
  });

  it('returns visible to the owner of a private source', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-owner-2@test' });
    await seedPrivateSource({ slug: 'or-priv-2', title: 'Priv 2', ownerUserId: ownerId });
    const result = await describeSourceAccess(
      ctxUser(client.db, ownerId, 'or-owner-2@test'),
      'or-priv-2',
    );
    expect(result.kind).toBe('visible');
  });

  it('surfaces an existing pending request id', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-owner-3@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-priv-3',
      title: 'Priv 3',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-req-3@test' });
    const result1 = await createOwnershipRequest(
      ctxUser(client.db, reqId, 'or-req-3@test'),
      { sourceId: srcId, note: 'please' },
    );
    expect('id' in result1).toBe(true);

    const access = await describeSourceAccess(
      ctxUser(client.db, reqId, 'or-req-3@test'),
      'or-priv-3',
    );
    if (access.kind !== 'private') throw new Error('expected private');
    expect(access.pendingRequestId).not.toBeNull();
  });

  it('returns not-found for an unknown slug', async () => {
    const result = await describeSourceAccess(ctxAnon(client.db), 'no-such-slug');
    expect(result.kind).toBe('not-found');
  });
});

describe('createOwnershipRequest', () => {
  it('refuses an anonymous requester', async () => {
    const result = await createOwnershipRequest(ctxAnon(client.db), {
      sourceId: '11111111-1111-4111-8111-111111111111',
    });
    expect('error' in result && result.error).toBe('unauthenticated');
  });

  it('refuses a second pending request from the same email for the same source', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-dup-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-dup-src',
      title: 'Dup',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-dup-req@test' });
    const ctx = ctxUser(client.db, reqId, 'or-dup-req@test');
    const first = await createOwnershipRequest(ctx, { sourceId: srcId });
    expect('id' in first).toBe(true);
    const second = await createOwnershipRequest(ctx, { sourceId: srcId });
    expect('error' in second && second.error).toBe('duplicate');
  });

  it('the partial unique index catches a concurrent submission race', async () => {
    // Fire two creates in parallel from the same requester. With the
    // pre-check alone, both could pass the existence read; the partial
    // unique index forces one to fail at the database. Exactly one
    // ok-with-id should land; the other should report 'duplicate'.
    const ownerId = await seedUser(client.db, { email: 'or-race-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-race-src',
      title: 'Race',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-race-req@test' });
    const ctx = ctxUser(client.db, reqId, 'or-race-req@test');

    const [a, b] = await Promise.all([
      createOwnershipRequest(ctx, { sourceId: srcId }),
      createOwnershipRequest(ctx, { sourceId: srcId }),
    ]);
    const okCount = [a, b].filter((r) => 'id' in r).length;
    const dupCount = [a, b].filter((r) => 'error' in r && r.error === 'duplicate').length;
    expect(okCount).toBe(1);
    expect(dupCount).toBe(1);
  });
});

describe('approve / reject / withdraw', () => {
  it('approveOwnershipRequest grants access without transferring source ownership', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-app-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-app-src',
      title: 'App',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-app-req@test' });
    const created = await createOwnershipRequest(
      ctxUser(client.db, reqId, 'or-app-req@test'),
      { sourceId: srcId, note: 'please' },
    );
    if (!('id' in created)) throw new Error('expected created');

    const adminId = await seedUser(client.db, { email: 'or-app-admin@test' });
    const approved = await approveOwnershipRequest(
      ctxAdmin(client.db, adminId, 'or-app-admin@test'),
      created.id,
    );
    expect(approved.ok).toBe(true);

    const [sourceRow] = await client.db
      .select({ ownerUserId: sources.ownerUserId })
      .from(sources)
      .where(eq(sources.id, srcId))
      .limit(1);
    expect(sourceRow?.ownerUserId).toBe(ownerId);

    const accessAsReq = await describeSourceAccess(
      ctxUser(client.db, reqId, 'or-app-req@test'),
      'or-app-src',
    );
    expect(accessAsReq.kind).toBe('visible');

    const accessAsOwner = await describeSourceAccess(
      ctxUser(client.db, ownerId, 'or-app-owner@test'),
      'or-app-src',
    );
    expect(accessAsOwner.kind).toBe('visible');
  });

  it('rejectOwnershipRequest sets status=rejected, no source change', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-rej-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-rej-src',
      title: 'Rej',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-rej-req@test' });
    const created = await createOwnershipRequest(
      ctxUser(client.db, reqId, 'or-rej-req@test'),
      { sourceId: srcId },
    );
    if (!('id' in created)) throw new Error('expected created');

    const adminId = await seedUser(client.db, { email: 'or-rej-admin@test' });
    const rejected = await rejectOwnershipRequest(
      ctxAdmin(client.db, adminId, 'or-rej-admin@test'),
      created.id,
    );
    expect(rejected.ok).toBe(true);

    // Requester still cannot see it.
    const access = await describeSourceAccess(
      ctxUser(client.db, reqId, 'or-rej-req@test'),
      'or-rej-src',
    );
    expect(access.kind).toBe('private');
  });

  it('withdrawOwnershipRequest is restricted to the original requester', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-w-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-w-src',
      title: 'W',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-w-req@test' });
    const created = await createOwnershipRequest(
      ctxUser(client.db, reqId, 'or-w-req@test'),
      { sourceId: srcId },
    );
    if (!('id' in created)) throw new Error('expected created');

    const otherId = await seedUser(client.db, { email: 'or-w-other@test' });
    const stranger = await withdrawOwnershipRequest(
      ctxUser(client.db, otherId, 'or-w-other@test'),
      created.id,
    );
    expect('error' in stranger && stranger.error).toBe('not_found');

    const owner = await withdrawOwnershipRequest(
      ctxUser(client.db, reqId, 'or-w-req@test'),
      created.id,
    );
    expect(owner.ok).toBe(true);
  });

  it('listPendingOwnershipRequests is admin-only', async () => {
    const viewerId = await seedUser(client.db, { email: 'or-list-viewer@test' });
    await expect(
      listPendingOwnershipRequests(ctxUser(client.db, viewerId, 'or-list-viewer@test')),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('listPendingOwnershipRequests', () => {
  it('returns pending requests with joined source title', async () => {
    const ownerId = await seedUser(client.db, { email: 'or-ll-owner@test' });
    const srcId = await seedPrivateSource({
      slug: 'or-ll-src',
      title: 'Listing',
      ownerUserId: ownerId,
    });
    const reqId = await seedUser(client.db, { email: 'or-ll-req@test' });
    const created = await createOwnershipRequest(
      ctxUser(client.db, reqId, 'or-ll-req@test'),
      { sourceId: srcId, note: 'see me' },
    );
    if (!('id' in created)) throw new Error('expected created');

    const rows = await listPendingOwnershipRequests(ctxSystem(client.db));
    const me = rows.find((r) => r.id === created.id);
    expect(me?.sourceSlug).toBe('or-ll-src');
    expect(me?.sourceTitle).toBe('Listing');
    expect(me?.requesterEmail).toBe('or-ll-req@test');
    expect(me?.note).toBe('see me');
  });
});
