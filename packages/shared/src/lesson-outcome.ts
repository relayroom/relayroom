/**
 * What happened to a lesson carried by `close`, as a value the caller can act on.
 *
 * THE POINT OF THE UNION: a lesson can fail for eight different reasons and the close
 * itself succeeds in all eight. If the outcome were a boolean or an absent field, an
 * agent that meant to record something would be told "ok" and would never learn that
 * nothing was stored - and the whole feature exists because knowledge silently fails to
 * be written. So the refusal carries its own code and a sentence the agent can read.
 *
 * `recorded: false` is NOT an error. The close happened; the lesson did not. An agent
 * that treats a refusal as a failed close will re-close a closed thread forever.
 */

/**
 * Every way a lesson can be refused.
 *
 * Split by WHEN they are decided, because the two halves have different costs:
 *
 * - The first six are decided BEFORE the transaction, so a refusal leaves nothing
 *   behind - no watermark, no partial row, no claim on the thread. That ordering is
 *   the reason a refusal cannot strand a thread the sweep would otherwise extract.
 * - The last two can only be known at the write itself, because both describe a race
 *   with another writer: the thread was claimed while we were preparing, or the
 *   project's redaction rules were replaced after we redacted with them.
 */
export type LessonRefusalCode =
  /** The thread was canceled, not resolved. A cancellation has no lesson in it. */
  | 'thread_canceled'
  /** This token may close threads but may not write knowledge. */
  | 'unauthorized'
  /** The project turned close-time distillation off. */
  | 'distill_disabled'
  /** A configured redaction rule could not be resolved, so nothing may be stored. */
  | 'redaction_unresolvable'
  /** The per-agent hourly ceiling for close-carried lessons was reached. */
  | 'rate_limited'
  /** Redaction removed everything; there is no lesson left to store. */
  | 'empty_after_redaction'
  /**
   * Something already decided this thread's knowledge: a retry, a competing close, the
   * sweep, or a purge. ONE CODE FOR ALL FOUR on purpose - close carries no idempotency
   * key, so the data cannot tell them apart, and a classification the data cannot
   * support is how a caller ends up told its lesson was stored when it was not.
   */
  | 'already_decided'
  /**
   * The lesson insert stored nothing and rolled back to its savepoint, after which the
   * close committed. NARROW: connection loss, statement timeout, deadlock and commit
   * failure are close-level failures, not lesson outcomes - they never reach here
   * because they take the whole transaction with them.
   *
   * Today it has exactly one producer: the project's redaction rules changed between
   * resolving them and the write, so the guard on the insert matched nothing. The
   * `reason` says so.
   */
  | 'storage_failed'

export type LessonOutcome =
  | { recorded: true, knowledgeId: string }
  | { recorded: false, code: LessonRefusalCode, reason: string }
