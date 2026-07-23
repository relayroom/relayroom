"use server"

import { createHash } from "node:crypto"
import type { ApiResult } from "@relayroom/shared"
// Subpath, not the package root: the root barrel re-exports migrate.ts, whose
// `new URL('../drizzle', import.meta.url)` Turbopack cannot resolve, so importing
// it here fails `next build` (tsc and vitest both resolve it fine). Same reason
// member-actions.ts imports applyBan from @relayroom/db/governance.
import { recordKnowledgeSignal } from "@relayroom/db/knowledge"
import { db } from "@/modules/drizzle/db"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import { promoteKnowledgeSchema, type PromoteKnowledgeInput } from "./schema"

/**
 * A project owner confirming a claim by hand, which promotes it at K=1.
 *
 * This is the only promoting channel in L0, and the human in the seat is the
 * whole safety story: an agent writes candidates and can never promote its own
 * guess. That is also why this is an override worth recording rather than a
 * shortcut - the audit row says a person did it, on purpose.
 */
export async function promoteKnowledge(input: PromoteKnowledgeInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const parsed = promoteKnowledgeSchema(t).safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, knowledgeId } = parsed.data

    // `owner`, not `write`. The button is only rendered for owners, but a Server
    // Action is a live endpoint reachable without the button, so this is the gate
    // that actually holds - the UI is a convenience on top of it.
    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    // One signal per (issuer, source). Fingerprinting the user means a second
    // click by the same person deduplicates rather than stacking a second vote,
    // so "confirmed by one owner" cannot be inflated by clicking twice.
    const sourceFingerprint = createHash("sha256")
      .update(`human:${session.user.id}:${knowledgeId}`)
      .digest("hex")

    // The transaction lives in @relayroom/db because L1's attest endpoint performs
    // the same promotion from the server. Two implementations of "record a signal
    // and re-decide the state" would drift, and the half that drifts is a ledger.
    const outcome = await recordKnowledgeSignal(db, {
      projectId,
      knowledgeId,
      signal: "support",
      issuer: "human",
      issuerId: session.user.id,
      sourceFingerprint,
      sourceRef: { userId: session.user.id },
      counted: true,
      actorKind: "human",
      actorUserId: session.user.id,
      humanOwnerOverride: true,
    })

    // ok:false means no such entry in THIS project. The helper deliberately does
    // not distinguish "absent" from "another project's", so neither do we.
    if (!outcome.ok) return { result: false, message: t("knowledge.notFound") }

    return { result: true }
  } catch (err) {
    console.error("[promoteKnowledge]", err)
    return { result: false, message: t("knowledge.promoteFailed") }
  }
}
