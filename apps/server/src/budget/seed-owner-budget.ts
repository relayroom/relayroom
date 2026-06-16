import type { DbOrTx } from '@relayroom/db'
import { ownerWakeBudgets } from '@relayroom/db'

/**
 * Ensure an owner_wake_budget row exists for this owner principal (phase 11).
 *
 * Insert-if-absent (onConflictDoNothing): never overwrites a user's own slider
 * edits, so a returning agent connection keeps any value the owner set (even 0).
 *
 * Defaults from spec 15.1 (wakesPerHour=30, urgentPerHour=5) live ONLY in the
 * column defaults (01 schema). We insert userId alone and let the schema defaults
 * apply, keeping a single source of truth and avoiding a 30/5 drift across files.
 */
export async function seedOwnerWakeBudget(db: DbOrTx, userId: string): Promise<void> {
  await db.insert(ownerWakeBudgets)
    .values({ userId })
    .onConflictDoNothing({ target: ownerWakeBudgets.userId })
}
