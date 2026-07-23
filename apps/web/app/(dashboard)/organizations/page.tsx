import Link from "next/link"
import { PlusIcon, BuildingIcon, UsersIcon } from "lucide-react"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { listMyOrganizations } from "@/modules/organization/queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function OrganizationsPage() {
  const [session, t, { formatDate }] = await Promise.all([
    requireDashboardAccess(),
    getTranslations("org"),
    getDateFormatters(),
  ])

  const result = await listMyOrganizations(session.user.id)
  const orgs = result.result ? result.items : []

  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("list.pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("list.pageDescription")}
          </p>
        </div>
        <Button render={<Link href="/organizations/new" />} size="sm">
          <PlusIcon className="h-4 w-4 mr-1.5" />
          {t("list.createButton")}
        </Button>
      </div>

      {/* Error */}
      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {/* Empty state */}
      {result.result && orgs.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-16 text-center space-y-4">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <BuildingIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-base font-semibold">{t("list.emptyTitle")}</h2>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {t("list.emptyDescription")}
            </p>
          </div>
          <Button render={<Link href="/organizations/new" />} size="sm">
            <PlusIcon className="h-4 w-4 mr-1.5" />
            {t("list.emptyCreateButton")}
          </Button>
        </div>
      )}

      {/* Org card grid */}
      {orgs.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {orgs.map((org) => (
            <Link
              key={org.id}
              href={`/organizations/${org.slug ?? org.id}`}
              className="group rounded-lg border border-border bg-card p-5 hover:border-foreground/20 hover:shadow-sm transition-all space-y-4"
            >
              {/* Header row */}
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-foreground text-background text-sm font-bold uppercase">
                  {org.name.charAt(0)}
                </span>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-sm leading-snug group-hover:text-foreground truncate">
                    {org.name}
                  </h2>
                  {org.slug && (
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">/{org.slug}</p>
                  )}
                </div>
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {t(`roles.${org.role}` as Parameters<typeof t>[0]) ?? org.role}
                </Badge>
              </div>

              {/* Footer meta */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <UsersIcon className="h-3 w-3" />
                  {t("list.memberCount", { count: org.memberCount })}
                </span>
                <span className="ml-auto font-mono">
                  {formatDate(org.createdAt.toISOString())}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
