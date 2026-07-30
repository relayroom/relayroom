"use server"

import { resolveRedactionRules } from "@relayroom/shared"
import type { ApiResult } from "@relayroom/shared"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"
import { mergeKnowledgeConfig } from "@/modules/knowledge/config-write"

/**
 * Save a project's redaction rules.
 *
 * Owner-gated, like every control on this page and like purge beside it. The button
 * is only rendered for owners, but a Server Action is reachable without the UI, so
 * this is the gate that holds.
 *
 * VALIDATION IS NOT DUPLICATED HERE. It runs through the same
 * `resolveRedactionRules` the server uses before it compiles anything, so the two
 * cannot disagree about what a valid rule is. The canonical enforcement is the
 * server's - it is the last point before a regex is built, and this action is not
 * guaranteed to be the only writer. What happens here is the UX half: telling the
 * owner before they leave the page, rather than letting them save something that
 * silently stops their distillation.
 *
 * Refusing rather than storing-and-warning is the same call made everywhere else in
 * this feature: a configuration that cannot be resolved makes every knowledge write
 * fail closed, so saving one would stop the project's distillation with the operator
 * believing they had just configured protection.
 */
export async function saveRedactionRules(
  projectId: string,
  rules: unknown,
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId)) {
      return { result: false, message: t("knowledge.invalidTarget") }
    }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    // `rules` is whatever the client sent. It is handed to the resolver unexamined and
    // untyped on purpose: casting it to the rule union first would put this action's
    // assertion in front of the resolver's checks, which is exactly the substitution
    // that made an earlier design unsafe.
    const { unresolved } = resolveRedactionRules({ redactionRules: rules })
    if (unresolved.length > 0) {
      return { result: false, message: t("knowledge.redactionUnresolved") }
    }

    // Merged, not written whole: this is one key of a JSONB column that carries other
    // settings. Marks the project for re-distillation in the same transaction - see
    // mergeKnowledgeConfig for why both properties are load-bearing.
    await mergeKnowledgeConfig(projectId, { redactionRules: rules })

    return { result: true }
  } catch (err) {
    console.error("[saveRedactionRules]", err)
    return { result: false, message: t("knowledge.redactionSaveFailed") }
  }
}
