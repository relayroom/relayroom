"use server"

import { decideProposal, rollbackPlaybook } from "@relayroom/db/knowledge"
import { and, eq } from "drizzle-orm"
import type { ApiResult } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { knowledgeProposals } from "@relayroom/db/schema"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"

/**
 * Approve or reject a proposer proposal.
 *
 * Sibling of promoteKnowledge / purgeThreadKnowledge: owner is checked from the
 * session, then the shared @relayroom/db function is called directly on the web
 * db handle. No HTTP.
 *
 * The load-bearing rule lives in decideProposal, not here: approving a KNOWLEDGE
 * proposal writes a `candidate`, never `trusted`. A human accepting a proposal is
 * saying "this is worth keeping", not "this fact is proven" - promotion still
 * goes through the K-issuer path. The UI copy has to carry that same distinction;
 * this action just refuses to be the thing that quietly promotes.
 */
export async function decideProposalAction(
  projectId: string,
  proposalId: string,
  decision: "approved" | "rejected",
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId) || !isUuid(proposalId)) {
      return { result: false, message: t("proposal.notFound") }
    }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    // owner-only: deciding proposals shapes the project's knowledge and playbook.
    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    // The proposal must belong to this project. decideProposal matches projectId
    // internally too, but resolving it here gives a clean not-found instead of a
    // caught mismatch (the same reasoning as the check-map tenant gate).
    const [row] = await db
      .select({ id: knowledgeProposals.id })
      .from(knowledgeProposals)
      .where(and(eq(knowledgeProposals.id, proposalId), eq(knowledgeProposals.projectId, projectId)))
      .limit(1)
    if (!row) return { result: false, message: t("proposal.notFound") }

    const outcome = await decideProposal(db, {
      projectId,
      proposalId,
      decision,
      userId: session.user.id,
    })

    if (!outcome.ok) {
      // Already decided by someone else, or vanished. Either way nothing changed.
      return { result: false, message: t("proposal.alreadyDecided") }
    }
    return { result: true }
  } catch (err) {
    console.error("[decideProposalAction]", err)
    return { result: false, message: t("proposal.decideFailed") }
  }
}

/**
 * Roll the served playbook back to a prior version.
 *
 * Append-only: this writes a NEW version whose content equals the target's, so no
 * history is lost and the rollback is itself a versioned, audited event. Owner-only.
 */
export async function rollbackPlaybookAction(
  projectId: string,
  toVersion: number,
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId) || !Number.isInteger(toVersion) || toVersion < 1) {
      return { result: false, message: t("proposal.versionNotFound") }
    }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    const outcome = await rollbackPlaybook(db, { projectId, toVersion, userId: session.user.id })
    if (!outcome.ok) return { result: false, message: t("proposal.versionNotFound") }

    return { result: true }
  } catch (err) {
    console.error("[rollbackPlaybookAction]", err)
    return { result: false, message: t("proposal.rollbackFailed") }
  }
}
