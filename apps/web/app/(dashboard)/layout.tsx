import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { adminExists, requireDashboardAccess, getOrganizations } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { SETUP_PATH } from "@/constants/service"
import { AppSidebar } from "@/components/layouts/app/sidebar"
import { AppShellClient } from "@/components/layouts/app/app-shell"
import { getVersionInfo } from "@/lib/version"
import {
  getOpenThreadCount,
  getAttentionCount,
  getGovernanceAlertCount,
} from "@/modules/notification/queries"

// Reads session + DB (adminExists) for the auth guard; must render per-request.
export const dynamic = "force-dynamic"

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Route to setup whenever no admin exists (consistent with the setup page predicate),
  // so a no-admin install funnels people to the bootstrap recovery path.
  if (!(await adminExists())) {
    redirect(SETUP_PATH)
  }

  // Requires a session AND an approved role (admin) or org membership.
  // Self-registered non-admin users are bounced to /account/pending.
  const session = await requireDashboardAccess()

  // Fetch org data for the sidebar org switcher.
  // Resolve the active org the SAME way page content does (resolveActiveOrgId,
  // which falls back to the user's first org) so the sidebar never shows
  // "No organization" while the page is actually scoped to one.
  const orgs = await getOrganizations()
  const activeOrgId = await resolveActiveOrgId()
  const versionInfo = await getVersionInfo()

  // Two distinct signals: the bell shows only items needing a human (attention);
  // the sidebar shows the ambient, agent-driven open-thread count. Governance
  // alerts (phase 08) are a manager-only risk lane that merges into the bell's
  // attention count; getGovernanceAlertCount returns 0 for non-managers.
  const [attentionCount, openThreadCount, governanceCount] = activeOrgId
    ? await Promise.all([
        getAttentionCount(activeOrgId),
        getOpenThreadCount(activeOrgId),
        getGovernanceAlertCount(activeOrgId, session.user.id),
      ])
    : [0, 0, 0]

  const userEmail = session.user.email ?? ""
  const nickname = (session.user as { nickname?: string | null }).nickname
  const userName = (nickname && nickname.trim()) || session.user.name || userEmail

  const t = await getTranslations("ui")

  return (
    <div className="flex min-h-screen">
      {/* Skip-to-content a11y link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      >
        {t("dashboard.skipToContent")}
      </a>

      {/* Sidebar (server-rendered shell; org switcher is client inside) */}
      <AppSidebar
        orgs={(orgs as Array<{ id: string; name: string; slug: string | null }>) ?? []}
        activeOrgId={activeOrgId}
        openThreadCount={openThreadCount}
        versionInfo={versionInfo}
      />

      {/* Client shell: owns ⌘K state, renders topbar + main */}
      <AppShellClient
        userEmail={userEmail}
        userName={userName}
        attentionCount={attentionCount + governanceCount}
      >
        {children}
      </AppShellClient>
    </div>
  )
}
