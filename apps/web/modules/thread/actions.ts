"use server"

import { and, eq, isNull, sql } from "drizzle-orm"
import type { ApiResult, ApiResultWithItem } from "@relayroom/shared"
import { NEEDS_HUMAN_TAG } from "@relayroom/shared"
import {
  postMessageSchema,
  type PostMessageInput,
  closeThreadSchema,
  type CloseThreadInput,
  addTagsSchema,
  type AddTagsInput,
  dismissAttentionSchema,
  type DismissAttentionInput,
} from "./schema"
import { db } from "@/modules/drizzle/db"
import { threads, messages, messageRecipients, projects, agents } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"
import { getServerSession } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getErrorTranslations } from "@/lib/action-i18n"

// ── Helpers ───────────────────────────────────────────────────────────────────

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>

async function requireOrgAccess(): Promise<
  | { ok: true; session: Session; orgId: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }

  const orgId = await resolveActiveOrgId()
  if (!orgId) return { ok: false, message: t("auth.orgRequired") }

  const [member] = await db
    .select({ id: better_auth_member.id })
    .from(better_auth_member)
    .where(
      and(
        eq(better_auth_member.organizationId, orgId),
        eq(better_auth_member.userId, session.user.id),
      ),
    )
    .limit(1)

  if (!member) return { ok: false, message: t("auth.noOrgAccess") }

  return { ok: true, session, orgId }
}

/**
 * Verify that a thread belongs to a project in the caller's org.
 * Returns the thread row on success, or an error result.
 *
 * SECURITY: This is the IDOR guard for all thread mutations. We join
 * threads -> projects and check projects.organization_id === caller's orgId.
 * A thread id from another org will fail here before any mutation runs.
 */
async function requireThreadInOrg(
  threadId: string,
  orgId: string,
): Promise<
  | { ok: true; thread: { id: string; projectId: string; status: string } }
  | { ok: false; message: string }
> {
  const [row] = await db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      status: threads.status,
    })
    .from(threads)
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .where(
      and(
        eq(threads.id, threadId),
        eq(projects.organizationId, orgId),
      ),
    )
    .limit(1)

  if (!row) {
    const t = await getErrorTranslations()
    return { ok: false, message: t("thread.notFound") }
  }
  return { ok: true, thread: row }
}

// ── postMessage ───────────────────────────────────────────────────────────────

export async function postMessage(
  input: PostMessageInput,
): Promise<ApiResultWithItem<{ id: string }>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    const parsed = postMessageSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { threadId, body, targetAgentIds } = parsed.data

    // IDOR guard: verify thread belongs to caller's org
    const threadCheck = await requireThreadInOrg(threadId, orgId)
    if (!threadCheck.ok) return { result: false, message: threadCheck.message }

    const thread = threadCheck.thread

    // Prevent posting to closed/canceled threads
    if (thread.status === "closed" || thread.status === "canceled") {
      return { result: false, message: t("thread.closed") }
    }

    // Insert message (human posts as 'user')
    const [msg] = await db
      .insert(messages)
      .values({
        threadId,
        fromUserId: session.user.id,
        body,
      })
      .returning({ id: messages.id })

    if (!msg) return { result: false, message: t("thread.messageFailed") }

    // Insert message_recipient rows for target agents if specified
    if (targetAgentIds && targetAgentIds.length > 0) {
      // Verify each agent belongs to the same project (security)
      const validAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.projectId, thread.projectId),
          ),
        )
      const validIds = new Set(validAgents.map((a) => a.id))
      const safeTargets = targetAgentIds.filter((id) => validIds.has(id))

      if (safeTargets.length > 0) {
        await db.insert(messageRecipients).values(
          safeTargets.map((agentId) => ({
            messageId: msg.id,
            agentId,
            required: false,
          })),
        )
      }
    }

    // Bump updated_at for ordering AND clear the human-attention flag: a human
    // replying IS the human handling the escalation, so the bell should drop.
    // array_remove is a no-op when the tag is absent.
    await db
      .update(threads)
      .set({
        updatedAt: new Date(),
        tags: sql`array_remove(${threads.tags}, ${NEEDS_HUMAN_TAG})`,
      })
      .where(eq(threads.id, threadId))

    return { result: true, item: { id: msg.id } }
  } catch (err) {
    console.error("[postMessage]", err)
    return { result: false, message: t("thread.postFailed") }
  }
}

// ── closeThread ───────────────────────────────────────────────────────────────

export async function closeThread(input: CloseThreadInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = closeThreadSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { threadId, status } = parsed.data

    // IDOR guard: join threads -> projects -> org check
    const [row] = await db
      .update(threads)
      .set({ status, updatedAt: new Date() })
      .from(projects)
      .where(
        and(
          eq(threads.id, threadId),
          eq(threads.projectId, projects.id),
          eq(projects.organizationId, orgId),
        ),
      )
      .returning({ id: threads.id })

    if (!row) return { result: false, message: t("thread.notFound") }

    // Mirror the MCP `close` tool: a closed/canceled thread's unread must be cleared
    // so no wake path keeps pinging its participants for a resolved conversation.
    if (status === "closed" || status === "canceled") {
      await db
        .update(messageRecipients)
        .set({ readAt: new Date() })
        .where(
          and(
            isNull(messageRecipients.readAt),
            sql`${messageRecipients.messageId} in (select id from ${messages} where thread_id = ${threadId})`,
          ),
        )
    }

    return { result: true }
  } catch (err) {
    console.error("[closeThread]", err)
    return { result: false, message: t("thread.closeFailed") }
  }
}

// ── addTags ───────────────────────────────────────────────────────────────────

export async function addTags(input: AddTagsInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = addTagsSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { threadId, tags } = parsed.data

    // IDOR guard: verify thread in org
    const threadCheck = await requireThreadInOrg(threadId, orgId)
    if (!threadCheck.ok) return { result: false, message: threadCheck.message }

    // Merge new tags with existing, deduplicate
    // Merge atomically in ONE update (union + dedup in SQL), not read-modify-write:
    // two concurrent addTags previously raced and could drop each other's tags.
    const updated = await db
      .update(threads)
      .set({
        tags: sql`(SELECT coalesce(array_agg(DISTINCT t), '{}') FROM unnest(coalesce(${threads.tags}, '{}') || ${tags}::text[]) AS t)`,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, threadId))
      .returning({ id: threads.id })

    if (!updated.length) return { result: false, message: t("thread.missing") }

    return { result: true }
  } catch (err) {
    console.error("[addTags]", err)
    return { result: false, message: t("thread.addTagsFailed") }
  }
}

// ── dismissAttention ────────────────────────────────────────────────────────

/**
 * Manually clear the `needs-human` flag on a thread (the operator acknowledges
 * the escalation without replying). Removes only that tag; leaves the thread
 * otherwise untouched so the agents' conversation continues.
 */
export async function dismissAttention(
  input: DismissAttentionInput,
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = dismissAttentionSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { threadId } = parsed.data

    // IDOR guard: verify thread in org
    const threadCheck = await requireThreadInOrg(threadId, orgId)
    if (!threadCheck.ok) return { result: false, message: threadCheck.message }

    await db
      .update(threads)
      .set({ tags: sql`array_remove(${threads.tags}, ${NEEDS_HUMAN_TAG})` })
      .where(eq(threads.id, threadId))

    return { result: true }
  } catch (err) {
    console.error("[dismissAttention]", err)
    return { result: false, message: t("thread.dismissFailed") }
  }
}
