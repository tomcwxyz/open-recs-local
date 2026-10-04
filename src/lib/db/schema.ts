import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  vector,
  index,
  uniqueIndex,
  customType,
  primaryKey,
  date,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIM = 768 as const;

/**
 * Postgres `tsvector` column. Drizzle 0.45 has no native helper for tsvector,
 * so we declare a custom type that emits `tsvector` in generated SQL and in
 * drizzle-kit snapshots, avoiding the text/GIN mismatch.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Better-auth tables. Shape mirrors Better-auth 1.x's expected fields; we
 * declare them in our Drizzle schema so the migration story stays a single
 * `pnpm db:migrate` rather than mixing CLIs. Better-auth's drizzle adapter is
 * configured with `usePlural: true` so it looks up `users` / `sessions` /
 * `accounts` / `verifications` instead of the singular defaults.
 *
 * IDs are `uuid` (Postgres-typed) so the existing `owner_user_id` /
 * `set_by_user_id` / `author_user_id` / `resolved_by` columns can FK in
 * directly. Better-auth's `generateId` is overridden in the auth config to
 * emit `crypto.randomUUID()` strings.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  accountId: text('account_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * App-layer role assignment. Kept separate from Better-auth so the role concept
 * stays portable across auth libs and so role changes don't trigger a session
 * rebuild. Composite PK on (user_id, role) — a user can hold multiple roles.
 */
export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.role] }),
  }),
);

/** Status values for a source through the parse → extract → embed pipeline. */
export const SOURCE_STATUS = ['pending', 'parsing', 'extracting', 'embedding', 'ready', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUS)[number];

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    summary: text('summary'),
    authors: text('authors').array().notNull().default(sql`'{}'::text[]`),
    publicationDate: date('publication_date', { mode: 'date' }),
    orgOwner: text('org_owner'),
    originalUrl: text('original_url'),
    attachmentUrl: text('attachment_url'),
    datasets: jsonb('datasets').$type<Array<{ description: string; url: string }>>().notNull().default([]),
    canonicalMarkdown: text('canonical_markdown'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    isPrivate: boolean('is_private').notNull().default(false),
    status: text('status', { enum: SOURCE_STATUS }).notNull().default('pending'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(canonical_markdown, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tsvIdx: index('sources_tsv_idx').using('gin', t.tsv),
    statusIdx: index('sources_status_idx').on(t.status),
  }),
);

export const PIPELINE_STAGES = ['parse', 'extract', 'embed'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_ATTEMPT_STATUS = ['running', 'succeeded', 'failed'] as const;
export type PipelineAttemptStatus = (typeof PIPELINE_ATTEMPT_STATUS)[number];

export const PIPELINE_ERROR_CATEGORIES = [
  'storage_unreadable',
  'parser_unavailable',
  'parser_timeout',
  'no_usable_text',
  'model_unavailable',
  'model_timeout',
  'invalid_structured_output',
  'embedding_dimension',
  'embedding_context',
  'database_persistence',
  'unknown',
] as const;
export type PipelineErrorCategory = (typeof PIPELINE_ERROR_CATEGORIES)[number];

/**
 * Durable history for expensive ingest stages. A source can have many attempts
 * per stage; attempt numbers are allocated serially by the repository.
 *
 * `sources.status` remains the cheap current-state projection used by the UI.
 * This table is the audit/recovery history: what ran, with which provider/model,
 * how long it took, and why a failed attempt stopped.
 */
export const sourcePipelineAttempts = pgTable(
  'source_pipeline_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    stage: text('stage', { enum: PIPELINE_STAGES }).notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status', { enum: PIPELINE_ATTEMPT_STATUS }).notNull().default('running'),
    provider: text('provider'),
    model: text('model'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    errorCategory: text('error_category', { enum: PIPELINE_ERROR_CATEGORIES }),
    errorMessage: text('error_message'),
    retrySafe: boolean('retry_safe').notNull().default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    sourceStageAttemptUnique: uniqueIndex(
      'source_pipeline_attempts_source_stage_attempt_idx',
    ).on(t.sourceId, t.stage, t.attempt),
    sourceStartedIdx: index('source_pipeline_attempts_source_started_idx').on(
      t.sourceId,
      t.startedAt,
    ),
  }),
);

