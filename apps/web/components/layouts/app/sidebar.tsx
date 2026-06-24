"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations, useLocale } from "next-intl"
import {
  LayoutDashboard,
  FolderOpen,
  Building2,
  Settings,
  BookOpen,
  ChevronsUpDown,
  Check,
  Plus,
  Menu,
  X,
  Inbox,
  Bot,
  ArrowUpCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { RelayRoomMark } from "@/components/brand/relayroom-mark"
import { FeedbackDialog } from "@/components/layouts/app/feedback-dialog"
import { authClient } from "@/lib/auth-client"
import type { VersionInfo } from "@/lib/version"

// ── Types ────────────────────────────────────────────────────────────────────

interface OrgOption {
  id: string
  name: string
  slug: string | null
}

interface AppSidebarProps {
  orgs: OrgOption[]
  activeOrgId: string | null
  /** Ambient open-thread count, shown as a muted badge on the Inbox item. */
  openThreadCount?: number
  /** Instance version + update availability, shown in the sidebar footer. */
  versionInfo: VersionInfo
}

// ── Nav item definitions (key = translation key in common.nav) ───────────────

const NAV_ITEMS = [
  { labelKey: "dashboard" as const, href: "/dashboard", icon: LayoutDashboard },
  { labelKey: "inbox" as const, href: "/inbox", icon: Inbox },
  { labelKey: "projects" as const, href: "/projects", icon: FolderOpen },
  { labelKey: "agents" as const, href: "/agents", icon: Bot },
  { labelKey: "organizations" as const, href: "/organizations", icon: Building2 },
] as const

// ── Org switcher ─────────────────────────────────────────────────────────────

function OrgSwitcher({
  orgs,
  activeOrgId,
}: {
  orgs: OrgOption[]
  activeOrgId: string | null
}) {
  const t = useTranslations("common.sidebar")
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const activeOrg = orgs.find((o) => o.id === activeOrgId)
  const label = activeOrg?.name ?? t("noOrg")

  async function switchOrg(orgId: string) {
    if (orgId === activeOrgId) {
      setOpen(false)
      return
    }
    setPending(true)
    try {
      await authClient.organization.setActive({ organizationId: orgId })
      router.refresh()
    } finally {
      setPending(false)
      setOpen(false)
    }
  }

  return (
    // py-[14px] makes this row 60px tall so the divider below it lines up with
    // the tab-bar underline on tab pages (topbar h-14 + pt-5 + 40px tabs = 60px).
    <div className="relative flex items-center px-3 py-[14px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background text-[10px] font-bold uppercase">
          {label.charAt(0)}
        </span>
        <span className="flex-1 truncate text-left font-medium">{label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-3 right-3 top-full z-20 mt-1 overflow-hidden rounded-sm bg-popover shadow-md ring-1 ring-foreground/10">
            <div className="p-1">
              {orgs.length > 0 ? (
                orgs.map((org) => (
                  <button
                    key={org.id}
                    type="button"
                    onClick={() => switchOrg(org.id)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background text-[10px] font-bold uppercase">
                      {org.name.charAt(0)}
                    </span>
                    <span className="flex-1 truncate text-left">{org.name}</span>
                    {org.id === activeOrgId && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ))
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("noOrgList")}</p>
              )}
            </div>
            {/* Community Edition is single-workspace: only offer to create an org
                when none exists yet. */}
            {orgs.length === 0 && (
              <div className="border-t border-border p-1">
                <Link
                  href="/organizations/new"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("createOrg")}</span>
                </Link>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Sidebar content (shared between desktop + mobile sheet) ──────────────────

function SidebarContent({
  orgs,
  activeOrgId,
  openThreadCount = 0,
  versionInfo,
  onNavigate,
}: AppSidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname()
  const t = useTranslations("common")
  const locale = useLocale()

  return (
    <>
      {/* Wordmark */}
      <div className="flex h-14 items-center border-b border-border px-5">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2 text-sm font-semibold tracking-tight transition-opacity hover:opacity-70"
        >
          <RelayRoomMark className="h-5 w-auto" />
          <span>RelayRoom</span>
        </Link>
      </div>

      {/* Org switcher */}
      <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />

      <div className="mx-3 border-t border-border" />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5" aria-label={t("sidebar.mainMenu")}>
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/")
          const Icon = item.icon
          // Inbox carries a muted ambient count (open threads agents drive down).
          const badge = item.href === "/inbox" && openThreadCount > 0
            ? (openThreadCount > 99 ? "99+" : String(openThreadCount))
            : null
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-sm px-2 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t(`nav.${item.labelKey}`)}</span>
              {badge && (
                <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground tabular-nums">
                  {badge}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Docs + Settings footer */}
      <div className="border-t border-border px-3 py-2 space-y-0.5">
        <a
          href={`https://relayroom.dev/docs/${locale}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          {t("sidebar.docs")}
        </a>
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-3 rounded-sm px-2 py-1.5 text-sm transition-colors",
            pathname.startsWith("/settings")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {t("sidebar.settings")}
        </Link>
      </div>

      {/* Instance version + GitHub / Feedback links + update nudge */}
      <div className="border-t border-border px-4 py-2 text-[11px] leading-tight text-muted-foreground/70">
        <div className="flex items-center justify-between gap-2">
          <span>v{versionInfo.current}</span>
          <div className="flex items-center gap-1.5">
            <a
              href="https://github.com/relayroom/relayroom"
              target="_blank"
              rel="noopener noreferrer"
              onClick={onNavigate}
              className="transition-colors hover:text-foreground hover:underline"
            >
              GitHub
            </a>
            <span aria-hidden>·</span>
            <FeedbackDialog className="cursor-pointer transition-colors hover:text-foreground hover:underline" />
          </div>
        </div>
        {versionInfo.updateAvailable && versionInfo.latest && (
          <a
            href="https://github.com/relayroom/relayroom/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            onClick={onNavigate}
            className="mt-1 flex items-center gap-1.5 rounded-sm font-medium text-amber-600 hover:underline dark:text-amber-500"
          >
            <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
            {t("sidebar.updateAvailable", { version: versionInfo.latest })}
          </a>
        )}
      </div>
    </>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function AppSidebar({ orgs, activeOrgId, openThreadCount, versionInfo }: AppSidebarProps) {
  const t = useTranslations("common.sidebar")
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <>
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3.5 z-50 p-1.5 text-muted-foreground transition-colors hover:text-foreground lg:hidden"
        aria-label={t("openMenu")}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-card transition-transform duration-200 lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-end border-b border-border px-3 h-14">
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("closeMenu")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <SidebarContent
          orgs={orgs}
          activeOrgId={activeOrgId}
          openThreadCount={openThreadCount}
          versionInfo={versionInfo}
          onNavigate={() => setMobileOpen(false)}
        />
      </aside>

      {/* Desktop sidebar (sticky so the page body scrolls, not a nested container) */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:sticky lg:top-0 lg:flex lg:h-screen">
        <SidebarContent
          orgs={orgs}
          activeOrgId={activeOrgId}
          openThreadCount={openThreadCount}
          versionInfo={versionInfo}
        />
      </aside>
    </>
  )
}
