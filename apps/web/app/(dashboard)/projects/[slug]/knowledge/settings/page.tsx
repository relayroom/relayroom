import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { ShieldIcon, ArrowLeftIcon } from "lucide-react"
import { requireDashboardAccess, requireProjectAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { listKnowledge } from "@/modules/knowledge/queries"
import { getAttestStatus, listCheckMappings } from "@/modules/knowledge/attest-queries"
import { listPurgeableThreads } from "@/modules/knowledge/purge-queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { AttestSecretCard } from "./attest-secret-card"
import { CheckMapManager, type ClaimOption, type MappingRow } from "./check-map-manager"
import { ThreadPurgeManager } from "./thread-purge-manager"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

export default async function KnowledgeSettingsPage({ params }: Props) {
  const session = await requireDashboardAccess()
  const [t, { formatDate, formatDateTime }] = await Promise.all([
    getTranslations("project"),
    getDateFormatters(),
  ])

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const backHref = `/projects/${slug}/knowledge`

  // Owner-only, but NOT hidden as a 404: a write member may know the URL, and a
  // blank not-found would read as "no such page" rather than "not yours". The
  // route exists; entering without ownership is a clear, explained refusal. The
  // actions re-check independently - this only decides what is shown.
  const access = await requireProjectAccess(session.user.id, project.id, "owner")
  if (!access.ok) {
    return (
      <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledgeAttest.backToKnowledge")}
        </Link>
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-3">
              <ShieldIcon className="h-6 w-6 text-muted-foreground" />
            </div>
          </div>
          <h1 className="text-base font-semibold">{t("knowledgeAttest.ownerOnlyTitle")}</h1>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {t("knowledgeAttest.ownerOnlyBody")}
          </p>
        </div>
      </div>
    )
  }

  const [status, mappings, claimsResult, purgeableThreads] = await Promise.all([
    getAttestStatus(project.id),
    listCheckMappings(project.id),
    // Candidate + trusted claims are the plausible mapping targets; a paged list
    // is enough for the picker (very large projects would want search, noted).
    listKnowledge(project.id, { limit: 100 }),
    listPurgeableThreads(project.id),
  ])

  const claims: ClaimOption[] = (claimsResult.result ? claimsResult.items : [])
    .filter((k) => k.validationState === "candidate" || k.validationState === "trusted")
    .map((k) => ({ id: k.id, title: k.title, kind: k.kind }))

  const mappingRows: MappingRow[] = mappings.map((m) => ({
    id: m.id,
    checkName: m.checkName,
    knowledgeTitle: m.knowledgeTitle,
    knowledgeKind: m.knowledgeKind,
    addedLabel: formatDate(m.createdAt.toISOString()),
  }))

  const prevExpiresLabel = status.prevExpiresAt
    ? formatDateTime(status.prevExpiresAt.toISOString())
    : null

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3 w-3" />
          {t("knowledgeAttest.backToKnowledge")}
        </Link>
        <h1 className="mt-2 text-base font-semibold">{t("knowledgeAttest.pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("knowledgeAttest.pageDescription")}</p>
      </div>

      <AttestSecretCard
        projectId={project.id}
        keyId={status.keyId}
        prevKeyId={status.prevKeyId}
        prevExpiresLabel={prevExpiresLabel}
      />

      {/* Mapping only matters once a secret exists; before that, CI has no way to
          attest at all, so the section would describe a capability that is off. */}
      {status.keyId !== null && (
        <CheckMapManager
          projectId={project.id}
          claims={claims}
          mappings={mappingRows}
          claimsError={claimsResult.result ? undefined : claimsResult.message}
        />
      )}

      {/* Purge is independent of attestation - it is about removing what a thread
          produced, regardless of how anything gets promoted. */}
      <ThreadPurgeManager projectId={project.id} threads={purgeableThreads} />
    </div>
  )
}
