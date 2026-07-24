/**
 * The extraction rule (FEAT-0004 L3) - THE SWAP POINT.
 *
 * This is the ONE function that decides what a closed thread becomes as knowledge.
 * L3 ships the machinery around it (durable marker, leased single-writer sweep,
 * candidate-only writes, redaction, retention); the *intelligence* of extraction is
 * deliberately minimal and lives here alone, so that when a smarter extractor -
 * heuristic or model - arrives, only this function changes. sweep, lease, marker,
 * redaction, and retention do not. It is the deliberate inverse of the "one rule,
 * one place" theme: the part that is expected to change is isolated to one place.
 *
 * WHY A CRUDE RULE IS SAFE. The output is always a CANDIDATE, and a candidate is
 * invisible to `recall` until a non-agent issuer promotes it (K independent
 * signals - human or CI, never the work agent). So even a rough guess cannot
 * contaminate what other agents retrieve: if nobody promotes it, nobody sees it.
 * That is why "minimal extraction" is honest rather than reckless, and it is the
 * answer to a later reader asking "this extraction is awfully crude, is that ok?".
 *
 * The L3 rule: one candidate per thread, titled by its subject, bodied by the last
 * substantive message (redacted). `kind` is fixed to 'decision' - a WEAK HEURISTIC
 * ("a resolved thread records a decision"), not a spec. A real extractor would infer
 * kind from content; until then everything reads as 'decision', and that is a chosen
 * placeholder, not a bug.
 */
import { redact } from './redaction'

/** A knowledge kind the extractor may assign. See KIND_HEURISTIC below. */
export type KnowledgeKind = 'fact' | 'convention' | 'pitfall' | 'decision'

/**
 * Fixed kind for the L3 minimal extractor. A weak assumption that a closed thread
 * is a decision record; replace with real inference when the extractor gains it.
 */
export const KIND_HEURISTIC: KnowledgeKind = 'decision'

/** Max characters kept from the source message; a candidate body is a lead, not a log. */
const MAX_BODY_CHARS = 2000

export interface ExtractThreadInput {
  threadId: string
  subject: string
  /** Thread messages, oldest first. `fromAgentId: null` marks a system/human-lane row. */
  messages: { body: string; fromAgentId: string | null; createdAt: Date }[]
}

export interface ExtractedCandidate {
  title: string
  body: string
  kind: KnowledgeKind
  sourceRefs: { threadId: string }[]
}

/**
 * Extract at most one candidate from a closed thread, or null when there is nothing
 * to say (no substantive message, or the body was entirely redacted away).
 *
 * `redactionPatterns` is applied to the body BEFORE it becomes a candidate - the
 * extractor reads raw thread text, so this is where a secret in a message is dropped
 * rather than copied into the knowledge table. If redaction removes everything, no
 * candidate is produced: an empty body is not knowledge.
 */
export function extractCandidateFromThread(
  input: ExtractThreadInput,
  redactionPatterns: readonly string[],
): ExtractedCandidate | null {
  // The last message with an agent author. A thread's resolution is its last real
  // exchange; system/human-lane rows (fromAgentId null) are not the lesson.
  const substantive = [...input.messages].reverse().find(m => m.fromAgentId !== null)
  if (!substantive) return null

  const title = redact(input.subject, redactionPatterns).text.trim()
  const body = redact(substantive.body, redactionPatterns).text.trim().slice(0, MAX_BODY_CHARS)

  // Title can be empty after redaction; fall back so a candidate is never titleless,
  // but a fully-redacted BODY means there is no lesson left to keep.
  if (body === '') return null

  return {
    title: title === '' ? '(redacted)' : title,
    body,
    kind: KIND_HEURISTIC,
    sourceRefs: [{ threadId: input.threadId }],
  }
}
