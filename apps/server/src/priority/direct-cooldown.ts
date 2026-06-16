/**
 * Direct (width-1) sender->recipient cooldown (phase 06, spec §7/§15.1).
 *
 * A direct message (exactly one agent recipient) is higher-priority than a
 * broadcast, but to stop a width-1 ping-pong loop between two parts we apply a
 * 30s per-(sender part -> recipient part) cooldown. Within the window the wake is
 * SUPPRESSED (the message is still delivered); after it elapses a new wake may fire.
 *
 * DB-backed (not an in-memory Map) so the cooldown survives a server restart and so
 * the check/bump can be atomic with the wake reservation in the same transaction.
 */
import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '@relayroom/db'
import { directCooldowns } from '@relayroom/db'

export const DIRECT_COOLDOWN_MS = 30_000 // spec §15.1

/**
 * For width-1 only. If the previous direct send to this recipient was within the
 * cooldown window, returns { allowed: false } (suppress the wake). Otherwise
 * upserts lastAt to `now` and returns { allowed: true }. Call inside the same tx as
 * the wake reservation so the check + bump is atomic (no ping-pong race).
 */
export async function checkAndBumpDirectCooldown(
  tx: DbOrTx,
  senderAgentId: string,
  recipientAgentId: string,
  projectId: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean }> {
  const [row] = await tx
    .select({ lastAt: directCooldowns.lastAt })
    .from(directCooldowns)
    .where(
      and(
        eq(directCooldowns.senderAgentId, senderAgentId),
        eq(directCooldowns.recipientAgentId, recipientAgentId),
      ),
    )
    .limit(1)

  if (row && now.getTime() - row.lastAt.getTime() < DIRECT_COOLDOWN_MS) {
    return { allowed: false } // still cooling down -> suppress wake (delivery kept)
  }

  await tx
    .insert(directCooldowns)
    .values({ projectId, senderAgentId, recipientAgentId, lastAt: now })
    .onConflictDoUpdate({
      target: [directCooldowns.senderAgentId, directCooldowns.recipientAgentId],
      set: { lastAt: now },
    })
  return { allowed: true }
}