export const sourceFiles = pgTable('source_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['original', 'page-image', 'extracted-asset'] }).notNull(),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourcePages = pgTable(
  'source_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    markdown: text('markdown').notNull(),
    imageRefs: jsonb('image_refs').$type<string[]>().default([]).notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(markdown, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourcePageIdx: index('source_pages_source_page_idx').on(t.sourceId, t.pageNumber),
    embedIdx: index('source_pages_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    tsvIdx: index('source_pages_tsv_idx').using('gin', t.tsv),
  }),
);

export const REC_STATUS = ['open', 'in_progress', 'done', 'blocked', 'withdrawn'] as const;
export type RecStatus = (typeof REC_STATUS)[number];

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    pageAnchor: integer('page_anchor'),
    targetOrganization: text('target_organization'),
    priorityTimescaleId: uuid('priority_timescale_id').references(() => priorityTimescales.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] }),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tsvIdx: index('recommendations_tsv_idx').using('gin', t.tsv),
    embedIdx: index('recommendations_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    sourceIdx: index('recommendations_source_idx').on(t.sourceId),
  }),
);

export const recommendationStatuses = pgTable(
  'recommendation_statuses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    status: text('status', { enum: REC_STATUS }).notNull(),
    note: text('note'),
    setByUserId: uuid('set_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRecCreated: index('rec_statuses_rec_created_idx').on(t.recommendationId, t.createdAt),
  }),
);

export const progressUpdates = pgTable(
  'progress_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    progressNotes: text('progress_notes').notNull(),
    evidenceType: text('evidence_type'),
    evidenceUrl: text('evidence_url'),
    userProgressRating: text('user_progress_rating'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRecCreated: index('progress_updates_rec_created_idx').on(t.recommendationId, t.createdAt),
  }),
);

export const thematicAreas = pgTable('thematic_areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // Nullable to match the other taxonomy axes — auto-created `unverified`
  // tags don't carry a colour until an admin assigns one via /admin/tags.
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recommendationsThematicAreas = pgTable(
  'recommendations_thematic_areas',
  {
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    thematicAreaId: uuid('thematic_area_id')
      .notNull()
      .references(() => thematicAreas.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.recommendationId, t.thematicAreaId] }),
  }),
);

/**
 * Shared shape for taxonomy axes added in the 1.1 extraction-and-tagging
 * rebuild. Each axis is a flat reference table with a unique slug. Tags
 * created from extraction-time LLM output that don't match a seeded slug
 * land here with `unverified=true` for admin review at /admin/tags.
 *
 * `color_hex` is nullable — only some axes (themes) carry a visual palette.
 */
export const purposes = pgTable('purposes', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceTypes = pgTable('source_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const targetAudienceTypes = pgTable('target_audience_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const locationScopes = pgTable('location_scopes', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roleRelevances = pgTable('role_relevances', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const priorityTimescales = pgTable('priority_timescales', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  description: text('description'),
  unverified: boolean('unverified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// -- sources × axis M2M join tables ------------------------------------------

export const sourcesThematicAreas = pgTable(
  'sources_thematic_areas',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    thematicAreaId: uuid('thematic_area_id')
      .notNull()
      .references(() => thematicAreas.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.thematicAreaId] }),
    byThematicAreaIdx: index('sources_thematic_areas_thematic_area_id_idx').on(t.thematicAreaId),
  }),
);

export const sourcesSourceTypes = pgTable(
  'sources_source_types',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceTypeId: uuid('source_type_id')
      .notNull()
      .references(() => sourceTypes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.sourceTypeId] }),
    bySourceTypeIdx: index('sources_source_types_source_type_id_idx').on(t.sourceTypeId),
  }),
);

export const sourcesPurposes = pgTable(
  'sources_purposes',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    purposeId: uuid('purpose_id')
      .notNull()
      .references(() => purposes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.purposeId] }),
    byPurposeIdx: index('sources_purposes_purpose_id_idx').on(t.purposeId),
  }),
);

