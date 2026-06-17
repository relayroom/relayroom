import Link from "next/link"
import { MessageSquareIcon, CornerDownRightIcon } from "lucide-react"
import type { ThreadRow } from "@/modules/thread/queries"
import { AgentAuthor } from "@/components/agent/agent-author"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATUS_BADGE_STYLES: Record<string, string> = {
  open: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
  answered: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground border-border",
  holding: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
  canceled: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
}

interface Props {
  thread: ThreadRow
  projectSlug: string
  /** Pre-resolved status label (caller owns the i18n namespace). */
  statusLabel: string
  /** "full" = standalone list row (padding, hover, message count); "compact" =
   * inside an overview card (tighter, no message count). */
  variant?: "full" | "compact"
}

/**
 * One thread row: status badge (leading), title (stretched link to the thread),
 * preview, and the author agent (link + crown + owner). Shared by the threads
 * page and the overview "recent threads" card so the layout stays in one place.
 */
export function ThreadListItem({ thread, projectSlug, statusLabel, variant = "full" }: Props) {
  const compact = variant === "compact"
  const showMeta = !!thread.creatorAgentPart || !!thread.authorAgentPart || (!compact && thread.messageCount > 0)

  return (
    <div
      className={cn(
        "relative flex items-center",
        compact
          ? "gap-2.5 py-2.5 first:pt-0 last:pb-0"
          : "gap-3 px-4 py-3 transition-colors hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
          STATUS_BADGE_STYLES[thread.status] ?? "border-border bg-muted text-muted-foreground",
        )}
      >
        {statusLabel}
      </span>

      <div className="min-w-0 flex-1">
        <Link
          href={`/projects/${projectSlug}/threads/${thread.id}`}
          className="block truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
        >
          {thread.subject}
        </Link>
        {thread.lastMessagePreview && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{thread.lastMessagePreview}</p>
        )}
        {showMeta && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <AgentAuthor
              className="relative z-10"
              projectSlug={projectSlug}
              agentId={thread.creatorAgentId}
              agentPart={thread.creatorAgentPart}
              agentRole={thread.creatorAgentRole}
              ownerName={thread.creatorOwnerName}
            />
            {/* Last reply by a different agent than the creator: the row's identity
                stays the creator, but recent activity is still visible (↳ part). */}
            {thread.authorAgentPart && thread.authorAgentPart !== thread.creatorAgentPart && (
              <span className="inline-flex items-center gap-1 font-mono">
                <CornerDownRightIcon className="h-3 w-3 shrink-0" />
                {thread.authorAgentPart}
              </span>
            )}
            {!compact && thread.messageCount > 0 && (
              <>
                {(thread.creatorAgentPart || thread.authorAgentPart) && <span aria-hidden>·</span>}
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                  <MessageSquareIcon className="h-3 w-3" />
                  {thread.messageCount}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {thread.lastMessageAt
          ? timeAgo(thread.lastMessageAt.toISOString())
          : timeAgo(thread.createdAt.toISOString())}
      </span>
    </div>
  )
}
