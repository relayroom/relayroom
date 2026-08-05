import { and, count, desc, eq, inArray, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { knowledge, knowledgeValidations, threads } from "@relayroom/db/schema"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"

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

// ── getKnowledgeEntry ─────────────────────────────────────────────────────────

/**
 * One entry, for the detail view.
 *
 * Scoped by projectId as well as id, and that pairing is the access check rather
 * than a convenience: the id comes out of the URL, so querying by id alone would
 * serve any organisation's entry to anyone who could guess one. The project layout
 * has already proved membership of THIS project and nothing more.
 */
export async function getKnowledgeEntry(
  projectId: string,
  id: string,
): Promise<ApiResultWithItem<KnowledgeRow>> {
  const t = await getErrorTranslations()
  try {
    const [row] = await db
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
        // Same correlated count as the list, and it has to stay the same: two
        // renderings of "how well backed is this" that can disagree would make the
        // detail view look like a correction of the list.
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
      .where(and(eq(knowledge.id, id), eq(knowledge.projectId, projectId)))

    if (!row) return { result: false, message: t("knowledge.entryNotFound") }

    return { result: true, item: { ...row, supportingIssuers: Number(row.supportingIssuers) } }
  } catch (err) {
    console.error("[getKnowledgeEntry]", err)
    return { result: false, message: t("knowledge.listFailed") }
  }
}

// ── listSourceThreads ─────────────────────────────────────────────────────────

/**
 * A source thread named by an entry, and whether it can still be opened.
 *
 * `subject` is null when the thread is gone. The two cases are kept distinct all
 * the way to the screen because they call for different things from the reader: an
 * entry that never recorded a thread is complete as written, while one whose thread
 * has been removed is missing evidence it used to have.
 */
export interface SourceThread {
  threadId: string
  subject: string | null
}

/**
 * Resolve the thread ids on an entry to subjects, preserving order and duplicates.
 *
 * SCOPED BY PROJECT, and not only for tidiness. `source_refs` is JSONB written by
 * agents, so an id in it is a claim about what produced the entry, not a checked
 * reference - nothing in the column's type stops it naming a thread in another
 * organisation. Looking a subject up without the project filter would let that
 * claim print another tenant's thread title on this page. An id that does not
 * match within the project resolves to null, which reads the same as a deleted
 * thread and is the correct outcome for both: this project cannot show it.
 *
 * Takes the whole array rather than the first ref. Entries mostly have one source
 * today, but the column has always been a list, and reflection over several threads
 * is the case it was made a list for.
 */
export async function listSourceThreads(
  projectId: string,
  sourceRefs: { threadId?: string }[],
): Promise<SourceThread[]> {
  const ids = sourceRefs
    .map((r) => r?.threadId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)

  if (ids.length === 0) return []

  // Shape-checked before the query, because the column is a uuid: a ref holding a
  // non-uuid string makes Postgres reject the whole statement, so one malformed id
  // would take every other source on the entry down with it. Filtered out here, it
  // resolves to null on its own and the rest still resolve.
  const lookupIds = [...new Set(ids.filter(isUuid))]
  if (lookupIds.length === 0) return ids.map((threadId) => ({ threadId, subject: null }))

  try {
    const rows = await db
      .select({ id: threads.id, subject: threads.subject })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), inArray(threads.id, lookupIds)))

    const found = new Map(rows.map((r) => [r.id, r.subject]))
    return ids.map((threadId) => ({ threadId, subject: found.get(threadId) ?? null }))
  } catch (err) {
    // A failed lookup must not read as "this entry has no sources". Returning every
    // id unresolved keeps the refs visible and lets the screen say the thread cannot
    // be reached, which is true whether the row is gone or the query failed.
    console.error("[listSourceThreads]", err)
    return ids.map((threadId) => ({ threadId, subject: null }))
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