export const sourcesRoleRelevances = pgTable(
  'sources_role_relevances',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    roleRelevanceId: uuid('role_relevance_id')
      .notNull()
      .references(() => roleRelevances.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.roleRelevanceId] }),
    byRoleRelevanceIdx: index('sources_role_relevances_role_relevance_id_idx').on(t.roleRelevanceId),
  }),
);

export const sourcesTargetAudienceTypes = pgTable(
  'sources_target_audience_types',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    targetAudienceTypeId: uuid('target_audience_type_id')
      .notNull()
      .references(() => targetAudienceTypes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.targetAudienceTypeId] }),
    byTargetAudienceTypeIdx: index('sources_target_audience_types_target_audience_type_id_idx').on(
      t.targetAudienceTypeId,
    ),
  }),
);

// -- recommendations × axis M2M join tables ----------------------------------

export const recommendationsPurposes = pgTable(
  'recommendations_purposes',
  {
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    purposeId: uuid('purpose_id')
      .notNull()
      .references(() => purposes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.recommendationId, t.purposeId] }),
    byPurposeIdx: index('recommendations_purposes_purpose_id_idx').on(t.purposeId),
  }),
);

export const recommendationsTargetAudienceTypes = pgTable(
  'recommendations_target_audience_types',
  {
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    targetAudienceTypeId: uuid('target_audience_type_id')
      .notNull()
      .references(() => targetAudienceTypes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.recommendationId, t.targetAudienceTypeId] }),
    byTargetAudienceTypeIdx: index(
      'recommendations_target_audience_types_target_audience_type_id_idx',
    ).on(t.targetAudienceTypeId),
  }),
);

export const recommendationsLocationScopes = pgTable(
  'recommendations_location_scopes',
  {
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    locationScopeId: uuid('location_scope_id')
      .notNull()
      .references(() => locationScopes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.recommendationId, t.locationScopeId] }),
    byLocationScopeIdx: index('recommendations_location_scopes_location_scope_id_idx').on(
      t.locationScopeId,
    ),
  }),
);

export const evidenceTypes = pgTable('evidence_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
});

export const progressRatings = pgTable('progress_ratings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
});

export const OWNERSHIP_REQUEST_STATUS = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type OwnershipRequestStatus = (typeof OWNERSHIP_REQUEST_STATUS)[number];

export const ownershipRequests = pgTable(
  'ownership_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    requesterEmail: text('requester_email').notNull(),
    requesterName: text('requester_name'),
    note: text('note'),
    status: text('status', { enum: OWNERSHIP_REQUEST_STATUS }).notNull().default('pending'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial unique index: one pending request per (source, requester) pair.
    // Approved / rejected / withdrawn rows are exempt so a requester can
    // re-request after a rejection. Backs the read-then-write check in the
    // repo with an atomic database constraint that survives concurrency.
    onePendingPerRequester: uniqueIndex('ownership_requests_one_pending_per_requester_idx')
      .on(t.sourceId, t.requesterEmail)
      .where(sql`status = 'pending'`),
  }),
);

export const jobResults = pgTable('job_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  queue: text('queue').notNull(),
  key: text('key').notNull(),
  sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  status: text('status').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const analyticsCache = pgTable('analytics_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

// Configurable provider kinds stored in `provider_settings`. These map onto the
// LLM / chat / embedding / OCR provider selectors so DB rows can override the
// env-derived defaults at runtime (see `src/lib/providers/config.ts`).
export const PROVIDER_KINDS = ['llm', 'chat', 'embedding', 'ocr'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

// One row per configurable provider kind. `kind` is unique so the repository can
// upsert in place. `api_key_encrypted` holds AES-256-GCM ciphertext (never
// plaintext); decryption happens in the config loader using PROVIDER_SECRET_KEY.
export const providerSettings = pgTable('provider_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: PROVIDER_KINDS }).notNull().unique(),
  provider: text('provider').notNull(),
  baseUrl: text('base_url'),
  model: text('model'),
  apiKeyEncrypted: text('api_key_encrypted'),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
