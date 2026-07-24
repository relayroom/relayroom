import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { ShieldIcon, ArrowLeftIcon, InboxIcon } from "lucide-react"
import { requireDashboardAccess, requireProjectAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import {
  listProposals,
  countProposalsByStatus,
  listPlaybookVersions,
  isProposalStatus,
  PROPOSAL_STATUSES,
} from "@/modules/knowledge/proposal-queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { ProposalCard, type ProposalCardData } from "./proposal-card"
import { RollbackControl, type VersionRow } from "./rollback-control"

export const dynamic = "force-dynamic"

const FILTER_KEYS = ["pending", ...PROPOSAL_STATUSES.filter((s) => s !== "pending")] as const

function titleKey(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ status?: string }>
}

export default async function ProposalsPage({ params, searchParams }: Props) {
  const session = await requireDashboardAccess()
  const [t, { formatDateTime }] = await Promise.all([
    getTranslations("project"),
    getDateFormatters(),
  ])

  const { slug } = await params
  const sp = await searchParams
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const backHref = `/projects/${slug}/knowledge`

  // Owner-only, refused clearly rather than 404'd - a write member may know the
  // URL. The route exists and explains; actions re-check independently.
  const access = await requireProjectAccess(session.user.id, project.id, "owner")
  if (!access.ok) {
    return (
      <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledgeProposals.backToKnowledge")}
        </Link>
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-3">
              <ShieldIcon className="h-6 w-6 text-muted-foreground" />
            </div>
          </div>
          <h1 className="text-base font-semibold">{t("knowledgeProposals.ownerOnlyTitle")}</h1>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t("knowledgeProposals.ownerOnlyBody")}</p>
        </div>
      </div>
    )
  }

  const statusFilter = sp.status && isProposalStatus(sp.status) ? sp.status : "pending"

  const [proposals, counts, versions] = await Promise.all([
    listProposals(project.id, statusFilter),
    countProposalsByStatus(project.id),
    listPlaybookVersions(project.id),
  ])

  const cards: ProposalCardData[] = proposals.map((p) => ({
    id: p.id,
    status: p.status,
    target: p.target,
    evidence: p.evidence,
    hypothesis: p.hypothesis,
    disconfirming: p.disconfirming,
    change: p.change,
  }))

  const versionRows: VersionRow[] = versions.map((v) => ({
    version: v.version,
    content: v.content,
    note: v.note,
    createdLabel: formatDateTime(v.createdAt.toISOString()),
  }))

  // The served body is the newest version's content when any version exists;
  // otherwise the project's stored relayroomMd (nothing versioned yet).
  const currentContent = versions[0]?.content ?? project.relayroomMd ?? ""

  const filterHref = (key: string) =>
    key === "pending"
      ? `/projects/${slug}/knowledge/proposals`
      : `/projects/${slug}/knowledge/proposals?status=${key}`

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
      <div>
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledgeProposals.backToKnowledge")}
        </Link>
        <h1 className="mt-2 text-base font-semibold">{t("knowledgeProposals.pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("knowledgeProposals.pageDescription")}</p>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {FILTER_KEYS.map((key) => {
          const active = key === statusFilter
          return (
            <Link
              key={key}
              href={filterHref(key)}
              className={[
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {t(`knowledgeProposals.filter${titleKey(key)}` as Parameters<typeof t>[0])}
              <span className="ml-1.5 text-xs tabular-nums opacity-60">{counts[key]}</span>
            </Link>
          )
        })}
      </div>

      {cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-2">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-3">
              <InboxIcon className="h-6 w-6 text-muted-foreground" />
            </div>
          </div>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {statusFilter === "pending" ? t("knowledgeProposals.emptyPending") : t("knowledgeProposals.empty")}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {cards.map((c) => (
            <ProposalCard key={c.id} projectId={project.id} data={c} />
          ))}
        </ul>
      )}

      <RollbackControl projectId={project.id} currentContent={currentContent} versions={versionRows} />
    </div>
  )
}
