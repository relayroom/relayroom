#!/usr/bin/env node
/**
 * RelayRoom usage reporter - a turn-end hook for Claude Code, Gemini CLI, and Codex.
 *
 * All three fire a hook when a turn finishes and pass a JSON payload on stdin
 * that includes a transcript path. This reads the transcript, sums the token
 * usage of the turn that just ended, and POSTs it to RelayRoom so the dashboard
 * usage charts and per-agent token summaries fill in. Best-effort: it never
 * throws or blocks the agent, and silently does nothing if it cannot read usage.
 *
 *   --agent claude|gemini|codex   which transcript format to parse
 *   --code <connect_code> --part <part> [--server <url>]
 *
 * The Claude parser is exact. The Codex and Gemini parsers follow each tool's
 * documented transcript format but are best-effort - verify against real output
 * for your tool version; on any mismatch they report nothing rather than guess.
 */
import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Best-effort diagnostics: set RELAYROOM_USAGE_DEBUG=1 to append one JSON line per
// invocation to ~/.relayroom/usage-debug.log, so a silent path (e.g. a hook that
// fires but yields no usage) can be traced. Never throws.
function dbg(obj) {
  if (!process.env.RELAYROOM_USAGE_DEBUG) return
  try {
    const dir = join(homedir(), ".relayroom")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "usage-debug.log"), JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
  } catch { /* ignore */ }
}

function arg(name, fb) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb
}
// Fall back to .relayroom/config.json so the hook works even when the command did
// not bake in --code/--part (written by `relayroom init`).
const CFG = (() => {
  try { return JSON.parse(readFileSync(join(arg("dir", process.cwd()), ".relayroom", "config.json"), "utf8")) || {} }
  catch { return {} }
})()
const AGENT = arg("agent", "claude")
const CODE = arg("code", CFG.code)
const PART = arg("part", CFG.part)
const SERVER = arg("server", CFG.server ?? "http://localhost:48801")

// Rough $/MTok by model family (input, output) - approximate, for an at-a-glance
// cost estimate. Token counts are exact; this is only the $ conversion.
function priceFor(model = "") {
  const m = model.toLowerCase()
  if (m.includes("opus")) return [15, 75]
  if (m.includes("sonnet")) return [3, 15]
  if (m.includes("haiku")) return [1, 5]
  if (m.includes("codex") || m.includes("gpt-5") || m.startsWith("o3") || m.startsWith("o4")) return [1.25, 10]
  if (m.includes("gpt-4")) return [2.5, 10]
  if (m.includes("gemini") && m.includes("flash")) return [0.3, 2.5]
  if (m.includes("gemini")) return [1.25, 10]
  return null
}

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// ── Claude Code: JSONL transcript, assistant usage back to the last user msg ──
function claudeUserText(row) {
  const c = row?.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ")
  if (typeof row?.message === "string") return row.message
  return ""
}

// Assistant TEXT blocks only (skip tool_use/tool_result) - the readable answer.
function claudeAssistantText(row) {
  const c = row?.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .filter((p) => typeof p === "string" || p?.type === "text")
      .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
      .join(" ")
  }
  return ""
}

function parseClaude(transcriptPath) {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
  let inTok = 0, outTok = 0, cacheTok = 0, model, title, summary, startedAt, endedAt
  for (let i = lines.length - 1; i >= 0; i--) {
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    if (row.type === "user") {
      // The user message that opened this turn = a natural title + start time.
      const txt = claudeUserText(row).replace(/\s+/g, " ").trim()
      if (txt) title = txt.slice(0, 80)
      if (row.timestamp) startedAt = row.timestamp
      break // turn boundary
    }
    if (row.type === "assistant") {
      const u = row.message?.usage
      if (u) {
        inTok += u.input_tokens ?? 0
        outTok += u.output_tokens ?? 0
        cacheTok += (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        model ??= row.message.model
        if (!endedAt && row.timestamp) endedAt = row.timestamp // latest assistant
      }
      // The LAST assistant text block of the turn = the answer (first one we hit
      // going backwards). Skips tool_use-only messages until it finds real text.
      if (!summary) {
        const at = claudeAssistantText(row).replace(/\s+/g, " ").trim()
        if (at) summary = at.slice(0, 500)
      }
    }
  }
  return { inTok, outTok, cacheTok, model, title, summary, startedAt, endedAt }
}

// ── Codex: rollout JSONL with `token_count` events; use the last turn's delta ──
function latestCodexRollout() {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl - pick the newest by mtime.
  const root = join(homedir(), ".codex", "sessions")
  let best = null, bestMtime = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs
        if (m > bestMtime) { bestMtime = m; best = p }
      }
    }
  }
  try { walk(root) } catch { /* no sessions dir */ }
  return best
}

