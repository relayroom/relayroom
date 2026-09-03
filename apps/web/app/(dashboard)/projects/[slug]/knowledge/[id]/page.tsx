import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import {
  ArrowLeftIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  MessageSquareIcon,
  UnlinkIcon,
} from "lucide-react"
import { requireDashboardAccess, requireProjectAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { getKnowledgeEntry, listSourceThreads } from "@/modules/knowledge/queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { isUuid } from "@/lib/uuid"
import { Badge } from "@/components/ui/badge"
import { PromoteButton } from "../promote-button"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string; id: string }>
}

/** Capitalized suffix for the `state<X>` / `kind<X>` message keys. */
function titleKey(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Badge tone per state, matching the list so the two do not read as disagreeing. */
function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "trusted") return "default"
  if (state === "contradicted") return "destructive"
  if (state === "retired") return "outline"
  return "secondary"
}

/**
 * One knowledge entry in full, and the way back to what it was drawn from.
 *
 * A route rather than a dialog on the list. An entry is a thing people cite to each
 * other - "see the pitfall we recorded" - and a dialog has no address to send.
 *
 * The list truncates title and body on purpose and this page is the reason that is
 * allowed to be lossless. The source link matters for the same reason and is the
 * point of the screen: an entry is worth keeping short only while the discussion it
 * came from is one click away. Without that link, shortness becomes lost
 * information, entries grow to compensate, and long entries go unread.
 */
export default async function KnowledgeDetailPage({ params }: Props) {
  const session = await requireDashboardAccess()
  const [t, { formatDateTime }] = await Promise.all([
    getTranslations("project"),
    getDateFormatters(),
  ])

  const { slug, id } = await params

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  // A malformed id is a not-found, not a 500. The query would reject it at the uuid
  // column otherwise.
  if (!isUuid(id)) notFound()

  const backHref = `/projects/${slug}/knowledge`

  const entryResult = await getKnowledgeEntry(project.id, id)
  if (!entryResult.result) {
    return (
      <div className="py-6 px-4 xs:px-6 max-w-3xl mx-auto space-y-4">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledge.detailBack")}
        </Link>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {entryResult.message}
        </div>
      </div>
    )
  }
  const entry = entryResult.item

  // Whether to OFFER promotion. The action re-checks on its own; this only decides
  // what is drawn, exactly as on the list.
  const [canPromote, sources] = await Promise.all([
    requireProjectAccess(session.user.id, project.id, "owner").then((r) => r.ok),
    listSourceThreads(project.id, entry.sourceRefs),
  ])

  return (
    <div className="py-6 px-4 xs:px-6 max-w-3xl mx-auto space-y-5">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledge.detailBack")}
        </Link>

        <div className="mt-2 flex flex-wrap items-start gap-2">
          <Badge variant="outline" className="mt-0.5 shrink-0 text-xs">
            {t(`knowledge.kind${titleKey(entry.kind)}` as Parameters<typeof t>[0])}
          </Badge>
          {/* Wrapped, not truncated. The list clips a title to keep rows scannable;
              clipping it here too would leave nowhere to read it in full. */}
          <h1 className="min-w-0 flex-1 break-words text-base font-semibold leading-6">{entry.title}</h1>
          <Badge variant={stateVariant(entry.validationState)} className="mt-0.5 shrink-0 text-xs">
            {t(`knowledge.state${titleKey(entry.validationState)}` as Parameters<typeof t>[0])}
          </Badge>
          {canPromote && entry.validationState === "candidate" && (
            <PromoteButton projectId={project.id} knowledgeId={entry.id} />
          )}
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("knowledge.detailBodyTitle")}
        </h2>
        {/* No clamp. This is the screen that exists so the list is allowed to have one.
            `break-words` because `whitespace-pre-wrap` only breaks at whitespace,
            and a lesson quoting a token, URL or stack frame has runs with none:
            measured, a 308-character token pushed this page 1608px wide at a
            1440px viewport, so it was not a narrow-screen problem at all. */}
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{entry.body}</p>
      </section>

      <section className="space-y-2">
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground">
            {t("knowledge.detailSourcesTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("knowledge.detailSourcesHint")}
          </p>
        </div>

        {sources.length === 0 ? (
          // Said, not hidden. An absent link and a removed source are different
          // states, and a screen that renders nothing for both makes the reader
          // assume the first - so an entry that lost its evidence would look like one
          // that never had any.
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            {t("knowledge.detailNoThreadSource")}
          </p>
        ) : (
          <ul className="space-y-2">
            {/* Every ref, not the first. Entries mostly carry one today, but the
                column has always been a list and reflection across threads is what
                it was made a list for - a screen that renders sources[0] would drop
                evidence silently on the day that changes. */}
            {sources.map((source, i) =>
              source.subject === null ? (
                <li
                  key={`${source.threadId}-${i}`}
                  className="flex items-start gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground"
                >
                  <UnlinkIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t("knowledge.detailThreadGone")}</span>
                </li>
              ) : (
                <li key={`${source.threadId}-${i}`}>
                  <Link
                    href={`/projects/${slug}/threads/${source.threadId}`}
                    className="flex items-start gap-2 rounded-md border border-border p-3 transition-colors hover:border-foreground/30"
                  >
                    <MessageSquareIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">
                        {source.subject.trim() || t("knowledge.detailUntitledThread")}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t("knowledge.detailOpenThread")}
                      </span>
                    </span>
                  </Link>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {entry.validationState === "trusted" ? (
            <CheckCircle2Icon className="h-3 w-3" />
          ) : entry.validationState === "contradicted" ? (
            <AlertTriangleIcon className="h-3 w-3" />
          ) : null}
          {t("knowledge.supportLabel", { count: entry.supportingIssuers })}
        </span>

        <span>
          {t("knowledge.detailSourceKindLabel")}{" "}
          {t(`knowledge.source${titleKey(entry.sourceKind)}` as Parameters<typeof t>[0])}
        </span>

        <span className="font-mono">
          {t("knowledge.colCreated")} {formatDateTime(entry.createdAt.toISOString())}
        </span>

        {entry.promotedAt && (
          <span className="font-mono">
            {t("knowledge.colPromoted")} {formatDateTime(entry.promotedAt.toISOString())}
          </span>
        )}

        {entry.expiresAt && (
          <span className="font-mono">
            {t("knowledge.colExpires")} {formatDateTime(entry.expiresAt.toISOString())}
          </span>
        )}
      </section>
    </div>
  )
}
