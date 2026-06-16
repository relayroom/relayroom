/** Project icon color presets (hex), shared by the new + settings project forms. */
export const PROJECT_COLORS = [
  "#171717", // ink
  "#64748b", // slate
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#10b981", // emerald
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#ec4899", // pink
] as const

export const DEFAULT_PROJECT_COLOR = "#3b82f6"

/**
 * A readable foreground (near-black or white) for text/checks placed on top of a
 * hex background, chosen by perceived luminance. Fixes the "black swatch hidden
 * by a black selection border" problem - the check just flips to white.
 */
export function readableOn(hex: string): string {
  const h = hex.replace("#", "").trim()
  if (h.length < 6) return "#ffffff"
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62 ? "#171717" : "#ffffff"
}

/** First two characters of a project name, for the circular icon. */
export function projectInitials(name: string): string {
  const n = name.trim()
  return n ? n.slice(0, 2).toUpperCase() : "?"
}
