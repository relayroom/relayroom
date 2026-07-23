/**
 * Pure text builders for the pager's tmux nudge. Kept in their own side-effect-free
 * module so they can be unit-tested WITHOUT importing the pager (which parses argv and
 * `process.exit(1)`s / runs `main()` on import), and so the keystroke sanitizer has a
 * single home.
 */

// The sanitizer now lives in wake-client.mjs so the channel server is held to the
// same rule; the keystroke-injection rationale is documented there. Re-exported under
// the original name because that is what the regression tests and the pager call it.
export { sanitizeField as sanitizeForKeys } from "./wake-client.mjs"
import { sanitizeField as sanitizeForKeys } from "./wake-client.mjs"

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
