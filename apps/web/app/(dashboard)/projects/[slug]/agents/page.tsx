import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { BotIcon, InfoIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { listAgents } from "@/modules/agent/queries"
import { AgentRegisterDialog } from "@/components/agent/agent-register-dialog"
import { AgentList } from "@/components/agent/agent-list"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

export default async function AgentsPage({ params }: Props) {
  await requireDashboardAccess()
  const t = await getTranslations("project")

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()

  const project = projectResult.item
  const result = await listAgents(project.id)
  const agents = result.result ? result.items : []
  const hasMain = agents.some((a) => a.role === "main")

  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t("agents.pageTitle")}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t("agents.pageDescription")}</p>
        </div>
        <AgentRegisterDialog connectCode={project.connectCode ?? ""} projectName={project.name} />
      </div>

      {/* No main agent guidance */}
      {result.result && agents.length > 0 && !hasMain && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2.5 text-xs dark:border-amber-900/50 dark:bg-amber-950/20">
          <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-amber-800 dark:text-amber-200">{t("agents.noMainHint")}</p>
        </div>
      )}

      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {result.result && agents.length === 0 && (
        <div className="py-16 text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <BotIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("agents.emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("agents.emptyDescription")}</p>
          </div>
        </div>
      )}

      {result.result && agents.length > 0 && (
        <AgentList
          items={agents.map((a) => ({ ...a, projectSlug: slug }))}
          showOwner
          showActions
        />
      )}
    </div>
  )
}
