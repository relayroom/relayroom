import { and, count, desc, eq, sql } from "drizzle-orm"
import type { ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { knowledge, knowledgeValidations } from "@relayroom/db/schema"
import { getErrorTranslations } from "@/lib/action-i18n"

// ── Types ─────────────────────────────────────────────────────────────────────

/** The four states a claim can be in. Mirrors the knowledge_state_ck constraint. */
export const KNOWLEDGE_STATES = ["candidate", "trusted", "contradicted", "retired"] as const
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number]

/** The four claim kinds. Mirrors the knowledge_kind_ck constraint. */
export const KNOWLEDGE_KINDS = ["fact", "convention", "pitfall", "decision"] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export function isKnowledgeState(v: string): v is KnowledgeState {
  return (KNOWLEDGE_STATES as readonly string[]).includes(v)
}

export interface KnowledgeRow {
  id: string
  kind: string
  title: string
  body: string
  sourceKind: string
  sourceRefs: { threadId?: string; eventId?: string; messageId?: string }[]
  confidence: number
  validationState: string
  promotedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  /**
   * Distinct issuers that have supported this claim and count toward promotion.
   * Shown so the list explains WHY something is (or is not) trusted, rather than
   * presenting the state as a bare label. Mirrors the promotion count in
   * 02-data-model: signal='support', counted=true, issuer in (ci_attest, human).
   */
  supportingIssuers: number
}

export interface KnowledgeFilter {
  /** Undefined means every state. */
  state?: KnowledgeState
  page?: number
  limit?: number
}

// ── listKnowledge ─────────────────────────────────────────────────────────────

/**
 * Knowledge for one project, newest first, optionally narrowed to one state.
 *
 * Scoped by projectId alone: the caller is already established by the project
 * layout, which proves org membership and rejects a project-scope ban before any
 * page under it renders. This mirrors listThreads/listEvents.
 */
export async function listKnowledge(
  projectId: string,
  filter: KnowledgeFilter = {},
): Promise<ApiResultWithItems<KnowledgeRow>> {
  const t = await getErrorTranslations()
  try {
    const page = Math.max(1, filter.page ?? 1)
    const limit = Math.min(100, Math.max(1, filter.limit ?? 30))
    const where = filter.state
      ? and(eq(knowledge.projectId, projectId), eq(knowledge.validationState, filter.state))
      : eq(knowledge.projectId, projectId)

    const [totalRow] = await db.select({ n: count() }).from(knowledge).where(where)

    const rows = await db
      .select({
        id: knowledge.id,
        kind: knowledge.kind,
        title: knowledge.title,
        body: knowledge.body,
        sourceKind: knowledge.sourceKind,
        sourceRefs: knowledge.sourceRefs,
        confidence: knowledge.confidence,
        validationState: knowledge.validationState,
        promotedAt: knowledge.promotedAt,
        expiresAt: knowledge.expiresAt,
        createdAt: knowledge.createdAt,
        // Counted the same way the promotion transaction counts it, so the number
        // on screen is the number that decides promotion - not a lookalike.
        //
        // Written with explicit qualification (`v.` and `knowledge.`) rather than
        // Drizzle column references: those render unqualified, so the correlation
        // came out as `where "knowledge_id" = "id"`, and since knowledge_validation
        // has its own `id` the inner scope won. That compares a row's knowledge_id
        // to its own id, matches nothing, and returns 0 for everything - no error,
        // just a plausible-looking zero everywhere.
        supportingIssuers: sql<number>`(
          select count(distinct v.issuer_id)::int
          from knowledge_validation v
          where v.knowledge_id = knowledge.id
            and v.signal = 'support'
            and v.counted = true
            and v.issuer in ('ci_attest', 'human')
        )`,
      })
      .from(knowledge)
      .where(where)
      .orderBy(desc(knowledge.createdAt))
      .limit(limit)
      .offset((page - 1) * limit)

    return {
      result: true,
      totalCount: Number(totalRow?.n ?? 0),
      items: rows.map((r) => ({ ...r, supportingIssuers: Number(r.supportingIssuers) })),
    }
  } catch (err) {
    console.error("[listKnowledge]", err)
    return { result: false, message: t("knowledge.listFailed") }
  }
}

// ── countKnowledgeByState ─────────────────────────────────────────────────────

/**
 * How many entries sit in each state, for the filter tabs.
 *
 * A separate query rather than a field on listKnowledge: the counts must span
 * every state regardless of which one is being viewed, so they cannot be derived
 * from a filtered, paginated page of rows.
 */
export async function countKnowledgeByState(
  projectId: string,
): Promise<Record<KnowledgeState, number>> {
  const empty: Record<KnowledgeState, number> = {
    candidate: 0,
    trusted: 0,
    contradicted: 0,
    retired: 0,
  }
  try {
    const rows = await db
      .select({ state: knowledge.validationState, n: count() })
      .from(knowledge)
      .where(eq(knowledge.projectId, projectId))
      .groupBy(knowledge.validationState)

    const out = { ...empty }
    for (const r of rows) {
      if (isKnowledgeState(r.state)) out[r.state] = Number(r.n)
    }
    return out
  } catch (err) {
    console.error("[countKnowledgeByState]", err)
    return empty
  }
}
