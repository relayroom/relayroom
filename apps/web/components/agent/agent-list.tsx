"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"
import type { AgentStatus } from "@/components/agent/agent-status-badge"
import { MainAgentBadge } from "@/components/agent/main-agent-badge"
import { AgentStatusBadge } from "@/components/agent/agent-status-badge"
import { AgentDisconnectButton } from "@/components/agent/agent-disconnect-button"
import { AgentAvatar } from "@/components/agent/agent-appearance"
import { PagerStatusIcon } from "@/components/agent/pager-status-icon"
import { LimitedBadge } from "@/components/agent/limited-badge"
import { useTimeAgo } from "@/lib/time-ago"
import { cn } from "@/lib/utils"

// Statuses match the badges; filter runs in-memory over the SSR snapshot.
const STATUS_ORDER: AgentStatus[] = ["working", "idle", "offline", "error"]
type Filter = "all" | AgentStatus

/**
 * Shared agent list (filter bar + two-line rows), used by both the per-project
 * Agents tab and the global "my agents" page. Fields beyond the required core
 * are optional so either query row shape fits; the `show*` flags pick which
 * affordances render per page.
 */
export interface AgentListItem {
  id: string
  part: string
  role: string
  model: string | null
  activity: AgentStatus
  usageInput: number
  usageOutput: number
  // project context: drives the detail link and the optional project badge
  projectSlug: string
  projectName?: string | null
  // optional extras
  nickname?: string | null
  ownerName?: string | null
  color?: string | null
  icon?: string | null
  usageCache?: number
  connectionId?: string | null
  status?: string | null
  lastSeenAt?: Date | null
  connectionLastSeenAt?: Date | null
  /** Pager liveness (only present for project agents). */
  pagerOnline?: boolean
  /** Provider rate-limit expiry, or null if not limited. */
  limitedUntil?: Date | null
}

interface Props {
  items: AgentListItem[]
  /** Show the project badge (folder + name) on line 1 - for the cross-project view. */
  showProject?: boolean
  /** Show "Owner: <name>" on line 2 - for multi-user project views. */
  showOwner?: boolean
  /** Show the disconnect button + last-seen on the right - for the project tab. */
  showActions?: boolean
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}

export function AgentList({ items, showProject = false, showOwner = false, showActions = false }: Props) {
  const t = useTranslations("project")
  const tc = useTranslations("common")
  const timeAgo = useTimeAgo()
  const [filter, setFilter] = useState<Filter>("all")

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { working: 0, idle: 0, offline: 0, error: 0 }
    for (const a of items) c[a.activity]++
    return c
  }, [items])

  const visible = filter === "all" ? items : items.filter((a) => a.activity === filter)

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: t("agents.filterAll"), count: items.length },
    ...STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => ({
      key: s as Filter,
      label: tc(`agentStatus.${s}`),
      count: counts[s],
    })),
  ]

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => {
          const active = filter === chip.key
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                active ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {chip.label}
              <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-60")}>{chip.count}</span>
            </button>
          )
        })}
      </div>

      {/* Rows */}
      <div className="divide-y divide-border rounded-lg border border-border">
        {visible.map((agent) => {
          const isMain = agent.role === "main"
          const lastSeen = agent.connectionLastSeenAt ?? agent.lastSeenAt
          const cache = agent.usageCache ?? 0
          return (
            <div key={agent.id} className="flex items-center gap-3 p-4">
              {/* Per-agent color + icon (main-ness is shown by the crown badge). */}
              <AgentAvatar color={agent.color} icon={agent.icon} seed={agent.part} size="md" />

              <div className="min-w-0 flex-1">
                {/* Line 1: name + nickname + main badge + model (+ project badge) */}
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/projects/${agent.projectSlug}/agents/${agent.id}`}
                    className="truncate font-mono text-sm font-medium hover:underline"
                  >
                    {agent.part}
                  </Link>
                  {agent.nickname && (
                    <span className="truncate text-xs text-muted-foreground">&ldquo;{agent.nickname}&rdquo;</span>
                  )}
                  {isMain && <MainAgentBadge />}
                  {agent.model && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {agent.model}
                    </span>
                  )}
                  {agent.pagerOnline !== undefined && (
                    <PagerStatusIcon agentId={agent.id} status={agent.pagerOnline} />
                  )}
                  {agent.limitedUntil !== undefined && (
                    <LimitedBadge part={agent.part} limitedUntil={agent.limitedUntil ? agent.limitedUntil.toISOString() : null} />
                  )}
                  {showProject && agent.projectName && (
                    <Link
                      href={`/projects/${agent.projectSlug}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <FolderIcon className="h-3 w-3" />
                      {agent.projectName}
                    </Link>
                  )}
                </div>

                {/* Line 2: status + owner + tokens */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <AgentStatusBadge status={agent.activity} />
                  {showOwner && agent.ownerName && (
                    <span>
                      <span className="text-muted-foreground">{t("agents.ownerLabel")}:</span>{" "}
                      <span className="font-medium text-foreground">{agent.ownerName}</span>
                    </span>
                  )}
                  {(agent.usageInput > 0 || agent.usageOutput > 0 || cache > 0) && (
                    <span className="font-mono tabular-nums">
                      ↑{compact(agent.usageInput)} ↓{compact(agent.usageOutput)}
                      {cache > 0 && <span className="opacity-70"> · cache {compact(cache)}</span>}
                    </span>
                  )}
                </div>
              </div>

              {showActions && (
                <>
                  <div className="shrink-0 text-right">
                    {lastSeen ? (
                      <span className="font-mono text-xs text-muted-foreground">{timeAgo(lastSeen.toISOString())}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("agents.noActivity")}</span>
                    )}
                  </div>
                  {agent.connectionId && agent.status !== "revoked" ? (
                    <AgentDisconnectButton connectionId={agent.connectionId} partName={agent.part} />
                  ) : (
                    <div className="w-8" />
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
