import Link from "next/link"
import { CrownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  projectSlug: string
  agentId: string | null
  agentPart: string | null
  /** "main" shows the crown. */
  agentRole?: string | null
  ownerName?: string | null
  className?: string
}

/**
 * Compact "who wrote this" marker: agent part (links to the agent detail), a
 * crown when it is the project main agent, and the owner name. Used in thread /
 * event lists and the overview cards so rows show which agent (and whose) acted.
 *
 * When placed inside a row that itself is a stretched link, pass a `relative
 * z-10` className so this link stays clickable above the row overlay.
 */
export function AgentAuthor({
  projectSlug,
  agentId,
  agentPart,
  agentRole,
  ownerName,
  className,
}: Props) {
  if (!agentPart) return null
  const isMain = agentRole === "main"

  const inner = (
    <span className="inline-flex items-center gap-1 font-mono font-medium text-foreground/80">
      {isMain && <CrownIcon className="h-3 w-3 shrink-0 text-amber-500" />}
      {agentPart}
    </span>
  )

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
      {agentId ? (
        <Link
          href={`/projects/${projectSlug}/agents/${agentId}`}
          className="inline-flex items-center gap-1 truncate hover:underline"
        >
          {inner}
        </Link>
      ) : (
        inner
      )}
      {ownerName && (
        <>
          <span aria-hidden className="text-muted-foreground/60">·</span>
          <span className="truncate">{ownerName}</span>
        </>
      )}
    </span>
  )
}
