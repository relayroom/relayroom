import { z } from 'zod'

// Canonical API response contract (ApiResult/ApiResultWithItem/ApiResultWithItems).
// All API returns (web modules, server actions, Hono server) use these.
export * from './api-types'

// Default RELAYROOM.md coordination playbook.
export * from './relayroom-md'

// Agent color presets (hex) + auto-resolver, shared with the web palette.
export * from './agent-colors'

// OAuth client identity for agent tokens - shared by the issuer (web) and the
// enforcer (server), which must not disagree on it.
export * from './oauth'

// ── Attention signal ─────────────────────────────────────────────────────────

/**
 * Thread tag that marks a thread as needing a human (an agent is blocked or has
 * an explicit question for the operator). This is the ONLY signal the dashboard
 * bell counts. It is set by an agent via the `send`/`reply` MCP tools
 * (needsHuman: true) and cleared automatically when a human replies to the
 * thread, or manually dismissed from the inbox. Ambient "open thread" counts
 * (agent-driven, self-closing) are shown separately and never light up the bell.
 */
export const NEEDS_HUMAN_TAG = 'needs-human'

// ── Domain enums (text + zod validation — no pgEnum) ─────────────────────────

export const threadStatus = z.enum(['open', 'answered', 'closed', 'holding', 'canceled'])
export type ThreadStatus = z.infer<typeof threadStatus>

export const eventType = z.enum(['spawn', 'progress', 'complete', 'error', 'message'])
export type EventType = z.infer<typeof eventType>

export const agentRole = z.enum(['main', 'default'])
export type AgentRole = z.infer<typeof agentRole>

/**
 * `project_access.level`. These are the grants the dashboard actually issues, and
 * `owner` is load-bearing: it decides who may manage a project's members, and the
 * last-owner guards (demote, remove, ban) count rows at this level.
 *
 * `readonly_all` used to be listed here and never existed anywhere else: no UI
 * option, no label, no migration, no write path.
 */
export const projectAccessLevel = z.enum(['readonly', 'write', 'owner'])
export type ProjectAccessLevel = z.infer<typeof projectAccessLevel>

export const connectionStatus = z.enum(['connected', 'expired', 'revoked'])
export type ConnectionStatus = z.infer<typeof connectionStatus>

// ── Usage (event.usage) ───────────────────────────────────────────────────────

export const eventUsage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_tokens: z.number().optional(),
  model: z.string().optional(),
  cost_usd: z.number().optional(),
})
export type EventUsage = z.infer<typeof eventUsage>

// ── Message bus inputs ────────────────────────────────────────────────────────

export const sendMessageInput = z.object({
  project: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
})
export type SendMessageInput = z.infer<typeof sendMessageInput>

export const replyInput = z.object({
  project: z.string().min(1),
  from: z.string().min(1),
  body: z.string().min(1),
  to: z.array(z.string().min(1)).optional(),
})
export type ReplyInput = z.infer<typeof replyInput>

export const ackInput = z.object({
  project: z.string().min(1),
  part: z.string().min(1),
})
export type AckInput = z.infer<typeof ackInput>

export const closeInput = z.object({
  project: z.string().min(1),
  status: z.enum(['answered', 'closed', 'holding', 'canceled']),
})
export type CloseInput = z.infer<typeof closeInput>

export const eventInput = z.object({
  project: z.string().min(1),
  part: z.string().min(1),
  type: eventType,
  detail: z.record(z.string(), z.unknown()).default({}),
  usage: eventUsage.optional(),
  parentEventId: z.string().optional(),
  spawnedAgentLabel: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
})
export type EventInput = z.infer<typeof eventInput>

export const inboxItem = z.object({
  messageId: z.string(),
  threadId: z.string(),
  threadSubject: z.string(),
  fromPart: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
})
export type InboxItem = z.infer<typeof inboxItem>

/** A new thread message / wake - drives live thread+event refresh on the dashboard. */
export type HubMessageEvent = {
  kind: 'message'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  part: string
  threadId: string
  messageId: string
  subject: string
  fromPart: string
  /** Fencing token for the issued wake (phase 05 fills, phase 07 pager consumes). */
  wakeId?: string
}

/** A pager liveness beat - drives the live online/offline satellite-dish indicator. */
export type HubPagerEvent = {
  kind: 'pager'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  /** The agent whose pager beat (used to key the dashboard indicator). */
  agentId: string
  part: string
  online: boolean
}

/** An agent marked a message read (ack) - drives live read-receipt refresh on the
 *  dashboard. A dedicated kind (not `message`) so pagers do NOT treat it as a wake. */
export type HubReadEvent = {
  kind: 'read'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  /** The part that read the message (the reader). */
  part: string
  /** The message that was read. */
  messageId: string
}

/** An agent started composing a reply to a thread - drives a transient live "typing"
 *  indicator. A dedicated kind (not `message`) so pagers do NOT treat it as a wake. */
export type HubComposingEvent = {
  kind: 'composing'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  /** The part that is composing. */
  part: string
  /** The thread the reply is being composed for. */
  threadId: string
}

/** An agent reported a provider rate-limit (or cleared one) - drives the live
 *  "limited until HH:MM" badge. A dedicated kind (not `message`) so pagers do NOT
 *  treat it as a wake. */
export type HubLimitedEvent = {
  kind: 'limited'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  /** The part that is (or is no longer) rate-limited. */
  part: string
  /** ISO timestamp the limit lifts, or null when the limit was cleared. */
  limitedUntil: string | null
}

export type HubBusEvent = HubMessageEvent | HubPagerEvent | HubReadEvent | HubComposingEvent | HubLimitedEvent
