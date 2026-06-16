"use client"

import { useRouter } from "next/navigation"
import Link from "next/link"
import { Bell, Search, User, Settings, LogOut } from "lucide-react"
import { useTranslations } from "next-intl"
import { signOut } from "@/lib/auth-client"
import { ThemeToggle } from "@/components/nav/theme-toggle"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectBreadcrumb } from "./project-breadcrumb"
import { useProjectBreadcrumb } from "./project-breadcrumb-context"

// ── Notification bell → inbox of open threads ────────────────────────────────

function NotificationBell({ attentionCount = 0 }: { attentionCount?: number }) {
  const t = useTranslations("common.topbar")

  return (
    <Link
      href="/inbox"
      aria-label={
        attentionCount > 0
          ? `${t("notifications")}, ${attentionCount}`
          : t("notifications")
      }
      className="relative flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Bell className="h-4 w-4" />
      {attentionCount > 0 && (
        <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-card">
          {attentionCount > 99 ? "99+" : attentionCount}
        </span>
      )}
    </Link>
  )
}

// ── Command palette trigger ───────────────────────────────────────────────────

function CommandTriggerButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("common.topbar")

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-auto sm:justify-start sm:gap-2 sm:rounded-sm sm:border sm:border-border sm:bg-background sm:px-3 sm:text-xs sm:hover:bg-accent sm:hover:text-accent-foreground"
      aria-label={t("searchCommand")}
    >
      <Search className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" />
      <span className="hidden sm:inline">{t("searchPlaceholder")}</span>
      <kbd className="hidden rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
        ⌘K
      </kbd>
    </button>
  )
}

// ── Avatar initials helper ────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "").toUpperCase()
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase()
}

// ── Topbar ────────────────────────────────────────────────────────────────────

export interface AppTopbarProps {
  userEmail: string
  userName: string
  onCommandOpen: () => void
  attentionCount?: number
}

export function AppTopbar({
  userEmail,
  userName,
  onCommandOpen,
  attentionCount = 0,
}: AppTopbarProps) {
  const t = useTranslations("common.topbar")
  const router = useRouter()
  const breadcrumb = useProjectBreadcrumb()

  async function handleSignOut() {
    await signOut()
    router.push("/account/sign-in")
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4 pl-14 lg:pl-4">
      {/* Left: project breadcrumb + switcher (from context), empty elsewhere */}
      <div className="flex min-w-0 items-center">
        {breadcrumb && (
          <ProjectBreadcrumb current={breadcrumb.current} projects={breadcrumb.projects} />
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <CommandTriggerButton onClick={onCommandOpen} />
        <ThemeToggle label={t("toggleTheme")} className="h-8 w-8" />
        <NotificationBell attentionCount={attentionCount} />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={t("userMenu")}
          >
            <Avatar size="sm">
              <AvatarFallback>{initials(userName || userEmail)}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" sideOffset={8}>
            <div className="px-3 py-2">
              <p className="text-xs font-medium text-foreground">{userName}</p>
              <p className="text-xs text-muted-foreground">{userEmail}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/settings/profile")}>
              <User className="h-3.5 w-3.5" />
              {t("profile")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/settings/themes")}>
              <Settings className="h-3.5 w-3.5" />
              {t("settings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
              <LogOut className="h-3.5 w-3.5" />
              {t("signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
