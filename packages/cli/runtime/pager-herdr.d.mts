/**
 * Types for the parts of the pager's herdr backend that `src/` shares.
 *
 * Only the pieces with two callers are declared. `processesLookLikeAgent` is here because
 * the CLI and the pager ask the same question of the same data, and a second copy of that
 * rule is a second thing to fix when it turns out to be wrong - which it did: the version
 * without `excludePids` reported the asker as an agent.
 */
export declare function processesLookLikeAgent(
  processes: Array<{ name?: string; pid?: number }> | null | undefined,
  excludePids?: Set<number> | number[],
): boolean
