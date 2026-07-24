"use server"

import { purgeKnowledgeFromThread, type PurgeResult } from "@relayroom/db/knowledge"
import type { ApiResultWithItem } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
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
