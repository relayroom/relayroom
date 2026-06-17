import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { threads, messages, agents, messageRecipients } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { stripMarkdown } from "@/lib/format"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ThreadRow {
  id: string
  projectId: string
  subject: string
  status: string
  tags: string[]
  createdAt: Date
  updatedAt: Date
  messageCount: number
  lastMessageAt: Date | null
  lastMessagePreview: string | null
  /** Author of the latest message: which agent + its owner + main-ness, for list rows. */
  authorAgentId: string | null
  authorAgentPart: string | null
  authorAgentRole: string | null
  authorOwnerName: string | null
}

export interface ThreadFilter {
  status?: string
  q?: string
  /** Restrict to threads this agent authored a message in. */
  agentId?: string
  page?: number
  limit?: number
}

export interface ReadReceipt {
  agentId: string
  agentPart: string
  agentNickname: string | null
  readAt: Date
}

export interface MessageDetail {
  id: string
  body: string
  fromAgentId: string | null
  fromAgentPart: string | null
  fromAgentNickname: string | null
  fromUserId: string | null
  fromUserName: string | null
  createdAt: Date
  readReceipts: ReadReceipt[]
  // The parts this message was addressed to (its target audience).
  recipients: Array<{
    agentId: string
    part: string
    nickname: string | null
    color: string | null
  }>
}

export interface ThreadDetail {
  id: string
  projectId: string
  subject: string
  status: string
  tags: string[]
  createdByAgentId: string | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
  messages: MessageDetail[]
  targetAgents: Array<{ id: string; part: string; nickname: string | null; badge: string | null }>
}

const THREAD_STATUSES = ["open", "answered", "closed", "holding", "canceled"] as const

// ── listThreads ───────────────────────────────────────────────────────────────

