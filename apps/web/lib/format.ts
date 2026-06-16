// All functions use fixed UTC+9 offset (KST) to ensure deterministic output
// in server components and avoid hydration mismatches.

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

const KST_OFFSET = 9 * 60 * 60 * 1000 // 9 hours in ms

function toKST(iso: string): Date {
  const utc = new Date(iso).getTime()
  return new Date(utc + KST_OFFSET)
}

/** Format as YYYY-MM-DD HH:mm (KST, Korean locale style) */
export function formatDateTime(iso: string): string {
  const d = toKST(iso)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

/** Simple relative time string in Korean */
export function timeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return '방금 전'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}분 전`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}시간 전`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}일 전`
}
