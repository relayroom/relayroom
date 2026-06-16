import { getTranslations } from "next-intl/server"
import { BotIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { listMyAgents } from "@/modules/agent/queries"
import { getConnectableProjects } from "@/modules/project/member-queries"
import { AgentRegisterDialog } from "@/components/agent/agent-register-dialog"
import { AgentList } from "@/components/agent/agent-list"

export const dynamic = "force-dynamic"

export default async function GlobalAgentsPage() {
  const session = await requireDashboardAccess()
  const t = await getTranslations("agentsPage")

  const [result, connectable] = await Promise.all([
    listMyAgents(session.user.id),
    getConnectableProjects(session.user.id),
  ])
  const agents = result.result ? result.items : []

  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">{t("pageTitle")}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{t("pageDescription")}</p>
        </div>
        <AgentRegisterDialog projects={connectable} />
      </div>

      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{result.message}</div>
      )}

      {result.result && agents.length === 0 ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-center">
          <div className="rounded-full bg-muted p-4">
            <BotIcon className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
          </div>
        </div>
      ) : (
        <AgentList items={agents} showProject />
      )}
    </div>
  )
}
