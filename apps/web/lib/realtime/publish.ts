import { sql } from "drizzle-orm"
import type { HubMessageEvent } from "@relayroom/shared"
import { db } from "@/lib/db"

const CHANNEL = "relayroom_events"

/**
 * The `fromPart` stamped on dashboard-originated (human) messages. Mirrors
 * `HUMAN_PART` in apps/server/src/wake/pipeline.ts (that constant lives in the
 * server app, which the web cannot import). Pagers render it as "from human".
 */
export const HUMAN_PART = "human"

/**
 * Emit live wake events for dashboard-originated (human) messages.
 *
 * The wake/SSE bus is Postgres LISTEN/NOTIFY on the `relayroom_events` channel
 * (apps/server/src/bus.ts). Postgres delivers a NOTIFY to every LISTEN session
 * regardless of which connection sent it, so the Hono server's LISTEN client
 * receives a NOTIFY emitted from this web process all the same. Emitting the
 * SAME HubMessageEvent the server's MCP send/reply path emits therefore drives
 * a real live wake: the recipient part's pager fires on
 * `evt.kind === 'message' && evt.part === <its part>` (relayroom-pager.mjs) and
 * the dashboard's SSE refreshes. This is the "server-side NOTIFY path" the
 * dashboard message writes previously lacked.
 *
 * Human-originated messages ALWAYS wake: the human is the operator steering the
 * agent, so there is no budget/cooldown gate here (those exist only to stop
 * agent-to-agent wake loops). Each event is one unconditional wake.
 *
 * Best-effort: the message rows are already committed by the caller, so a
 * NOTIFY failure only costs the live nudge (agents still see the message on
 * their next turn-start inbox check). Never throw.
 */
export async function publishMessageWakes(events: HubMessageEvent[]): Promise<void> {
  for (const event of events) {
    try {
      const json = JSON.stringify(event)
      // Postgres caps a NOTIFY payload at 8000 BYTES (UTF-8, not chars). Match the
      // server bus guard (bus.ts): an oversize payload is dropped from the live
      // path - the inbox row still exists, so the agent gets it on its next check.
      if (Buffer.byteLength(json, "utf8") > 7999) continue
      await db.execute(sql`select pg_notify(${CHANNEL}, ${json})`)
    } catch (err) {
      console.error("[publishMessageWakes]", err)
    }
  }
}
