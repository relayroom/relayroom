import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface PaginationProps {
  page: number
  totalPages: number
  /** Builds the href for a given page number. */
  hrefFor: (page: number) => string
  className?: string
}

/** Compact page list with ellipses around the current page: [1, …, 4, 5, 6, …, 20]. */
function pageList(current: number, total: number): (number | "…")[] {
  const out: (number | "…")[] = []
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  out.push(1)
  if (left > 2) out.push("…")
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push("…")
  if (total > 1) out.push(total)
  return out
}

function PaginationLink({
  href,
  active,
  ariaLabel,
  children,
}: {
  href?: string
  active?: boolean
  ariaLabel?: string
  children: React.ReactNode
}) {
  const cls = cn(
    "inline-flex h-9 min-w-9 items-center justify-center rounded-md border px-2.5 text-sm font-medium transition-colors",
    active
      ? "border-foreground bg-foreground text-background"
      : "border-border text-foreground hover:bg-accent hover:text-accent-foreground",
    !href && "pointer-events-none opacity-40",
  )
  if (!href) {
    return (
      <span aria-disabled className={cls}>
        {children}
      </span>
    )
  }
  return (
    <Link href={href} aria-label={ariaLabel} aria-current={active ? "page" : undefined} className={cls}>
      {children}
    </Link>
  )
}

/**
 * Centered pagination (shadcn-style): prev / numbered pages with ellipses / next.
 * Server-friendly - renders Links via the supplied hrefFor builder. Renders
 * nothing when there is a single page.
 */
export function Pagination({ page, totalPages, hrefFor, className }: PaginationProps) {
  if (totalPages <= 1) return null
  const pages = pageList(page, totalPages)

  return (
    <nav role="navigation" aria-label="pagination" className={cn("flex justify-center", className)}>
      <ul className="flex items-center gap-1">
        <li>
          <PaginationLink href={page > 1 ? hrefFor(page - 1) : undefined} ariaLabel="Previous page">
            <ChevronLeftIcon className="h-4 w-4" />
          </PaginationLink>
        </li>
        {pages.map((p, i) =>
          p === "…" ? (
            <li key={`ellipsis-${i}`}>
              <span className="flex h-9 w-9 items-center justify-center text-muted-foreground">
                <MoreHorizontalIcon className="h-4 w-4" />
              </span>
            </li>
          ) : (
            <li key={p}>
              <PaginationLink href={hrefFor(p)} active={p === page}>
                {p}
              </PaginationLink>
            </li>
          ),
        )}
        <li>
          <PaginationLink href={page < totalPages ? hrefFor(page + 1) : undefined} ariaLabel="Next page">
            <ChevronRightIcon className="h-4 w-4" />
          </PaginationLink>
        </li>
      </ul>
    </nav>
  )
}
