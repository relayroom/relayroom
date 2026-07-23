// Pure, timezone-independent display helpers: text shaping and the relative-time
// bucket. Anything that has to name a wall-clock time lives in lib/date-format.ts,
// which needs the reader's timezone and so cannot be a bare function here.

/**
 * A short, human-readable title for an event row, instead of a raw UUID. Prefers
 * an explicit title/summary the agent sent (event.detail.title / .summary), then
 * a note's first line, then the spawned sub-agent label, then the type. Capped to
 * ~60 chars so it fits one line.
 */
export function eventTitle(e: {
  type: string
  detail?: Record<string, unknown> | null
  spawnedAgentLabel?: string | null
}): string {
  const d = e.detail ?? {}
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  let raw =
    pick(d.title) ??
    pick(d.summary) ??
    (pick(d.note) ? pick(d.note)!.split(/\r?\n/)[0]! : null) ??
    (e.spawnedAgentLabel ? `Spawned ${e.spawnedAgentLabel}` : null) ??
    e.type
  raw = raw.replace(/\s+/g, " ").trim()
  return raw.length > 60 ? `${raw.slice(0, 59)}…` : raw
}

/**
 * Flatten Markdown into a single clean line of plain text for previews. Strips
 * code fences, tables, headings, list markers, emphasis, blockquotes, and turns
 * links into their text - so a one-line preview reads naturally instead of
 * showing raw `| table |` / `**bold**` syntax. Not a full parser; good enough
 * for snippets.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^\s{0,3}>+\s?/gm, "") // blockquotes
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ") // horizontal rules
    .replace(/\|/g, " ") // table pipes
    .replace(/[*_~]/g, "") // emphasis markers
    .replace(/\s+/g, " ") // collapse whitespace/newlines
    .trim()
}

// Absolute date/time formatting moved to lib/date-format.ts, which states an
// instant in the READER's timezone. It used to live here, pinned to UTC+9.

/** A message key under `common.time` plus the number to interpolate. */
export interface TimeAgoParts {
  key: "justNow" | "minutes" | "hours" | "days"
  count: number
}

/**
 * Pick the unit and count for a relative time. Pure: no i18n, so it stays usable
 * from both the server and the client. `lib/time-ago.ts` turns this into text.
 *
 * Deliberately NOT Intl.RelativeTimeFormat / next-intl's `format.relativeTime`.
 * Both change what the UI says: with the default `numeric: "auto"`, Korean renders
 * -2 days as "그저께" rather than "2일 전", and automatic unit selection folds long
 * gaps into weeks and years, while these thresholds have no upper bound (400 days
 * reads as "400일 전"). There is also no Intl equivalent of the sub-minute "방금 전"
 * - `numeric: "always"` gives "0초 후". Keeping the thresholds here preserves the
 * existing output exactly; the keys make it translatable.
 */
export function timeAgoParts(iso: string): TimeAgoParts {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diffSec < 60) return { key: "justNow", count: 0 }
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return { key: "minutes", count: diffMin }
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return { key: "hours", count: diffHour }
  return { key: "days", count: Math.floor(diffHour / 24) }
}

/**
 * When a thread was last active: its newest message, or its creation if it has
 * none. Shared so the thread list and the project overview cannot drift on which
 * timestamp "last activity" means.
 */
export function threadActivityIso(thread: {
  lastMessageAt?: Date | null
  createdAt: Date
}): string {
  return (thread.lastMessageAt ?? thread.createdAt).toISOString()
}