export async function listThreads(
  projectId: string,
  filter: ThreadFilter = {},
): Promise<ApiResultWithItems<ThreadRow>> {
  try {
    const page = Math.max(1, filter.page ?? 1)
    const limit = Math.max(1, Math.min(100, filter.limit ?? 30))
    const offset = (page - 1) * limit

    const conditions = [eq(threads.projectId, projectId)]

    if (filter.status && THREAD_STATUSES.includes(filter.status as typeof THREAD_STATUSES[number])) {
      conditions.push(eq(threads.status, filter.status))
    }

    const q = filter.q?.trim()
    if (q) {
      conditions.push(ilike(threads.subject, `%${q}%`))
    }

    if (filter.agentId) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM message m WHERE m.thread_id = ${threads.id} AND m.from_agent_id = ${filter.agentId})`,
      )
    }

    const where = and(...conditions)

    const [{ totalCount }] = await db
      .select({ totalCount: sql<number>`count(*)::int` })
      .from(threads)
      .where(where)

    const rows = await db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        subject: threads.subject,
        status: threads.status,
        tags: threads.tags,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
      .where(where)
      .orderBy(desc(threads.updatedAt))
      .limit(limit)
      .offset(offset)

    // Fetch message counts and last message preview per thread
    const threadIds = rows.map((r) => r.id)
    const countMap = new Map<string, number>()
    const lastMsgMap = new Map<
      string,
      {
        body: string
        createdAt: Date
        agentId: string | null
        agentPart: string | null
        agentRole: string | null
        ownerName: string | null
      }
    >()

    if (threadIds.length > 0) {
      const msgCounts = await db
        .select({
          threadId: messages.threadId,
          msgCount: sql<number>`count(*)::int`,
        })
        .from(messages)
        .where(inArray(messages.threadId, threadIds))
        .groupBy(messages.threadId)

      for (const mc of msgCounts) {
        countMap.set(mc.threadId, Number(mc.msgCount))
      }

      // Last message per thread, with its author agent (part/role/owner).
      for (const tid of threadIds) {
        const [last] = await db
          .select({
            body: messages.body,
            createdAt: messages.createdAt,
            agentId: messages.fromAgentId,
            agentPart: agents.part,
            agentRole: agents.role,
            ownerName: sql<string | null>`coalesce(nullif(${better_auth_user.nickname}, ''), ${better_auth_user.name})`,
          })
          .from(messages)
          .leftJoin(agents, eq(messages.fromAgentId, agents.id))
          .leftJoin(better_auth_user, eq(agents.ownerUserId, better_auth_user.id))
          .where(eq(messages.threadId, tid))
          .orderBy(desc(messages.createdAt))
          .limit(1)
        if (last) lastMsgMap.set(tid, last)
      }
    }

    const items: ThreadRow[] = rows.map((r) => {
      const lastMsg = lastMsgMap.get(r.id)
      return {
        ...r,
        messageCount: countMap.get(r.id) ?? 0,
        lastMessageAt: lastMsg?.createdAt ?? null,
        lastMessagePreview: lastMsg ? stripMarkdown(lastMsg.body.slice(0, 500)).slice(0, 160) : null,
        authorAgentId: lastMsg?.agentId ?? null,
        authorAgentPart: lastMsg?.agentPart ?? null,
        authorAgentRole: lastMsg?.agentRole ?? null,
        authorOwnerName: lastMsg?.ownerName ?? null,
      }
    })

    return { result: true, totalCount: Number(totalCount), items }
  } catch (err) {
    console.error("[listThreads]", err)
    return { result: false, message: "스레드 목록을 불러오는 데 실패했습니다." }
  }
}

// ── getThread ─────────────────────────────────────────────────────────────────

export async function getThread(
  projectId: string,
  threadId: string,
): Promise<ApiResultWithItem<ThreadDetail>> {
  try {
    // Fetch thread, scoped to projectId for security
    const [thread] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.projectId, projectId)))
      .limit(1)

    if (!thread) return { result: false, message: "스레드를 찾을 수 없습니다." }

    // Fetch messages in chronological order
    const msgs = await db
      .select({
        id: messages.id,
        body: messages.body,
        fromAgentId: messages.fromAgentId,
        fromUserId: messages.fromUserId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt))

    if (msgs.length === 0) {
      return {
        result: true,
        item: {
          id: thread.id,
          projectId: thread.projectId,
          subject: thread.subject,
          status: thread.status,
          tags: thread.tags,
          createdByAgentId: thread.createdByAgentId,
          createdByUserId: thread.createdByUserId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: [],
          targetAgents: [],
        },
      }
    }

    // Fetch agent info for agent-authored messages
    const agentIds = [...new Set(msgs.map((m) => m.fromAgentId).filter(Boolean) as string[])]
    const agentMap = new Map<string, { part: string; nickname: string | null }>()
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, part: agents.part, nickname: agents.nickname })
        .from(agents)
        .where(inArray(agents.id, agentIds))
      for (const a of agentRows) agentMap.set(a.id, { part: a.part, nickname: a.nickname })
    }

    // Fetch user info for user-authored messages
    const userIds = [...new Set(msgs.map((m) => m.fromUserId).filter(Boolean) as string[])]
    const userMap = new Map<string, string>()
    if (userIds.length > 0) {
      const userRows = await db
        .select({ id: better_auth_user.id, name: better_auth_user.name })
        .from(better_auth_user)
        .where(inArray(better_auth_user.id, userIds))
      for (const u of userRows) userMap.set(u.id, u.name)
    }

    // Fetch read receipts for all messages
    const messageIds = msgs.map((m) => m.id)
    const receipts = await db
      .select({
        messageId: messageRecipients.messageId,
        agentId: messageRecipients.agentId,
        readAt: messageRecipients.readAt,
        agentPart: agents.part,
        agentNickname: agents.nickname,
      })
      .from(messageRecipients)
      .innerJoin(agents, eq(messageRecipients.agentId, agents.id))
      .where(
        and(
          inArray(messageRecipients.messageId, messageIds),
          sql`${messageRecipients.readAt} is not null`,
        ),
      )

    const receiptMap = new Map<string, ReadReceipt[]>()
    for (const r of receipts) {
      if (!r.readAt) continue
      const list = receiptMap.get(r.messageId) ?? []
      list.push({
        agentId: r.agentId,
        agentPart: r.agentPart,
        agentNickname: r.agentNickname,
        readAt: r.readAt,
      })
      receiptMap.set(r.messageId, list)
    }

    // Fetch the target audience (recipients) of every message, with display info.
    // One pass builds both the per-message list (for the "To" badges) and the
    // thread-wide distinct set (targetAgents) - no extra round-trip.
    const recipientRows = await db
      .select({
        messageId: messageRecipients.messageId,
        agentId: messageRecipients.agentId,
        part: agents.part,
        nickname: agents.nickname,
        color: agents.color,
        badge: agents.badge,
      })
      .from(messageRecipients)
      .innerJoin(agents, eq(messageRecipients.agentId, agents.id))
      .where(inArray(messageRecipients.messageId, messageIds))
      .orderBy(asc(agents.part))

    const recipientsByMessage = new Map<string, MessageDetail["recipients"]>()
    const targetAgentMap = new Map<string, ThreadDetail["targetAgents"][number]>()
    for (const r of recipientRows) {
      const list = recipientsByMessage.get(r.messageId) ?? []
      list.push({ agentId: r.agentId, part: r.part, nickname: r.nickname, color: r.color })
      recipientsByMessage.set(r.messageId, list)
      if (!targetAgentMap.has(r.agentId)) {
        targetAgentMap.set(r.agentId, {
          id: r.agentId,
          part: r.part,
          nickname: r.nickname,
          badge: r.badge,
        })
      }
    }
    const targetAgents: ThreadDetail["targetAgents"] = [...targetAgentMap.values()]

    const messageDetails: MessageDetail[] = msgs.map((m) => {
      const agent = m.fromAgentId ? agentMap.get(m.fromAgentId) : undefined
      const userName = m.fromUserId ? userMap.get(m.fromUserId) : undefined
      return {
        id: m.id,
        body: m.body,
        fromAgentId: m.fromAgentId,
        fromAgentPart: agent?.part ?? null,
        fromAgentNickname: agent?.nickname ?? null,
        fromUserId: m.fromUserId,
        fromUserName: userName ?? null,
        createdAt: m.createdAt,
        readReceipts: receiptMap.get(m.id) ?? [],
        recipients: recipientsByMessage.get(m.id) ?? [],
      }
    })

    return {
      result: true,
      item: {
        id: thread.id,
        projectId: thread.projectId,
        subject: thread.subject,
        status: thread.status,
        tags: thread.tags,
        createdByAgentId: thread.createdByAgentId,
        createdByUserId: thread.createdByUserId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messages: messageDetails,
        targetAgents,
      },
    }
  } catch (err) {
    console.error("[getThread]", err)
    return { result: false, message: "스레드 정보를 불러오는 데 실패했습니다." }
  }
}
