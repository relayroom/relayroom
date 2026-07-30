import { and, eq } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { projects, threads } from "@relayroom/db/schema"

/**
 * NOT a `"use server"` module, deliberately.
 *
 * Every exported async function in a use-server file is a live endpoint reachable
 * without the UI. This function takes `orgId` as an argument and performs no session
 * check - it is the write half of an action that already authorised the caller.
 * Exported from `actions.ts` it would let anyone set any thread's status by naming
 * an org. It lives here so it can be imported by the action and by tests while
 * staying off the RPC surface.
 */

/**
 * Move a thread's status, but only if it still holds the status the caller saw.
 *
 * Compare-and-set rather than a plain UPDATE, because the dashboard is not the only
 * writer of this column: the MCP `close` tool and autoclose write it too. The guard
 * that resolves a thread and the write that changes it are two statements, and an
 * agent's close lands between them often enough to matter.
 *
 * Unconditionally, the later writer won and nobody learned anything. An agent could
 * close a thread - which marks the project for extraction - and a dashboard action a
 * moment later would move the status back, with both callers told they succeeded.
 * The result was a lesson distilled from a thread that is not closed.
 *
 * Returns false when the row no longer matches. A caller must NOT read that as
 * "nothing needed doing": a compare-and-set that reports a lost race as success is
 * the overwrite it was added to prevent, wearing a quieter hat.
 *
 * The org predicate stays here with the status one. Both conditions are in a single
 * WHERE so that neither can be satisfied by a separate earlier read - the pattern
 * this replaces was exactly a check that had gone stale by the time of the write.
 */
export async function setThreadStatusIfUnchanged(args: {
  threadId: string
  orgId: string
  expected: string
  next: string
}): Promise<boolean> {
  const [row] = await db
    .update(threads)
    .set({ status: args.next, updatedAt: new Date() })
    .from(projects)
    .where(
      and(
        eq(threads.id, args.threadId),
        eq(threads.projectId, projects.id),
        eq(projects.organizationId, args.orgId),
        eq(threads.status, args.expected),
      ),
    )
    .returning({ id: threads.id })

  return !!row
}