function parseCodex(transcriptPath) {
  const path = transcriptPath || latestCodexRollout()
  if (!path) return null
  const rows = readJsonl(path)
  let last = null, model
  for (const row of rows) {
    const payload = row?.payload ?? row
    if (payload?.type === "token_count") last = payload
    // Model name shows up in the session/turn-context metadata.
    model ??= row?.payload?.model ?? row?.model ?? row?.payload?.info?.model
  }
  if (!last) return null
  // Prefer the per-turn delta (last_token_usage); fall back to whatever is present.
  const u = last.info?.last_token_usage ?? last.last_token_usage ?? last.info?.total_token_usage ?? last.usage ?? last
  const inTok = u.input_tokens ?? u.prompt_tokens ?? 0
  // Codex's output_tokens ALREADY includes reasoning tokens (total = input + output).
  // Adding reasoning_output_tokens again double-counts output. Use output directly;
  // only fall back to reasoning when no output field is present.
  const outTok = u.output_tokens ?? u.completion_tokens ?? u.reasoning_output_tokens ?? 0
  const cacheTok = u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0
  return { inTok, outTok, cacheTok, model }
}

// ── Gemini: JSONL transcript. Each assistant ("gemini") line carries `model` and a
// `tokens` object {input, output, cached, thoughts, ...}. The AfterAgent hook fires
// once per turn, so we take the MOST RECENT line that has tokens (the turn's final
// response). `input` already INCLUDES `cached`, so fresh input = input - cached.
function parseGemini(transcriptPath) {
  if (!transcriptPath) return null
  let lines
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    const tk = row?.tokens
    if (!tk || typeof tk !== "object") continue
    const input = tk.input ?? 0
    const cached = tk.cached ?? 0
    const inTok = Math.max(0, input - cached)         // fresh (non-cached) input
    const cacheTok = cached                            // cache read
    const outTok = (tk.output ?? 0) + (tk.thoughts ?? 0) // visible output + thinking
    if (inTok + outTok + cacheTok <= 0) continue
    return { inTok, outTok, cacheTok, model: row.model }
  }
  return null
}

async function main() {
  if (!CODE || !PART) return // misconfigured hook - stay silent

  let payload = {}
  try {
    const stdin = readFileSync(0, "utf8")
    if (stdin.trim()) payload = JSON.parse(stdin)
  } catch { /* no/!json stdin */ }
  const transcriptPath = payload.transcript_path
  dbg({ stage: "payload", agent: AGENT, hasCode: !!CODE, payloadKeys: Object.keys(payload), transcriptPath: transcriptPath ?? null })

  // Claude and Gemini need the transcript path from the hook payload; Codex can
  // fall back to its newest rollout file if the path is absent.
  if (!transcriptPath && AGENT !== "codex") { dbg({ stage: "no-transcript", agent: AGENT }); return }

  let parsed
  try {
    if (AGENT === "codex") parsed = parseCodex(transcriptPath)
    // agy (Antigravity) reuses Gemini's ~/.gemini config root + transcript format.
    else if (AGENT === "gemini" || AGENT === "agy") parsed = parseGemini(transcriptPath)
    else parsed = parseClaude(transcriptPath)
  } catch (err) { dbg({ stage: "parse-throw", agent: AGENT, err: String(err?.message ?? err) }); return }
  dbg({ stage: "parsed", agent: AGENT, parsed: parsed ?? null })
  if (!parsed) return

  const { inTok, outTok, cacheTok, model, title, summary, startedAt, endedAt } = parsed
  if (inTok + outTok + cacheTok <= 0) { dbg({ stage: "zero-usage", agent: AGENT }); return } // nothing to report

  let cost
  const p = priceFor(model)
  if (p) cost = +(((inTok + cacheTok) / 1e6) * p[0] + (outTok / 1e6) * p[1]).toFixed(6)

  const usage = { input_tokens: inTok, output_tokens: outTok, cache_tokens: cacheTok }
  if (model) usage.model = model
  if (cost != null) usage.cost_usd = cost

  const body = { part: PART, type: "complete", usage }
  // title = the prompt that opened the turn; summary = the agent's answer. Both let
  // the dashboard event show the full exchange, not just "a turn happened".
  if (title || summary) body.detail = { ...(title ? { title } : {}), ...(summary ? { summary } : {}) }
  if (startedAt) body.startedAt = startedAt
  if (endedAt) body.endedAt = endedAt

  try {
    const res = await fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // This runs as a turn-end HOOK: a stalled network must never block the agent.
      signal: AbortSignal.timeout(5000),
    })
    dbg({ stage: "posted", agent: AGENT, status: res.status, model: model ?? null, inTok, outTok })
  } catch (err) { dbg({ stage: "post-throw", agent: AGENT, err: String(err?.message ?? err) }) }
}

main().catch(() => {}).finally(() => process.exit(0))
