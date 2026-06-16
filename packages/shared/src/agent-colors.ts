/**
 * Agent color presets as hex. The KEYS AND ORDER must stay identical to
 * AGENT_COLORS in apps/web/components/agent/agent-appearance.tsx, because the
 * auto color (when an agent has no explicit color) is a hash of the part over
 * `keys.slice(1)` - web and server must pick the same index for the same part.
 *
 * Hex is the Tailwind 500 shade (slate uses 400, the neutral). Used server-side
 * (the heartbeat) to hand the agent's color to the pager for the tmux status
 * line, where a truecolor hex is needed rather than a Tailwind class.
 */
export const AGENT_COLOR_HEX: Record<string, string> = {
  slate: '#94a3b8',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
}

/** Hue keys for the auto fallback - skip slate (index 0), the neutral. */
const HUE_KEYS = Object.keys(AGENT_COLOR_HEX).slice(1)

function hashIndex(seed: string, mod: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % mod
}

/** Resolve an agent's color key (or null/unknown = auto-hash from the part/seed)
 *  to a hex string. Mirrors resolveAgentColor() in the web app. */
export function resolveAgentColorHex(color: string | null | undefined, seed: string): string {
  if (color && AGENT_COLOR_HEX[color]) return AGENT_COLOR_HEX[color]
  return AGENT_COLOR_HEX[HUE_KEYS[hashIndex(seed, HUE_KEYS.length)]!]!
}
