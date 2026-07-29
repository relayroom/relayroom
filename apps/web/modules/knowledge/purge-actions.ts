"use server"

import { purgeKnowledgeFromThread, type PurgeResult } from "@relayroom/db/knowledge"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { searchProjectThreads, type PurgeableThread } from "@/modules/knowledge/purge-queries"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"

/**
 * Purge (or, with dryRun, count) the knowledge distilled from a thread.
 *
 * Sibling of promoteKnowledge, and wired the same way: this action checks owner
 * access from the session, then calls the shared @relayroom/db function on its
 * own db handle. There is no HTTP hop - promoteKnowledge already imports its core
 * function directly, and web never calls the server over HTTP for a user action.
 *
 * The preview and the delete are the SAME call with dryRun flipped, so the two
 * counts the dashboard shows cannot diverge from what a real purge would do. That
 * closes the "preview 3, delete 5" gap by construction rather than by keeping two
 * queries in step.
 */
export async function purgeThreadKnowledge(
  projectId: string,
  threadId: string,
  dryRun: boolean,
): Promise<ApiResultWithItem<PurgeResult>> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId) || !isUuid(threadId)) {
      return { result: false, message: t("knowledge.invalidTarget") }
    }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    // owner, not write - this deletes knowledge. The button is only rendered for
    // owners, but a Server Action is reachable without it, so this is the gate
    // that holds. The purge function also matches projectId internally, so it
    // cannot be aimed at another project's thread.
    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    const outcome = await purgeKnowledgeFromThread(db, projectId, threadId, { dryRun })
    return { result: true, item: outcome }
  } catch (err) {
    console.error("[purgeThreadKnowledge]", err)
    return { result: false, message: t("knowledge.purgeFailed") }
  }
}

/**
 * Find threads in a project by subject so the owner can purge one the default list
 * cannot offer - a thread whose knowledge was already purged has no citing entry
 * and so never appears there.
 *
 * Owner-gated exactly like the purge it feeds. This widens WHICH threads an owner
 * can reach, never WHO can reach them, and the gate is here rather than only on the
 * button because a Server Action is reachable without the UI. It also means this
 * cannot become a way for a non-owner to enumerate a project's thread subjects.
 */
export async function searchPurgeableThreads(
  projectId: string,
  query: string,
): Promise<ApiResultWithItems<PurgeableThread>> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId)) {
      return { result: false, message: t("knowledge.invalidTarget") }
    }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    const items = await searchProjectThreads(projectId, query)
    // totalCount is what was found, not a total across pages: the query is capped
    // at THREAD_SEARCH_LIMIT and there is no paging, so claiming a larger total
    // would promise a second page that does not exist. The UI tells the operator
    // to narrow the title instead.
    return { result: true, items, totalCount: items.length }
  } catch (err) {
    console.error("[searchPurgeableThreads]", err)
    return { result: false, message: t("knowledge.purgeFailed") }
  }
}
