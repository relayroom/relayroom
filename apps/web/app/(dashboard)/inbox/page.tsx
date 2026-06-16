import Link from "next/link"
import { InboxIcon, CheckCircle2 } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import {
  getOpenThreadsForOrg,
  getAttentionThreadsForOrg,
  getGovernanceAlertsForManager,
} from "@/modules/notification/queries"
import { getTranslations } from "next-intl/server"
import { AttentionList } from "./attention-list"
import { GovernanceList } from "./governance-list"
import { ThreadMeta } from "./thread-meta"

export const dynamic = "force-dynamic"

export default async function InboxPage() {
  const session = await requireDashboardAccess()
  const orgId = await resolveActiveOrgId()

  const [openResult, attentionResult, governanceResult] = orgId
    ? await Promise.all([
        getOpenThreadsForOrg(orgId),
        getAttentionThreadsForOrg(orgId),
        getGovernanceAlertsForManager(orgId, session.user.id),
      ])
    : [null, null, null]

  // Manager-only: server already returns [] for non-managers, so an empty list
  // also means "not a manager" and the section is simply not rendered.
  const governance = governanceResult?.result ? governanceResult.items : []
  const attention = attentionResult?.result ? attentionResult.items : []
  const attentionIds = new Set(attention.map((tr) => tr.id))
  // The Attention section already shows needs-human threads; don't repeat them
  // in the Open section below.
  const open = (openResult?.result ? openResult.items : []).filter(
    (tr) => !attentionIds.has(tr.id),
  )

  const t = await getTranslations("inbox")
  const gt = await getTranslations("governance")

  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-base font-semibold">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("pageDescription")}
        </p>
      </div>

      {!orgId && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          {t("noOrg")}
        </div>
      )}

      {openResult && !openResult.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {openResult.message}
        </div>
      )}

      {/* Governance: manager-only risk lane. Only rendered when the manager has
          open alerts (the query returns [] for non-managers). */}
      {orgId && governance.length > 0 && (
        <section className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold">{gt("sectionTitle")}</h2>
            <p className="text-xs text-muted-foreground">{gt("sectionDescription")}</p>
          </div>
          <GovernanceList
            alerts={governance.map((a) => ({
              id: a.id,
              projectSlug: a.projectSlug,
              projectName: a.projectName,
              subjectUserId: a.subjectUserId,
              subjectName: a.subjectName,
              subjectEmail: a.subjectEmail,
              kind: a.kind,
              detail: a.detail,
            }))}
          />
        </section>
      )}

      {/* Attention: the bell's real queue (needs a human). Always shown so the
          section reads as "your queue" even when empty (all caught up). */}
      {orgId && openResult?.result && (
        <section className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold">{t("attentionTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("attentionDescription")}
            </p>
          </div>
          {attention.length > 0 ? (
            <AttentionList
              threads={attention.map((tr) => ({
                id: tr.id,
                subject: tr.subject,
                projectSlug: tr.projectSlug,
                projectName: tr.projectName,
                status: tr.status,
                createdByAgentPart: tr.createdByAgentPart,
                createdByHuman: tr.createdByHuman,
                messageCount: tr.messageCount,
                lastActorPart: tr.lastActorPart,
                lastActorHuman: tr.lastActorHuman,
                updatedAt: tr.updatedAt.toISOString(),
              }))}
            />
          ) : (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
              <CheckCircle2 className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t("attentionEmpty")}</p>
            </div>
          )}
        </section>
      )}

      {/* Open threads: ambient, agent-driven activity. */}
      {orgId && openResult?.result && (
        <section className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold">{t("openTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("openDescription")}
            </p>
          </div>
          {open.length === 0 ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
              <InboxIcon className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t("openEmpty")}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {open.map((thread) => (
                <li key={thread.id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/projects/${thread.projectSlug}`}
                      className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                    >
                      {thread.projectName}
                    </Link>
                    <Link
                      href={`/projects/${thread.projectSlug}/threads/${thread.id}`}
                      className="line-clamp-1 text-sm font-medium hover:underline"
                    >
                      {thread.subject}
                    </Link>
                  </div>
                  <ThreadMeta
                    status={thread.status}
                    createdByAgentPart={thread.createdByAgentPart}
                    createdByHuman={thread.createdByHuman}
                    messageCount={thread.messageCount}
                    lastActorPart={thread.lastActorPart}
                    lastActorHuman={thread.lastActorHuman}
                    updatedAt={thread.updatedAt.toISOString()}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
