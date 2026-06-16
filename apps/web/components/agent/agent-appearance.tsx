import { Bot, BotMessageSquare, Cpu, BrainCircuit, Sparkles, Zap, Terminal, Ghost, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Agent appearance presets (color + icon). Stored on the agent as plain keys
 * (agents.color / agents.icon); resolved here to themed Tailwind classes and
 * lucide icons. Class strings are full literals so Tailwind's JIT keeps them.
 */
// NOTE: keys AND order must match AGENT_COLOR_HEX in @relayroom/shared
// (agent-colors.ts) - the auto color hashes the part over keys.slice(1), so web
// and server must agree. Each preset pairs an explicit bg + readable text color
// (no auto-inversion); the swatch is the solid dot.
export const AGENT_COLORS = [
  { key: "slate", swatch: "bg-slate-400", avatar: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  { key: "red", swatch: "bg-red-500", avatar: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  { key: "orange", swatch: "bg-orange-500", avatar: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300" },
  { key: "amber", swatch: "bg-amber-500", avatar: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  { key: "yellow", swatch: "bg-yellow-500", avatar: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300" },
  { key: "lime", swatch: "bg-lime-500", avatar: "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300" },
  { key: "green", swatch: "bg-green-500", avatar: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" },
  { key: "emerald", swatch: "bg-emerald-500", avatar: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  { key: "teal", swatch: "bg-teal-500", avatar: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300" },
  { key: "cyan", swatch: "bg-cyan-500", avatar: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300" },
  { key: "sky", swatch: "bg-sky-500", avatar: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  { key: "blue", swatch: "bg-blue-500", avatar: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  { key: "indigo", swatch: "bg-indigo-500", avatar: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" },
  { key: "violet", swatch: "bg-violet-500", avatar: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" },
  { key: "purple", swatch: "bg-purple-500", avatar: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300" },
  { key: "fuchsia", swatch: "bg-fuchsia-500", avatar: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300" },
  { key: "pink", swatch: "bg-pink-500", avatar: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300" },
  { key: "rose", swatch: "bg-rose-500", avatar: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
] as const

export type AgentColor = (typeof AGENT_COLORS)[number]
export type AgentColorKey = AgentColor["key"]

export const AGENT_ICONS: { key: string; Icon: LucideIcon }[] = [
  { key: "bot", Icon: Bot },
  { key: "bot-message", Icon: BotMessageSquare },
  { key: "cpu", Icon: Cpu },
  { key: "brain", Icon: BrainCircuit },
  { key: "sparkles", Icon: Sparkles },
  { key: "zap", Icon: Zap },
  { key: "terminal", Icon: Terminal },
  { key: "ghost", Icon: Ghost },
]

const COLOR_MAP = new Map<string, AgentColor>(AGENT_COLORS.map((c) => [c.key, c]))
const ICON_MAP = new Map<string, LucideIcon>(AGENT_ICONS.map((i) => [i.key, i.Icon]))

// Deterministic fallback color from a seed (the part name) so agents without an
// explicit color still look distinct. Skips slate (index 0) so auto gets a hue.
function hashIndex(seed: string, mod: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % mod
}

export function resolveAgentColor(color: string | null | undefined, seed: string): AgentColor {
  if (color && COLOR_MAP.has(color)) return COLOR_MAP.get(color)!
  const hued = AGENT_COLORS.slice(1)
  return hued[hashIndex(seed, hued.length)]!
}

export function resolveAgentIcon(icon: string | null | undefined): LucideIcon {
  return (icon ? ICON_MAP.get(icon) : undefined) ?? Bot
}

const SIZES = {
  sm: { box: "p-1.5", icon: "h-3.5 w-3.5" },
  md: { box: "p-2", icon: "h-4 w-4" },
  lg: { box: "p-3", icon: "h-6 w-6" },
}

/** The rounded color chip + chosen icon, used in the list, detail, dialog preview. */
export function AgentAvatar({
  color,
  icon,
  seed,
  size = "md",
  className,
}: {
  color?: string | null
  icon?: string | null
  seed: string
  size?: keyof typeof SIZES
  className?: string
}) {
  const c = resolveAgentColor(color, seed)
  const Icon = resolveAgentIcon(icon)
  const s = SIZES[size]
  return (
    <div className={cn("inline-flex shrink-0 items-center justify-center rounded-full", c.avatar, s.box, className)}>
      <Icon className={s.icon} />
    </div>
  )
}
