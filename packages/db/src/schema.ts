import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { better_auth_user } from './auth-schema'

const uuidPk = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// ── project ──────────────────────────────────────────────────────────────────

export const projects = pgTable('project', {
  id: uuidPk(),
  // FK to better_auth_organization enforced at app layer; DB FK deferred to F5 auth task.
  organizationId: text('organization_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  summary: text('summary'),
  description: text('description'),
  thumbnailColor: text('thumbnail_color'),
  thumbnailUrl: text('thumbnail_url'),
  backgroundColor: text('background_color'),
  backgroundUrl: text('background_url'),
  conductor: jsonb('conductor').$type<Record<string, unknown>>().notNull().default({}),
  connectCode: text('connect_code').unique(),
  // The project's RELAYROOM.md (coordination playbook). Null = serve the default
  // template; the dashboard edits this, the `relayroom init` CLI pulls it.
  relayroomMd: text('relayroom_md'),
  maxBroadcastRecipients: integer('max_broadcast_recipients'), // null = computed default min(N, 8)
  // ── CI attestation (L1) ──
  // The HMAC secret that signs a `POST /api/knowledge/attest` body. It is the root
  // of the promotion trust boundary: a valid signature is what lets CI, and only
  // CI, be a promoting issuer. It is never handed to an agent connect code. Two
  // slots so a rotation does not reject in-flight runs signed with the old key.
  attestSecret: text('attest_secret'),                          // current secret; null = attestation disabled
  attestKeyId: text('attest_key_id'),                           // short id the attest body's keyId selects
  attestSecretPrev: text('attest_secret_prev'),                 // previous secret, honored during grace
  attestKeyIdPrev: text('attest_key_id_prev'),                  // short id of the previous secret
  attestSecretPrevExpiresAt: timestamp('attest_secret_prev_expires_at', { withTimezone: true }), // after this, prev is rejected and should be nulled
  // Per-project knobs. The promotion transaction reads kDistinctIssuers/windowDays;
  // the L3 extractor and retention sweep read retentionDays and redactionPatterns;
  // dynamicFactsBlock gates the served-playbook block. Empty object = every default
  // applies. redactionPatterns is a secret/PII regex denylist the extractor and
  // `learn` apply BEFORE writing a row - a matched span is dropped, never stored;
  // the field lives here, the matching runs in the server slice.
  knowledgeConfig: jsonb('knowledge_config').$type<{ kDistinctIssuers?: number; windowDays?: number; dynamicFactsBlock?: boolean; retentionDays?: number; redactionPatterns?: string[] }>()
    .notNull().default(sql`'{}'::jsonb`),
  // Durable trigger for the extractor. A thread going closed/answered sets this to
  // now(); the leased sweep claims projects where it is not null, snapshots the
  // value, writes candidates, then clears it only if it still equals the snapshot
  // (so a re-dirty mid-run is not lost). Durable on purpose: a missed NOTIFY is
  // still caught by the next sweep because the marker survives in the row.
  knowledgeDirtyAt: timestamp('knowledge_dirty_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  uniqueIndex('project_org_slug').on(t.organizationId, t.slug),
  index('project_org_idx').on(t.organizationId),
])

// ── project_access ────────────────────────────────────────────────────────────

export const projectAccess = pgTable('project_access', {
  id: uuidPk(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => better_auth_user.id, { onDelete: 'cascade' }),
  level: text('level').notNull(), // readonly | write | owner
  bannedAt: timestamp('banned_at', { withTimezone: true }), // null = active. 가역(하드 삭제 아님)
  bannedByUserId: text('banned_by_user_id').references(() => better_auth_user.id, { onDelete: 'set null' }),
  wakePriority: boolean('wake_priority').notNull().default(false), // true = 이 프로젝트가 더 큰 예약 floor 지분
  // (project, member) 단위 우선순위/사람-레인 capability. 자가선언 불가, 매니저가 부여(phase 06).
  // 값: 'urgent' (urgent wake 레인 사용 허용), 'needs_human' (알림벨 lighting 허용).
  capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  createdByUserId: text('created_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
}, t => [
  uniqueIndex('project_access_proj_user').on(t.projectId, t.userId),
  index('project_access_user_idx').on(t.userId),
])

// ── agent ─────────────────────────────────────────────────────────────────────

export const agents = pgTable('agent', {
  id: uuidPk(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  part: text('part').notNull(),
  role: text('role').notNull().default('default'), // main | default
  nickname: text('nickname'),
  badge: text('badge'),
  // Appearance preset keys (resolved to themed Tailwind classes / lucide icons in
  // the web app). Null = auto (color hashed from the part name, default icon).
  color: text('color'),
  icon: text('icon'),
  // Soft delete: hidden from active agent lists but kept so threads/events still
  // resolve this part's name in history. Cleared when the part reconnects.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ownerUserId: text('owner_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // Set ONLY by the pager heartbeat (every ~30s), so it tracks the pager process
  // being alive independent of the agent's own activity. "Pager online" = within
  // a few heartbeat intervals. Lets the UI flag a deaf agent (active but no pager).
  pagerLastSeenAt: timestamp('pager_last_seen_at', { withTimezone: true }),
  // Set by the pager heartbeat when RELAYROOM.md is present in the worktree;
  // null = not yet synced (run `relayroom init`).
  relayroomMdSyncedAt: timestamp('relayroom_md_synced_at', { withTimezone: true }),
  activationEpoch: integer('activation_epoch').notNull().default(0), // 턴 시작마다 증가
  wakeWatermarkAt: timestamp('wake_watermark_at', { withTimezone: true }), // 마지막 catch-up 지점
  // Provider rate-limit park window (self-reported via the `event` MCP tool,
  // type:'limited'). While set and in the future, wake issuance is suppressed
  // (reason 'limited'); message delivery is unaffected. The eligibility sweep
  // naturally re-wakes the part on its first tick after this passes ("resume").
  limitedUntil: timestamp('limited_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  // Each (project, part) combination is unique - enables upsert-by-part in server routes.
  uniqueIndex('agent_project_part').on(t.projectId, t.part),
  // partial unique: one main per (project, user)
  uniqueIndex('agent_project_user_main')
    .on(t.projectId, t.ownerUserId)
    .where(sql`role = 'main'`),
  index('agent_project_idx').on(t.projectId),
])

// ── agent_connection ──────────────────────────────────────────────────────────

export const agentConnections = pgTable('agent_connection', {
  id: uuidPk(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  accessTokenId: text('access_token_id'), // FK → oauth_access_token (added in F4)
  machineLabel: text('machine_label'),
  model: text('model'),
  repo: text('repo'),
  branch: text('branch'),
  status: text('status').notNull().default('connected'), // connected | expired | revoked
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, t => [
  index('agent_connection_agent_idx').on(t.agentId),
  index('agent_connection_status_idx').on(t.status),
])

// ── agent_snapshot ────────────────────────────────────────────────────────────

export const agentSnapshots = pgTable('agent_snapshot', {
  id: uuidPk(),
  agentId: uuid('agent_id')
    .notNull()
    .unique()
    .references(() => agents.id, { onDelete: 'cascade' }),
  repo: text('repo'),
  branch: text('branch'),
  files: jsonb('files').$type<Record<string, string>>().notNull().default({}),
  memory: text('memory'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

// ── thread ────────────────────────────────────────────────────────────────────

export const threads = pgTable('thread', {
  id: uuidPk(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  status: text('status').notNull().default('open'), // open | answered | closed | holding | canceled
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdByAgentId: uuid('created_by_agent_id')
    .references(() => agents.id, { onDelete: 'set null' }),
  createdByUserId: text('created_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  index('thread_project_status_idx').on(t.projectId, t.status),
  index('thread_created_at_idx').on(t.createdAt),
])

// ── message ───────────────────────────────────────────────────────────────────

export const messages = pgTable('message', {
  id: uuidPk(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  fromAgentId: uuid('from_agent_id')
    .references(() => agents.id, { onDelete: 'set null' }),
  fromUserId: text('from_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  urgent: boolean('urgent').notNull().default(false),
  recipientCount: integer('recipient_count').notNull().default(1), // 비정규화 fan-out 폭(원장 정합/감사용)
  createdAt: createdAt(),
}, t => [
  index('message_thread_created_idx').on(t.threadId, t.createdAt),
])

// ── message_recipient ─────────────────────────────────────────────────────────

export const messageRecipients = pgTable('message_recipient', {
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  required: boolean('required').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.messageId, t.agentId] }),
  index('message_recipient_agent_read_idx').on(t.agentId, t.readAt),
])

// ── event ─────────────────────────────────────────────────────────────────────

export const events = pgTable('event', {
  id: uuidPk(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .references(() => agents.id, { onDelete: 'set null' }),
  type: text('type').notNull(), // spawn | progress | complete | error | message
  parentEventId: uuid('parent_event_id'), // self-ref, FK added below via migration
  spawnedAgentLabel: text('spawned_agent_label'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  usage: jsonb('usage').$type<{
    input_tokens?: number
    output_tokens?: number
    cache_tokens?: number
    model?: string
    cost_usd?: number
  }>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  index('event_project_created_idx').on(t.projectId, t.createdAt),
  index('event_agent_idx').on(t.agentId),
  index('event_parent_idx').on(t.parentEventId),
])

// ── configuration ─────────────────────────────────────────────────────────────

export const configurations = pgTable('configuration', {
  id: uuidPk(),
  scope: text('scope').notNull(), // global | organization | project
  scopeId: uuid('scope_id'), // null for global
  key: text('key').notNull(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
  updatedByUserId: text('updated_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
}, t => [
  uniqueIndex('configuration_scope_key').on(t.scope, t.scopeId, t.key),
])

// ── owner_wake_budget ──────────────────────────────────────────────────────────
// Per-owner-principal wake allowance. The hard ceiling is the owner total across
// ALL parts/projects. Defaults (spec 15.1): 30 wakes/hr, 5 urgent/hr.
export const ownerWakeBudgets = pgTable('owner_wake_budget', {
  userId: text('user_id').primaryKey()
    .references(() => better_auth_user.id, { onDelete: 'cascade' }),
  wakesPerHour: integer('wakes_per_hour').notNull().default(30),
  urgentPerHour: integer('urgent_per_hour').notNull().default(5),
  updatedAt: updatedAt(),
})

// ── wake_intent ─────────────────────────────────────────────────────────────────
// The authoritative wake state machine + budget reservation, per part.
// INVARIANT: at most ONE active (non-terminal) row per agent (coalescing).
export const wakeIntents = pgTable('wake_intent', {
  id: uuidPk(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').references(() => better_auth_user.id, { onDelete: 'set null' }),
  // idle is implicit (no row). States: pending | delivered | activated | done | expired | canceled
  state: text('state').notNull().default('pending'),
  epoch: integer('epoch').notNull(), // activation epoch this wake targets (fencing vs stale activation)
  wakeId: uuid('wake_id').notNull().default(sql`uuidv7()`), // fencing token handed to the pager
  urgent: boolean('urgent').notNull().default(false),
  reason: text('reason'), // e.g. "message", "catchup"
  // single-pager lease (replaces the local-only lock; spec §6)
  leaseHolder: text('lease_holder'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  reservedAt: createdAt(),         // budget reserved at issuance (control counter timestamp)
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),  // on activation
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // reserve refund deadline (10m)
}, t => [
  // Coalescing invariant: one active wake per agent. Partial unique on non-terminal states.
  uniqueIndex('wake_intent_agent_active')
    .on(t.agentId)
    .where(sql`state in ('pending','delivered','activated')`),
  index('wake_intent_owner_reserved_idx').on(t.ownerUserId, t.reservedAt),
  index('wake_intent_state_expires_idx').on(t.state, t.expiresAt),
])

// ── wake_event ──────────────────────────────────────────────────────────────────
// One row per settled wake. Feeds the audit view, governance detection, and the
// control/ledger reconciliation (compared against events.usage = the real ledger).
export const wakeEvents = pgTable('wake_event', {
  id: uuidPk(),
  ownerUserId: text('owner_user_id').references(() => better_auth_user.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  wakeIntentId: uuid('wake_intent_id'),
  senderPart: text('sender_part'),       // who triggered it (for audit/detection)
  senderUserId: text('sender_user_id'),  // stable principal of the sender
  urgent: boolean('urgent').notNull().default(false),
  suppressed: boolean('suppressed').notNull().default(false), // true = budget-exhausted, no nudge fired
  phantom: boolean('phantom').notNull().default(false),       // true = real turn seen w/o matching issued wake
  // Provenance tag for governance detection (phase 08). Free-form, nullable for
  // legacy rows. Known values: 'message' | 'reply' | 'direct_cooldown' |
  // 'loop_breaker' | 'limited'. loop_breaker rows are suppressed=true control rows written by
  // the pipeline when the in-memory loop-breaker trips, so 08 can aggregate trips
  // on the STABLE principal (senderUserId) without a separate table.
  reason: text('reason'),
  createdAt: createdAt(),
}, t => [
  index('wake_event_owner_created_idx').on(t.ownerUserId, t.createdAt),
  index('wake_event_sender_created_idx').on(t.senderUserId, t.createdAt),
  index('wake_event_project_sender_created_idx').on(t.projectId, t.senderUserId, t.createdAt),
])

// ── governance_alert ────────────────────────────────────────────────────────────
export const governanceAlerts = pgTable('governance_alert', {
  id: uuidPk(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  subjectUserId: text('subject_user_id') // the member whose agents tripped the detector
    .references(() => better_auth_user.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // loop_breaker | phantom_turns | broadcast_spike | budget_drain
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, t => [
  index('governance_alert_project_created_idx').on(t.projectId, t.createdAt),
  // At most one OPEN alert per (project, subject, kind) - dedup hardening (phase 08).
  uniqueIndex('governance_alert_open_uniq')
    .on(t.projectId, t.subjectUserId, t.kind)
    .where(sql`${t.resolvedAt} is null`),
])

// ── direct_cooldown ─────────────────────────────────────────────────────────────
// width-1 핑퐁 차단용 (발신 part -> 수신 part) 쿨다운(phase 06, spec §7/§15.1). lastAt
// 이후 30초 내 재발신은 wake 억제(메시지 전달은 유지). reserve와 같은 tx에서 원자적
// 검사/갱신해 레이스 없음. DB-backed라 서버 재시작에도 핑퐁 차단이 유지된다.
export const directCooldowns = pgTable('direct_cooldown', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  senderAgentId: uuid('sender_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  recipientAgentId: uuid('recipient_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.senderAgentId, t.recipientAgentId] }),
  index('direct_cooldown_last_idx').on(t.lastAt),
])

// ── governance_audit ────────────────────────────────────────────────────────────
// Append-only log of governance actions (ban / unban). Survives unban: the
// project_access.bannedAt toggle is current-state, this table is the history
// (who did what, to whom, with what side effects). Spec §10.6. Added as an
// addendum migration in phase 09 (not a retro-edit of 01).
export const governanceAudits = pgTable('governance_audit', {
  id: uuidPk(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  orgId: text('org_id'),
  action: text('action').notNull(),                  // ban | unban
  scope: text('scope').notNull().default('project'), // project | org
  subjectUserId: text('subject_user_id')             // who was banned / unbanned
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  actorUserId: text('actor_user_id')                 // who performed the action
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  // { revokedConnections, canceledWakes, refundedWakes } for ban, {} for unban.
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [
  index('governance_audit_project_created_idx').on(t.projectId, t.createdAt),
])

// ── project knowledge (0.5.0 L0) ─────────────────────────────────────────────
// What a project has learned, kept apart from the conversation it came from.
// Threads are a record of what was said; these tables are the distilled claims an
// agent should read BEFORE acting, plus the ledger that says why each one is
// trusted. The split matters: `knowledge` is current state, `knowledge_validation`
// is the evidence, `knowledge_audit` is the history. A bare trusted flag would
// answer "is it trusted" but never "who decided that, and on what".
//
// L0 ships the substrate with a human owner as the only promoter. The tables for
// CI attestation (check map, nonces) and the metrics rollup land with the features
// that write them, so unused schema does not set first.

export const knowledge = pgTable('knowledge', {
  id: uuidPk(),
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),               // fact | convention | pitfall | decision
  title: text('title').notNull(),
  body: text('body').notNull(),
  sourceKind: text('source_kind').notNull(),  // thread | event | human | learn | proposer
  // Where the claim came from, so an operator can trace it back and purge
  // everything derived from one thread.
  sourceRefs: jsonb('source_refs').$type<{ threadId?: string; eventId?: string; messageId?: string }[]>()
    .notNull().default(sql`'[]'::jsonb`),
  confidence: real('confidence').notNull().default(0), // derived cache, written by the verifier
  validationState: text('validation_state').notNull().default('candidate'), // candidate|trusted|contradicted|retired
  promotedAt: timestamp('promoted_at', { withTimezone: true }), // set on candidate->trusted, kept on demote
  supersededById: uuid('superseded_by_id'),   // self-ref, FK added below via migration
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  index('knowledge_project_state_idx').on(t.projectId, t.validationState),
  index('knowledge_project_kind_idx').on(t.projectId, t.kind),
  // Not redundant with the primary key: a composite FK can only reference a unique
  // constraint, and L1's check map uses (project_id, id) so a mapping can never
  // point at another project's row. Created now because adding it later is a
  // second migration for no reason.
  uniqueIndex('knowledge_project_id_uq').on(t.projectId, t.id),
  check('knowledge_kind_ck', sql`${t.kind} in ('fact','convention','pitfall','decision')`),
  check('knowledge_state_ck', sql`${t.validationState} in ('candidate','trusted','contradicted','retired')`),
])

// ── knowledge_validation ─────────────────────────────────────────────────────
// The evidence behind a claim's state. Written by the verifier (a human confirm in
// L0, CI attestation in L1) and by the contradiction path; agents never write here,
// which is what keeps an agent from promoting its own guess.
export const knowledgeValidations = pgTable('knowledge_validation', {
  id: uuidPk(),
  knowledgeId: uuid('knowledge_id').notNull()
    .references(() => knowledge.id, { onDelete: 'cascade' }),
  signal: text('signal').notNull(),      // support | contradict
  issuer: text('issuer').notNull(),      // ci_attest | human | error_event
  // Identity that promotion counts DISTINCT over: a userId for human, the project's
  // CI issuer id for ci_attest, 'error' for error_event. The whole CI system shares
  // one issuer by default, so a hundred green runs still count as one voice.
  issuerId: text('issuer_id').notNull(),
  sourceRef: jsonb('source_ref').$type<{ runId?: string; userId?: string; eventId?: string }>()
    .notNull().default(sql`'{}'::jsonb`),
  // false for an attestation with no check mapping: recorded as history, never
  // counted toward promotion.
  counted: boolean('counted').notNull().default(true),
  sourceFingerprint: text('source_fingerprint').notNull(), // stable hash of issuer+sourceRef
  weight: real('weight').notNull().default(1),
  createdAt: createdAt(),
}, t => [
  index('knowledge_validation_knowledge_idx').on(t.knowledgeId),
  // Independence, enforced in the schema rather than in the counting query: one
  // issuer-source can support a claim once. Re-running the same CI job cannot
  // manufacture agreement.
  uniqueIndex('knowledge_validation_dedup').on(t.knowledgeId, t.signal, t.sourceFingerprint),
  check('knowledge_validation_signal_ck', sql`${t.signal} in ('support','contradict')`),
  check('knowledge_validation_issuer_ck', sql`${t.issuer} in ('ci_attest','human','error_event')`),
])

// ── knowledge_audit ──────────────────────────────────────────────────────────
// Append-only history of knowledge state changes. governance_audit is ban/unban
// only and cannot carry these, and a state column alone loses the transition:
// from_state/to_state is what makes "this was promoted, then contradicted" legible
// after the fact.
export const knowledgeAudits = pgTable('knowledge_audit', {
  id: uuidPk(),
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  // promote | demote | retire | playbook_change | attest_secret_rotate |
  // proposer_approve | proposer_reject | check_map_change
  action: text('action').notNull(),
  knowledgeId: uuid('knowledge_id').references(() => knowledge.id, { onDelete: 'set null' }),
  fromState: text('from_state'),
  toState: text('to_state'),
  actorKind: text('actor_kind').notNull(),  // human | ci | system
  actorUserId: text('actor_user_id')        // null unless actorKind = 'human'
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [
  index('knowledge_audit_project_created_idx').on(t.projectId, t.createdAt),
  index('knowledge_audit_knowledge_idx').on(t.knowledgeId),
  check('knowledge_audit_actor_ck', sql`${t.actorKind} in ('human','ci','system')`),
])

// ── recall_log ───────────────────────────────────────────────────────────────
// What was retrieved and what was actually used, which is the only way to tell
// whether recall is helping. `usedKnowledgeId` is a self-contained FK to knowledge
// added in the migration (same reason as supersededById).
export const recallLogs = pgTable('recall_log', {
  id: uuidPk(),
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  queryHash: text('query_hash'),
  returnedKnowledgeIds: jsonb('returned_knowledge_ids').$type<string[]>()
    .notNull().default(sql`'[]'::jsonb`),
  usedKnowledgeId: uuid('used_knowledge_id'), // FK added below via migration
  createdAt: createdAt(),
}, t => [
  index('recall_log_project_created_idx').on(t.projectId, t.createdAt),
])

// ── knowledge_check_map (L1) ───────────────────────────────────────────────────
// Which CI check is allowed to attest which claim. An attestation only counts
// toward promotion when a row here maps its check_name to the knowledge it names;
// an unmapped attestation is still recorded, but written `counted=false`. This is
// what stops a project pointing any green check at any claim it likes: a manager
// (project owner) writes these rows, never an agent.
export const knowledgeCheckMap = pgTable('knowledge_check_map', {
  id: uuidPk(),
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  checkName: text('check_name').notNull(),   // e.g. "migration-smoke"
  // No standalone FK to knowledge on purpose. A plain knowledge_id FK would let a
  // project map its check onto ANOTHER project's claim, since it only checks that
  // the id exists somewhere. The migration instead adds a COMPOSITE FK on
  // (project_id, knowledge_id) -> knowledge(project_id, id), so the mapped claim
  // must belong to the same project. That is the L1 tenant boundary.
  knowledgeId: uuid('knowledge_id').notNull(),
  createdByUserId: text('created_by_user_id')
    .references(() => better_auth_user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [
  // Both key columns are NOT NULL, so this unique index is sound (no null-skips).
  uniqueIndex('knowledge_check_map_uq').on(t.projectId, t.checkName, t.knowledgeId),
])

// ── knowledge_nonce (L1) ───────────────────────────────────────────────────────
// Replay defense for attestation. Each accepted attest body carries a nonce; a
// (project_id, nonce) already present means the same signed request is being
// replayed, and it is rejected. Old nonces are swept once they are older than the
// maximum clock skew the endpoint tolerates.
export const knowledgeNonces = pgTable('knowledge_nonce', {
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.projectId, t.nonce] }),
])

// ── knowledge_metric_daily (L2) ────────────────────────────────────────────────
// One row per project per UTC day: the compounding metrics the Learning panel
// shows. The server's rollup job writes these; nothing here computes them.
//
// Two decisions are load-bearing and both come from the design's honesty rules:
//   - Raw numerator AND denominator are stored, never just the ratio. A ratio
//     alone cannot be re-aggregated (you cannot average yesterday's and today's
//     rates to get the two-day rate) and it hides sample size - and the panel
//     must render "not enough data" below a threshold, which needs the count.
//   - normalizationVersion travels with every row, so a later change to how a
//     metric is DEFINED is visible as a break in the series instead of silently
//     rewriting history. It is not a computed value; it labels which definition
//     produced these counts.
// The per-metric windows (repeat_error's 7-day lookback, precision's 14-day
// lookahead) are the rollup's concern, not the schema's: a row holds only that
// day's raw counts. Every count is nullable - a metric with no denominator that
// day is null, which the panel reads as "no data", distinct from a real zero.
export const knowledgeMetricDaily = pgTable('knowledge_metric_daily', {
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),                                   // the UTC day these counts cover
  normalizationVersion: integer('normalization_version').notNull().default(1),
  // repeat_error_rate: error events whose signature already appeared in the prior 7 days.
  repeatErrorNum: integer('repeat_error_num'),
  repeatErrorDen: integer('repeat_error_den'),
  // recall_hit_rate: recall_log rows where usedKnowledgeId is set.
  recallHitNum: integer('recall_hit_num'),
  recallHitDen: integer('recall_hit_den'),
  // knowledge_precision: trusted entries contradicted within 14d of promotion.
  precisionNum: integer('precision_num'),
  precisionDen: integer('precision_den'),
  candidateToTrustedP50Hours: real('candidate_to_trusted_p50_hours'),
  trustedCount: integer('trusted_count'),
  candidateCount: integer('candidate_count'),
}, t => [
  primaryKey({ columns: [t.projectId, t.day] }),
])
