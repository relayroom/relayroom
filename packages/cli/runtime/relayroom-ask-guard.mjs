#!/usr/bin/env node
// PreToolUse(AskUserQuestion) guard for Claude Code (Claude-only; other CLIs have
// no equivalent intercept and rely on RELAYROOM.md prompting).
//
// A non-main agent has NO human at its console, so an AskUserQuestion prompt just
// hangs. If this part is not the main agent, block the tool (exit 2) and tell the
// model to route the question to the main agent instead.
//
// We NEVER block from the local cache alone: the pager-written `.relayroom/.role`
// can be stale right after a role change, and a stale `default` would wrongly block
// a freshly-promoted main agent. So:
//   - cache "main"   -> allow immediately (don't add a network hop for the agent
//                       the human actively drives; worst case a just-demoted agent
//                       is briefly allowed, which is the safe fail-open direction).
//   - anything else  -> ask the hub for the authoritative role and block ONLY on a
//                       live "default". Any error/timeout/unknown -> allow.
// Everything fails OPEN, so the main agent is never wrongly blocked.
import { readFileSync } from "node:fs"

// Drain stdin - Claude pipes the tool payload in; we do not need it, but leaving it
// unread can wedge the parent on some platforms.
try { readFileSync(0) } catch { /* ignore */ }

const allow = () => process.exit(0)
function block() {
  process.stderr.write(
    "You are not the main agent, and no human is watching this session. Do not ask the " +
    "human directly. Send this question to the main agent with the relayroom `send` (or " +
    "`reply`) MCP tool, then stop - the pager will wake you when the main agent replies.\n",
  )
  process.exit(2)
}

// Fast path: a cached "main" allows without a network round-trip.
try {
  if (readFileSync(".relayroom/.role", "utf8").trim() === "main") allow()
} catch { /* no cache -> fall through to the authoritative check */ }

// Authoritative check (read-only) before ever blocking. Fail OPEN on anything odd.
let cfg = {}
try { cfg = JSON.parse(readFileSync(".relayroom/config.json", "utf8")) || {} } catch { /* ignore */ }
const { code, part, server, token } = cfg
if (!code || !part || !server) allow()

try {
  const url = `${String(server).replace(/\/$/, "")}/mcp/${encodeURIComponent(code)}/role?part=${encodeURIComponent(part)}`
  // Send the bearer when the worktree has one. Only when: an empty `Bearer ` is a
  // present-but-invalid credential, which the server rejects outright rather than
  // falling back to the connect code.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(2500),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  })
  if (res.ok) {
    const json = await res.json().catch(() => ({}))
    if (json && json.role === "default") block()
  } else {
    // Still fail OPEN - a guard that stops an agent because the hub is unhappy is
    // worse than a guard that misses. But say so: a rejected lookup silently
    // DISABLES this guard, and until now there was no way to tell that from a
    // legitimate "you are the main agent, go ahead".
    process.stderr.write(
      `relayroom ask-guard: role lookup returned ${res.status}` +
      `${res.status === 401 || res.status === 403 ? " (token missing or expired - run ./rr.sh setup)" : ""}` +
      "; allowing the question through\n",
    )
  }
} catch { /* unreachable/timeout -> allow */ }
allow()
