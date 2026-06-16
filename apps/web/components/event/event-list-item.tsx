import Link from "next/link"
import type { EventRow } from "@/modules/event/queries"
import { AgentAuthor } from "@/components/agent/agent-author"
import { timeAgo, eventTitle } from "@/lib/format"
import { cn } from "@/lib/utils"

const EVENT_TYPE_STYLES: Record<string, string> = {
  spawn: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300",
  progress: "bg-muted text-muted-foreground border-border",
  complete: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  error: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
  message: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}

interface Props {
  event: EventRow
  projectSlug: string
  /** "full" = events page (model / tokens / cost meta); "compact" = overview card. */
  variant?: "full" | "compact"
}

/**
 * One event row: type badge (leading), title (stretched link to the event), the
 * author agent (link + crown + owner), and — in full mode — model + token usage +
 * cost. Shared by the events page and the overview "recent events" card.
 */
export function EventListItem({ event, projectSlug, variant = "full" }: Props) {
  const compact = variant === "compact"
  const u = event.usage
  const inTok = u?.input_tokens ?? 0
  const outTok = u?.output_tokens ?? 0
  const hasCost = u?.cost_usd !== undefined
  const typeStyle = EVENT_TYPE_STYLES[event.type] ?? "border-border bg-muted text-muted-foreground"
  const showMeta = !!event.agentPart || (!compact && (!!u?.model || inTok > 0 || outTok > 0 || hasCost))

  return (
    <div
      className={cn(
        "relative flex items-center gap-3",
        compact ? "py-2.5 first:pt-0 last:pb-0" : "px-4 py-3 transition-colors hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium",
          typeStyle,
        )}
      >
        {event.type}
      </span>

      <div className="min-w-0 flex-1">
        <Link
          href={`/projects/${projectSlug}/events/${event.id}`}
          className="block truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
        >
          {eventTitle(event)}
        </Link>
        {showMeta && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <AgentAuthor
              className="relative z-10"
              projectSlug={projectSlug}
              agentId={event.agentId}
              agentPart={event.agentPart}
              agentRole={event.agentRole}
              ownerName={event.ownerName}
            />
            {!compact && u?.model && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">{u.model}</span>
              </>
            )}
            {!compact && (inTok > 0 || outTok > 0 || hasCost) && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono tabular-nums">
                  ↑{compactNum(inTok)} ↓{compactNum(outTok)}
                  {hasCost && <span className="text-muted-foreground/80"> · ${u!.cost_usd!.toFixed(4)}</span>}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {timeAgo(event.createdAt.toISOString())}
      </span>
    </div>
  )
}
