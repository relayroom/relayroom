"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, CheckIcon, InfoIcon, PlugZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { connectAgent } from "@/modules/agent/actions"
import { useRealtime } from "@/components/realtime/realtime-provider"

type AgentId = "claude" | "gemini" | "codex"
// Selectable CLIs in the connect guide. Gemini is temporarily HIDDEN (not removed):
// gemini-3-flash-preview reaches for shell/curl instead of the RelayRoom MCP tools
// and flails in the wake loop. CLI support stays intact (providers.ts, init, hooks)
// so re-enabling is just uncommenting the line once a reliable gemini model is used.
const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  // { id: "gemini", label: "Gemini CLI" }, // hidden: flash-preview ignores MCP tools (re-enable with a stronger model)
  { id: "codex", label: "Codex" },
]

// How to invoke the RelayRoom CLI. Defaults to `npx -y @relayroom/cli` (works for
// anyone once published - npx auto-fetches it). For local dev before publish, set
// NEXT_PUBLIC_RELAYROOM_CLI=relayroom (the `npm link`ed global bin), since npx
// can't resolve an unpublished scoped package and 404s.
const CLI_CMD = process.env.NEXT_PUBLIC_RELAYROOM_CLI ?? "npx -y @relayroom/cli"

// The token authenticates every MCP call. Bake it into the command so the agent
// authenticates directly (no OAuth/IDE prompt): claude/gemini take an inline
// header; codex reads it from an env var (the `export` line above the add). We
// remove any existing entry first so a re-connect swaps in the fresh token
// instead of hitting "already exists" and keeping a stale (failing) config.
function mcpAddCommand(agent: AgentId, name: string, url: string, token: string): string {
  const bin = agent === "codex" ? "codex" : agent === "gemini" ? "gemini" : "claude"
  const add =
    agent === "codex"
      ? `${bin} mcp add ${name} --url "${url}" --bearer-token-env-var RELAYROOM_TOKEN`
      : `${bin} mcp add --transport http ${name} "${url}" --header "Authorization: Bearer ${token}"`
  return `${bin} mcp remove ${name} 2>/dev/null; ${add}`
}

// Each CLI's "skip all approval prompts" launch flag. Opt-in (off by default): handy
// for trusted local agents, but it bypasses ALL permission checks, not just RelayRoom.
function bypassFlag(agent: AgentId): string {
  return agent === "codex"
    ? "--dangerously-bypass-approvals-and-sandbox"
    : agent === "gemini"
      ? "--yolo"
      : "--dangerously-skip-permissions"
}

interface Props {
  connectCode: string
  /** The agent part to connect a local coding tool to. */
  part: string
  /** Project slug - makes the tmux session name unique across projects, so two
   * projects can both have a "main" agent without a `tmux new -s main` collision. */
  projectSlug: string
  serverBase?: string
  triggerLabel?: string
  /** Open on mount (e.g. right after registration, via ?connect=1). */
  defaultOpen?: boolean
}

/**
 * Shows how to connect a local coding tool (Claude Code / Codex / Gemini) to an
 * already-registered agent - one job. Issues a fresh auth token when opened and
 * renders the copy-paste setup commands. Separate from the register dialog.
 */
