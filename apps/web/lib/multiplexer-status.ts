/**
 * What a part is actually delivering wakes through, and whether that is working.
 *
 * TWO QUESTIONS, TWO VALUES, deliberately not folded into one badge. "Which
 * multiplexer" and "is delivery getting through" have different sources, different
 * failure modes, and - this is the part that makes folding them wrong - different
 * answers to "do we know yet". A part can be delivering through herdr with no idea
 * whether that works (nothing has been sent to it), and a part can be visibly stuck
 * while its multiplexer is exactly what was asked for.
 *
 * Neither value is ever derived from the connect dialog's selector. That selector is
 * what an operator asked for; these come from what the pager measured on the machine.
 */

/** The two multiplexers, plus the honest third value. */
export type MultiplexerName = "tmux" | "herdr"

export type MultiplexerDelivery =
  /** The pager has never told us. NOT tmux - see the note on `deriveMultiplexer`. */
  | { kind: "unreported" }
  /** Delivering through the multiplexer the worktree asked for. */
  | { kind: "match"; via: MultiplexerName }
  /**
   * Asked for herdr, delivering through tmux. Wakes still arrive: the pager falls
   * back on purpose rather than going silent, so this is degraded, not broken.
   */
  | { kind: "degraded"; intent: MultiplexerName; via: MultiplexerName }

/**
 * Turn the two reported columns into one description.
 *
 * NULL IS NOT TMUX. Every pager older than the release that added these columns
 * reports neither, so treating a missing value as tmux would put a confident tmux
 * badge on every part that has never been measured - a claim about the world made
 * from the absence of a claim. "Unreported" is the true statement, and it is also
 * the actionable one, because the fix is to update that machine's CLI.
 *
 * A value we do not recognise is treated as unreported for the same reason: a part
 * running a newer CLI that reports a third multiplexer should read as "this screen
 * cannot say", never as one of the two it happens to know.
 */
export function deriveMultiplexer(
  intent: string | null | undefined,
  active: string | null | undefined,
): MultiplexerDelivery {
  const i = asName(intent)
  const a = asName(active)
  if (!a) return { kind: "unreported" }
  // Intent missing but active known: report what is delivering rather than claiming
  // a disagreement we cannot see. Half a measurement is still a measurement.
  if (!i || i === a) return { kind: "match", via: a }
  return { kind: "degraded", intent: i, via: a }
}

function asName(v: string | null | undefined): MultiplexerName | null {
  return v === "tmux" || v === "herdr" ? v : null
}

/**
 * How long a pending wake may sit with a lease before delivery counts as stuck.
 *
 * The pager claims a lease, then delivers, then reports. A wake that still holds a
 * lease well after issuance is one the pager took and could not hand over - the case
 * where a worktree asked for herdr, found no socket, fell back to tmux, and has no
 * tmux session either. Generous enough to clear the retry curve, so a momentarily
 * busy TUI is not called broken.
 */
export const WAKE_STALL_MS = 60_000

/**
 * Whether wakes are visibly failing to reach this part.
 *
 * TRUE IS AN OBSERVATION; FALSE IS NOT THE OPPOSITE ONE. False means "no stuck wake
 * is on record", which covers both a part delivering fine and a part nothing has
 * been sent to yet. It is deliberately not named `deliveryHealthy`: nothing here
 * measures health, and a name that claimed to would put a green light on a part
 * whose delivery has never once been exercised.
 *
 * Requires the pager to be alive. A dead pager delivers nothing either, but that is
 * already reported as a dead pager, and reporting it twice in different words makes
 * one screen look like two problems.
 */
export function isDeliveryStalled(args: {
  pagerOnline: boolean
  /** Oldest pending wake that a pager has leased and never reported delivering. */
  stalledWakeSince: Date | null | undefined
  now?: Date
}): boolean {
  if (!args.pagerOnline || !args.stalledWakeSince) return false
  const now = args.now ?? new Date()
  return now.getTime() - args.stalledWakeSince.getTime() >= WAKE_STALL_MS
}
