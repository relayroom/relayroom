import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  level: text('level').notNull(), // readonly_all | readonly | write
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
  // 'loop_breaker'. loop_breaker rows are suppressed=true control rows written by
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
