import { notFound } from "next/navigation"
import Link from "next/link"
import { eq } from "drizzle-orm"
import { PlusIcon, FolderOpenIcon, BotIcon, UsersIcon } from "lucide-react"
import { getTranslations } from "next-intl/server"
import {
  requireDashboardAccess,
  getOrgInvitations,
  isOrgManager,
  isOrgMember,
} from "@/lib/auth-session"
import { db } from "@/modules/drizzle/db"
import {
  better_auth_organization,
  better_auth_member,
  better_auth_user,
} from "@relayroom/db/auth-schema"
import { listProjects } from "@/modules/project/queries"
import { getUsageSeries } from "@/modules/usage/queries"
import { UsageChart } from "@/components/dashboard/usage-chart"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { InviteForm } from "./invite-form"
import { PendingInvitations } from "./pending-invitations"
import { getTimeAgo } from "@/lib/time-ago"
import { getDateFormatters } from "@/lib/date-format.server"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

export default async function OrganizationDetailPage({ params }: Props) {
  const { slug } = await params
  const [session, t, timeAgo, { formatDate }] = await Promise.all([
    requireDashboardAccess(),
    getTranslations("org"),
    getTimeAgo(),
    getDateFormatters(),
  ])

  // Fetch org by slug
  const [org] = await db
    .select()
    .from(better_auth_organization)
    .where(eq(better_auth_organization.slug, slug))
    .limit(1)

  if (!org) notFound()

  // AUTHORIZATION: the viewer must be a member of THIS org. Otherwise any
  // authenticated user could read another org's members/emails/projects by
  // guessing its slug. Treat non-members as "not found" (don't reveal existence).
  if (!(await isOrgMember(org.id))) notFound()

  // Fetch members with user info via join
  const memberRows = await db
    .select({
      id: better_auth_member.id,
      role: better_auth_member.role,
      createdAt: better_auth_member.createdAt,
      userId: better_auth_member.userId,
      userName: better_auth_user.name,
      userEmail: better_auth_user.email,
    })
    .from(better_auth_member)
    .innerJoin(better_auth_user, eq(better_auth_member.userId, better_auth_user.id))
    .where(eq(better_auth_member.organizationId, org.id))

  // Projects for this org
  const projectsResult = await listProjects(org.id, session.user.id)
  const orgProjects = projectsResult.result ? projectsResult.items : []

  // Org-wide token/cost usage (last 14 days)
  const usageResult = await getUsageSeries(org.id)
  const usage = usageResult.result ? usageResult.item : null

  // Manager gating and pending invitations — scoped to the DISPLAYED org (org.id),
  // not the session's active org, so a multi-org user viewing a non-active org
  // sees/cancels the right invites and invites into the right org.
  const [canManage, invitations] = await Promise.all([
    isOrgManager(org.id),
    getOrgInvitations(org.id),
  ])

  return (
    <div className="py-6 px-4 xs:px-6 space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-foreground text-background text-lg font-bold uppercase">
          {org.name.charAt(0)}
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{org.name}</h1>
          {org.slug && (
            <p className="text-sm text-muted-foreground font-mono mt-0.5">/{org.slug}</p>
          )}
        </div>
        <Button render={<Link href="/projects/new" />} size="sm" variant="outline">
          <PlusIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("detail.newProjectButton")}
        </Button>
      </div>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersIcon className="h-4 w-4" />
            {t("detail.membersTitle")}
          </CardTitle>
          <CardDescription>
            {t("detail.membersDescription", { count: memberRows.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {memberRows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("detail.tableEmail")}</TableHead>
                  <TableHead>{t("detail.tableName")}</TableHead>
                  <TableHead>{t("detail.tableRole")}</TableHead>
                  <TableHead>{t("detail.tableJoinedAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberRows.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-mono text-sm">{member.userEmail}</TableCell>
                    <TableCell className="text-sm">{member.userName ?? "-"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {t(`roles.${member.role}` as Parameters<typeof t>[0]) ?? member.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {formatDate(member.createdAt.toISOString())}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t("detail.membersEmpty")}</p>
          )}
        </CardContent>
      </Card>

      {/* Invite section — owner/admin only */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("detail.inviteTitle")}</CardTitle>
            <CardDescription>
              {t("detail.inviteDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <InviteForm organizationId={org.id} />
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-3">{t("detail.pendingTitle")}</h3>
              <PendingInvitations
                invitations={(invitations as Array<{
                  id: string
                  email: string
                  role: string | null
                  status: string
                  expiresAt: Date | string
                }>) ?? []}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Projects for this org */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderOpenIcon className="h-4 w-4" />
              {t("detail.projectsTitle")}
            </CardTitle>
            <CardDescription className="mt-1">
              {t("detail.projectsDescription")}
            </CardDescription>
          </div>
          <Button render={<Link href="/projects/new" />} size="sm" variant="outline">
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            {t("detail.newProjectButton")}
          </Button>
        </CardHeader>
        <CardContent>
          {orgProjects.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-8 text-center space-y-2">
              <p className="text-sm text-muted-foreground">{t("detail.projectsEmpty")}</p>
              <Button render={<Link href="/projects/new" />} size="sm" variant="ghost">
                <PlusIcon className="h-3.5 w-3.5 mr-1" />
                {t("detail.projectsCreateFirst")}
              </Button>
            </div>
          ) : (
            <ul className="space-y-2">
              {orgProjects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.slug}`}
                    className="flex items-center gap-3 rounded-sm px-3 py-2.5 hover:bg-accent transition-colors group border border-transparent hover:border-border"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: project.thumbnailColor ?? "hsl(var(--muted-foreground))" }}
                    />
                    <span className="flex-1 text-sm font-medium truncate">
                      {project.name}
                    </span>
                    {project.summary && (
                      <span className="text-xs text-muted-foreground truncate max-w-xs hidden md:block">
                        {project.summary}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                      <BotIcon className="h-3 w-3" />
                      {project.agentCount}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono shrink-0">
                      {timeAgo(project.createdAt.toISOString())}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Org-wide token / cost usage (last 14 days) */}
      {usage && <UsageChart usage={usage} className="" />}
    </div>
  )
}
