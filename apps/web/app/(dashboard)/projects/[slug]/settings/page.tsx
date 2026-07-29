import { notFound } from "next/navigation"
import { LoadError } from "@/components/load-error"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { canManageMembers } from "@/modules/project/member-queries"
import { getOwnerWakeBudget, listProjectSuppressions } from "@/modules/wake/queries"
import { ProjectSettingsForm } from "./project-settings-form"
import { RelayroomMdEditor } from "./relayroom-md-editor"
import { ProjectBroadcastCapForm } from "./project-broadcast-cap-form"
import { ProjectDangerZone } from "./project-danger-zone"
import { OwnerWakeBudgetCard } from "../agents/[id]/owner-wake-budget-card"
import { WakeSuppressionPanel } from "./wake-suppression-panel"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

export default async function ProjectSettingsPage({ params }: Props) {
  const session = await requireDashboardAccess()
  const t = await getTranslations("project")

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const result = await getProjectBySlug(orgId, slug)
  if (!result.result) notFound()

  const project = result.item

  const SUPPRESSION_WINDOW_HOURS = 24
  const [canManage, budgetResult, suppressions] = await Promise.all([
    canManageMembers(orgId, project.id, session.user.id),
    getOwnerWakeBudget(session.user.id),
    listProjectSuppressions(project.id, session.user.id, SUPPRESSION_WINDOW_HOURS),
  ])
  const ownerBudget = budgetResult.result ? budgetResult.item : null

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-8">
      <div>
        <h2 className="text-base font-semibold">{t("settings.pageTitle")}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("settings.pageDescription")}
        </p>
      </div>

      <ProjectSettingsForm project={project} />

      <ProjectBroadcastCapForm
        projectId={project.id}
        initial={project.maxBroadcastRecipients}
        partCount={project.agentCount}
        canManage={canManage}
      />

      {/* Fallback reach for the owner wake budget when the user has no main agent
          yet (spec §11 lists the main-agent detail as the primary surface). Same
          single-row upsert, so the two locations stay consistent. */}
      {ownerBudget && (
        <OwnerWakeBudgetCard
          initial={{ wakesPerHour: ownerBudget.wakesPerHour, urgentPerHour: ownerBudget.urgentPerHour }}
        />
      )}
      {/* A failed budget read used to remove the card silently, which reads as
          "this project has no budget settings" rather than "we could not load
          them". Say which one it is. */}
      {!budgetResult.result && <LoadError variant="inline" message={budgetResult.message} />}

      {/* Beside the budget on purpose: budget exhaustion is the one reason here an
          owner can act on, and the control for it is the card directly above. */}
      {suppressions.result ? (
        <WakeSuppressionPanel parts={suppressions.items} windowHours={SUPPRESSION_WINDOW_HOURS} />
      ) : (
        /* A failed read must not render as "nothing was suppressed" - that is the
           same silence this panel exists to break. */
        <LoadError variant="inline" message={suppressions.message} />
      )}

      <RelayroomMdEditor projectId={project.id} initial={project.relayroomMd} />

      {/* Danger zone last - destructive actions belong at the very bottom. */}
      <ProjectDangerZone projectId={project.id} />
    </div>
  )
}