export function AgentConnectGuideDialog({ connectCode, part, projectSlug, serverBase, triggerLabel, defaultOpen }: Props) {
  const base = serverBase ?? process.env.NEXT_PUBLIC_RELAYROOM_SERVER_BASE ?? "http://localhost:48801"
  const t = useTranslations("project")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(defaultOpen ?? false)
  // CLIs to connect. Single-select by default; the multi checkbox opts into
  // picking several (advanced rotation setup, see the note when >1).
  const [selected, setSelected] = useState<AgentId[]>(["claude"])
  const [multiMode, setMultiMode] = useState(false)
  // Opt-in: append each CLI's "skip approval prompts" launch flag to the foreground
  // launch line. Off by default (it bypasses all permission checks).
  const [bypassMode, setBypassMode] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  // Guard so the token is issued exactly once per open - NOT a cancellable
  // effect, because router.replace (stripping ?connect) re-renders mid-request
  // and a cancel flag would drop the result, leaving the dialog stuck loading.
  const issuingRef = useRef(false)

  useEffect(() => {
    if (!open || token || issuingRef.current) return
    issuingRef.current = true
    connectAgent({ connectCode, part, nickname: "" })
      .then((res) => {
        if (res.result) setToken(res.item.token)
        else {
          issuingRef.current = false
          toast.error(res.message ?? t("agentConnect.toastError"))
        }
      })
      .catch(() => {
        issuingRef.current = false
        toast.error(t("agentConnect.toastError"))
      })
  }, [open, token, connectCode, part, t])

  // Auto-opened via ?connect=1: strip ONLY the connect param (keep any other query),
  // so a refresh won't reopen/reissue but unrelated params survive.
  useEffect(() => {
    if (defaultOpen) {
      const params = new URLSearchParams(searchParams.toString())
      params.delete("connect")
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the agent's pager first beats (it connected), confirm + close the dialog.
  // The pager event arrives over the project SSE stream; guard so we fire once.
  const realtime = useRealtime()
  const confirmedRef = useRef(false)
  useEffect(() => {
    if (!open || !realtime) return
    return realtime.onAgentConnected(part, () => {
      if (confirmedRef.current) return
      confirmedRef.current = true
      toast.success(t("agentConnectGuide.toastConnected", { part }))
      setOpen(false)
      router.refresh()
    })
  }, [open, realtime, part, t, router])

  // Reset per-open state when the dialog CLOSES, so a reopen issues a FRESH token and
  // the connect-confirmation can fire again. Without this, a reopened dialog reuses a
  // stale token (the issue-once guard sees the old one) and the once-guard swallows
  // the pager-connected event forever.
  useEffect(() => {
    if (!open) {
      setToken(null)
      issuingRef.current = false
      confirmedRef.current = false
    }
  }, [open])

  // Toggle a CLI in/out of the selection, keeping canonical (AGENTS) order and
  // never letting the selection drop to empty.
  const toggleAgent = (id: AgentId) =>
    setSelected((prev) =>
      prev.includes(id)
        ? prev.length > 1
          ? prev.filter((x) => x !== id)
          : prev
        : AGENTS.filter((a) => a.id === id || prev.includes(a.id)).map((a) => a.id),
    )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlugZapIcon className="mr-1.5 size-[16px]" />
        {triggerLabel ?? t("agentConnectGuide.triggerLabel")}
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl lg:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("agentConnectGuide.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t.rich("agentConnectGuide.dialogDescription", { part: () => <strong className="font-mono">{part}</strong> })}
          </DialogDescription>
        </DialogHeader>

        {!token ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
            {t("agentConnectGuide.preparing")}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("agentConnectGuide.selectHint")}</p>
              <div className="inline-flex gap-0.5 rounded-md border border-border p-0.5">
                {AGENTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={selected.includes(a.id)}
                    // Single-select by default (one CLI = one click); in multi mode a
                    // click toggles membership so several CLIs can be picked.
                    onClick={() => (multiMode ? toggleAgent(a.id) : setSelected([a.id]))}
                    className={cn(
                      "cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      selected.includes(a.id)
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  // Soften the component's default rounded-none (override via cn merge).
                  className="rounded-sm"
                  checked={multiMode}
                  // Turning multi off collapses back to a single CLI (keep the first).
                  onCheckedChange={(checked) => {
                    setMultiMode(checked === true)
                    if (!checked) setSelected((prev) => prev.slice(0, 1))
                  }}
                />
                {t("agentConnectGuide.multiToggle")}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  className="rounded-sm"
                  checked={bypassMode}
                  onCheckedChange={(checked) => setBypassMode(checked === true)}
                />
                {t("agentConnectGuide.bypassToggle")}
              </label>
            </div>

            {(() => {
              const url = `${base}/mcp/${connectCode}?part=${part}`
              // Selected CLIs in canonical order; the first one is launched at the end.
              const clis = AGENTS.filter((a) => selected.includes(a.id)).map((a) => a.id)
              const multi = clis.length > 1
              // Unique tmux session per project+part so a shared part name (e.g.
              // "main") across projects doesn't collide on the tmux server.
              const session = `${projectSlug}-${part}`
              // Block 1 creates + attaches the tmux session (alone - `tmux new`
              // steals the terminal, so nothing can follow it in one paste).
              const tmuxCmd = `tmux new -s ${session}`
              // Block 2 runs INSIDE that session: register + set up every selected CLI,
              // start ONE pager in the background, then launch the first CLI in the
              // foreground - all in one paste, so no second terminal is needed. The
              // pager wakes whichever CLI is in front via `tmux send-keys`.
              const insideLines: string[] = clis.includes("codex") ? [`export RELAYROOM_TOKEN="${token}"`] : []
              for (const cli of clis) insideLines.push(mcpAddCommand(cli, "relayroom", url, token))
              insideLines.push(
                // One init wires RELAYROOM.md + each CLI's instruction file (CSV).
                // Pass --server so init fetches RELAYROOM.md from THIS hub (matching the
                // mcp add URL); without it, init falls back to localhost and 404s on a
                // remote/LAN deployment.
                `${CLI_CMD} init --code ${connectCode} --part ${part} --target ${session} --agent ${clis.join(",")} --token ${token} --server ${base}`,
              )
              for (const cli of clis) insideLines.push(`${CLI_CMD} hooks install --agent ${cli}`)
              // One channel-aware launcher: ./rr.sh launch decides wake delivery
              // (Claude Channels when supported, else the pager), starts the pager in
              // that mode, then runs the first CLI in the foreground - in the right
              // order so channels actually activate. `--bypass` appends the CLI's
              // skip-all-approvals flag when the user opted in.
              insideLines.push(bypassMode ? `./rr.sh launch --bypass` : `./rr.sh launch`)
              const insideCmd = insideLines.join("\n")
              return (
                <div className="space-y-3">
                  <CmdBlock label={t("agentConnectGuide.step1Label")} command={tmuxCmd} />
                  <CmdBlock
                    label={t("agentConnectGuide.step2Label")}
                    hint={multi ? t("agentConnectGuide.step2HintMulti") : t("agentConnectGuide.step2Hint")}
                    command={insideCmd}
                  />
                  {multi && (
                    <div className="space-y-2 rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2.5 text-xs dark:border-amber-900/50 dark:bg-amber-950/20">
                      <p className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200">
                        <InfoIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        {t("agentConnectGuide.handoffTitle")}
                      </p>
                      <p className="text-amber-800/90 dark:text-amber-200/80">{t("agentConnectGuide.handoffNote")}</p>
                      <p className="text-amber-800/90 dark:text-amber-200/80">{t("agentConnectGuide.switchHint")}</p>
                    </div>
                  )}
                </div>
              )
            })()}

            <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2.5 text-xs dark:border-amber-900/50 dark:bg-amber-950/20">
              <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-amber-800 dark:text-amber-200">{t("agentConnect.folderNote")}</p>
            </div>
            <Button variant="outline" className="w-full" onClick={() => setOpen(false)}>
              {t("agentConnect.closeButton")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A labeled, copy-paste command block (its own copy state). */
function CmdBlock({ label, hint, command }: { label: string; hint?: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {/* Copy button overlays the top-right of the code (no reserved flex column, so
          long multi-line commands don't leave an empty gap beside the button). The
          code reserves right padding so the first line never runs under it. */}
      <div className="relative rounded border bg-muted/50">
        <code className="block whitespace-pre-wrap break-all p-2 pr-10 font-mono text-xs">{command}</code>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            } catch {
              /* ignore */
            }
          }}
          className="absolute right-1.5 top-1.5 h-7 w-7 bg-muted/80 p-0 backdrop-blur"
          aria-label="Copy command"
        >
          {copied ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <CopyIcon className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
