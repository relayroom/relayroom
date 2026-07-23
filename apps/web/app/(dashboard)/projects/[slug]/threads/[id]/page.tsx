import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { ChevronLeftIcon, UserIcon, BotIcon, CheckCheckIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { getThread } from "@/modules/thread/queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/markdown"
import { resolveAgentColor } from "@/components/agent/agent-appearance"
import { PresenceDot } from "@/components/agent/presence-dot"
import { ComposingIndicator } from "@/components/thread/composing-indicator"
import { ThreadReplyForm } from "./thread-reply-form"
import { ThreadStatusControls } from "./thread-status-controls"

export const dynamic = "force-dynamic"

const STATUS_BADGE_STYLES: Record<string, string> = {
  open: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
  answered: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground border-border",
  holding: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
  canceled: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
}

interface Props {
  params: Promise<{ slug: string; id: string }>
}

export default async function ThreadDetailPage({ params }: Props) {
  await requireDashboardAccess()
  const t = await getTranslations("project")
  const { formatDateTime } = await getDateFormatters()

  const { slug, id } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()

  const project = projectResult.item

  const result = await getThread(project.id, id)
  if (!result.result) notFound()

  const thread = result.item
  const isClosed = thread.status === "closed" || thread.status === "canceled"

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      {/* Back link */}
      <Link
        href={`/projects/${slug}/threads`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        {t("threadDetail.backToList")}
      </Link>

      {/* Thread header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-semibold leading-snug">{thread.subject}</h1>
          <span
            className={[
              "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium shrink-0",
              STATUS_BADGE_STYLES[thread.status] ?? "bg-muted text-muted-foreground border-border",
            ].join(" ")}
          >
            {t(`threadDetail.status.${thread.status}` as never)}
          </span>
        </div>

        {/* Tags */}
        {thread.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {thread.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Meta: created at + status controls */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-xs text-muted-foreground font-mono">
            {t("threadDetail.createdAt", {
              dateTime: formatDateTime(thread.createdAt.toISOString()),
            })}
          </p>
          <ThreadStatusControls
            threadId={thread.id}
            status={thread.status}
            slug={slug}
          />
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Messages */}
      {thread.messages.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("threadDetail.noMessages")}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {thread.messages.map((msg) => {
            const isAgent = !!msg.fromAgentId
            const authorLabel = isAgent
              ? msg.fromAgentPart ?? "agent"
              : msg.fromUserName ?? "user"

            return (
              <div key={msg.id} className="flex gap-3">
                {/* Avatar-style icon */}
                <div
                  className={[
                    "mt-0.5 h-7 w-7 rounded-full flex items-center justify-center shrink-0",
                    isAgent
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                      : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
                  ].join(" ")}
                >
                  {isAgent ? (
                    <BotIcon className="h-3.5 w-3.5" />
                  ) : (
                    <UserIcon className="h-3.5 w-3.5" />
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  {/* Author + timestamp */}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-mono font-medium">{authorLabel}</span>
                    {isAgent && msg.fromAgentNickname && (
                      <span className="text-xs text-muted-foreground">
                        "{msg.fromAgentNickname}"
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground font-mono">
                      {formatDateTime(msg.createdAt.toISOString())}
                    </span>
                  </div>

                  {/* Target audience - which parts this message was addressed to */}
                  {msg.recipients.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        {t("threadDetail.to")}
                      </span>
                      {msg.recipients.map((r) => {
                        const c = resolveAgentColor(r.color, r.part)
                        return (
                          <span
                            key={r.agentId}
                            className={[
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-mono",
                              c.avatar,
                            ].join(" ")}
                          >
                            <PresenceDot
                              agentId={r.agentId}
                              initialOnline={r.online}
                              onlineLabel={t("threadDetail.online")}
                              offlineLabel={t("threadDetail.offline")}
                            />
                            {r.part}
                            {r.nickname && <span className="opacity-70">"{r.nickname}"</span>}
                          </span>
                        )
                      })}
                    </div>
                  )}

                  {/* Body rendered as Markdown - no dangerouslySetInnerHTML */}
                  <div className="rounded-lg border border-border bg-card px-4 py-3">
                    <Markdown content={msg.body} />
                  </div>

                  {/* Read receipts - a lightweight per-message read timeline: who read
                      it and WHEN, one line each (updates live via the 'read' bus event). */}
                  {msg.readReceipts.length > 0 && (
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      {msg.readReceipts.map((r) => (
                        <div key={r.agentId} className="flex items-center gap-1.5">
                          <CheckCheckIcon className="h-3 w-3 text-muted-foreground/60" />
                          <span className="text-xs text-muted-foreground">
                            {t("threadDetail.readAtLabel", {
                              part: r.agentPart + (r.agentNickname ? ` (${r.agentNickname})` : ""),
                              time: formatDateTime(r.readAt.toISOString()),
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Live "composing" indicator (transient, agent-emitted) */}
      <ComposingIndicator
        threadId={thread.id}
        parts={thread.targetAgents.map((a) => a.part)}
      />

      {/* Reply box */}
      {!isClosed && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">{t("threadDetail.replyTitle")}</p>
          <ThreadReplyForm
            threadId={thread.id}
            targetAgents={thread.targetAgents}
          />
        </div>
      )}

      {isClosed && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-center">
          <p className="text-sm text-muted-foreground">
            {t("threadDetail.closedMessage", {
              status: t(`threadDetail.status.${thread.status}` as never),
            })}
          </p>
        </div>
      )}
    </div>
  )
}
