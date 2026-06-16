import { cn } from "@/lib/utils"

interface Props {
  /** Values oldest → newest. Scaled to the series' own max. */
  data: number[]
  className?: string
  title?: string
}

/**
 * Tiny dependency-free activity sparkline (mini bars), like the commit-frequency
 * graph in a GitHub repo list. Scaled to its own max; bars with no value show a
 * faint baseline so the cadence is still readable.
 */
export function Sparkline({ data, className, title }: Props) {
  const max = Math.max(1, ...data)
  const hasData = data.some((v) => v > 0)

  return (
    <div
      className={cn("flex h-9 items-end gap-px", className)}
      title={title}
      aria-hidden
    >
      {data.map((v, i) => (
        <div
          key={i}
          className={cn("w-full rounded-[1px]", v > 0 ? "bg-foreground/35" : "bg-foreground/10")}
          style={{ height: hasData ? `${Math.max(v > 0 ? 14 : 6, (v / max) * 100)}%` : "8%" }}
        />
      ))}
    </div>
  )
}
