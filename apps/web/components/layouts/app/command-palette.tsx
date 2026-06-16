"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  LayoutDashboard,
  FolderOpen,
  Building2,
  User,
  Settings,
  Plus,
  SearchIcon,
  MessageSquareIcon,
  ZapIcon,
  BotIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { globalSearch } from "@/modules/search/actions"
import type { SearchResults } from "@/modules/search/queries"

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type NavGroup = "nav" | "quick"
interface NavAction {
  labelKey: string
  href: string
  icon: typeof LayoutDashboard
  group: NavGroup
  shortcut?: string
}

const NAV_ACTIONS: NavAction[] = [
  { labelKey: "navDashboard", href: "/dashboard", icon: LayoutDashboard, group: "nav", shortcut: "G D" },
  { labelKey: "navProjects", href: "/projects", icon: FolderOpen, group: "nav", shortcut: "G P" },
  { labelKey: "navOrganizations", href: "/organizations", icon: Building2, group: "nav", shortcut: "G O" },
  { labelKey: "navProfile", href: "/settings/profile", icon: User, group: "nav", shortcut: "G M" },
  { labelKey: "navSettings", href: "/settings/themes", icon: Settings, group: "nav" },
  { labelKey: "quickNewProject", href: "/projects/new", icon: Plus, group: "quick" },
  { labelKey: "quickNewOrg", href: "/organizations/new", icon: Plus, group: "quick" },
]

const EMPTY: SearchResults = { threads: [], events: [], agents: [] }

/** One keyboard-navigable row. */
interface Row {
  href: string
  primary: string
  secondary?: string
  icon: typeof LayoutDashboard
  shortcut?: string
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter()
  const t = useTranslations("ui")
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqId = useRef(0)

  const q = query.trim()
  const ql = q.toLowerCase()

  // ⌘K toggles the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange])

  // Reset + focus on open.
  useEffect(() => {
    if (open) {
      setQuery("")
      setHighlighted(0)
      setResults(EMPTY)
      const id = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(id)
    }
  }, [open])

  useEffect(() => setHighlighted(0), [query])

  // Debounced content search.
  useEffect(() => {
    if (q.length < 2) {
      setResults(EMPTY)
      setSearching(false)
      return
    }
    setSearching(true)
    const myId = ++reqId.current
    const handle = setTimeout(async () => {
      try {
        const r = await globalSearch(q)
        if (myId === reqId.current) setResults(r)
      } catch {
        if (myId === reqId.current) setResults(EMPTY)
      } finally {
        if (myId === reqId.current) setSearching(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [q])

  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const go = useCallback(
    (href: string) => {
      onOpenChange(false)
      router.push(href)
    },
    [onOpenChange, router],
  )

  // ── Build grouped rows ──────────────────────────────────────────────────────
  const navRows: Row[] = NAV_ACTIONS.filter((a) => a.group === "nav")
    .map((a) => ({ ...a, label: t(`commandPalette.${a.labelKey}`) }))
    .filter((a) => !q || a.label.toLowerCase().includes(ql))
    .map((a) => ({ href: a.href, primary: a.label, icon: a.icon, shortcut: a.shortcut }))

  const quickRows: Row[] = NAV_ACTIONS.filter((a) => a.group === "quick")
    .map((a) => ({ ...a, label: t(`commandPalette.${a.labelKey}`) }))
    .filter((a) => !q || a.label.toLowerCase().includes(ql))
    .map((a) => ({ href: a.href, primary: a.label, icon: a.icon }))

  const threadRows: Row[] = results.threads.map((th) => ({
    href: `/projects/${th.projectSlug}/threads/${th.id}`,
    primary: th.subject,
    secondary: th.projectSlug,
    icon: MessageSquareIcon,
  }))
  const eventRows: Row[] = results.events.map((ev) => ({
    href: `/projects/${ev.projectSlug}/events/${ev.id}`,
    primary: ev.label ? `${ev.type} · ${ev.label}` : ev.type,
    secondary: ev.projectSlug,
    icon: ZapIcon,
  }))
  const agentRows: Row[] = results.agents.map((ag) => ({
    href: `/projects/${ag.projectSlug}/agents/${ag.id}`,
    primary: ag.part,
    secondary: ag.projectSlug,
    icon: BotIcon,
  }))

  const groups: { key: string; heading: string; rows: Row[] }[] = q
    ? [
        { key: "nav", heading: t("commandPalette.groupNav"), rows: navRows },
        { key: "threads", heading: t("commandPalette.groupThreads"), rows: threadRows },
        { key: "events", heading: t("commandPalette.groupEvents"), rows: eventRows },
        { key: "agents", heading: t("commandPalette.groupAgents"), rows: agentRows },
      ].filter((g) => g.rows.length > 0)
    : [
        { key: "nav", heading: t("commandPalette.groupNav"), rows: navRows },
        { key: "quick", heading: t("commandPalette.groupQuick"), rows: quickRows },
      ].filter((g) => g.rows.length > 0)

  const flat = groups.flatMap((g) => g.rows)

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return close()
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlighted((p) => (flat.length ? (p + 1) % flat.length : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlighted((p) => (flat.length ? (p - 1 + flat.length) % flat.length : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const target = flat[highlighted]
      if (target) go(target.href)
    }
  }

  if (!open) return null

  let abs = 0
  const showEmpty = flat.length === 0 && !searching

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("commandPalette.title")}
      className="fixed inset-0 z-[70] flex flex-col items-center"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />

      <div
        className="relative mx-auto mt-24 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={t("commandPalette.inputPlaceholder")}
            aria-label={t("commandPalette.title")}
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {searching && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{t("commandPalette.searching")}</span>
          )}
          <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto p-1">
          {showEmpty ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t("commandPalette.empty")}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {g.heading}
                </div>
                {g.rows.map((row) => {
                  const idx = abs++
                  const isHighlighted = highlighted === idx
                  const Icon = row.icon
                  return (
                    <button
                      key={`${g.key}-${row.href}`}
                      type="button"
                      onMouseEnter={() => setHighlighted(idx)}
                      onClick={() => go(row.href)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors",
                        isHighlighted
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-left">{row.primary}</span>
                      {row.secondary && (
                        <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">
                          {row.secondary}
                        </span>
                      )}
                      {row.shortcut && (
                        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {row.shortcut}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
