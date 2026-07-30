import { eq, sql } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { projects } from "@relayroom/db/schema"
import { markProjectKnowledgeDirty } from "@relayroom/db/knowledge"

/**
 * NOT a `"use server"` module.
 *
 * Every exported async function in a use-server file is an endpoint reachable
 * without the UI. This one takes a projectId and checks no session, because the
 * action that calls it has already authorised the caller. Exported from an actions
 * file it would let anyone rewrite any project's knowledge config.
 */

/**
 * Merge keys into `project.knowledge_config` and tell the extractor to look again.
 *
 * MERGE, NOT REPLACE. `knowledge_config` is one JSONB column holding several
 * unrelated settings - `kDistinctIssuers`, `windowDays`, `retentionDays`,
 * `dynamicFactsBlock` and the redaction keys. Writing the column with an object
 * containing only redaction keys deletes the others.
 *
 * None of those four has a write path today, so replacing the column would pass
 * every test we can write and lose nothing. That is what makes it worth guarding
 * now: the damage appears later, when someone adds a way to set one of them and
 * this write starts silently clearing it. `||` merges at the top level in the
 * database, so a concurrent writer touching a different key does not lose it
 * either - reading, merging in memory and writing back would.
 *
 * MARKS THE PROJECT DIRTY, IN THE SAME TRANSACTION. The extractor only revisits a
 * project that carries the marker. Changing redaction settings without it means a
 * thread that produced nothing - because an over-broad pattern removed everything
 * worth keeping - STAYS empty after the pattern is corrected, until some unrelated
 * thread happens to close. The recovery the settings screen promises is this call.
 *
 * One transaction rather than two statements, because either order fails on its
 * own and fails silently:
 *   - config first, then a crash: the settings are live and nothing asks for a
 *     re-look, so the recovery never happens for that project.
 *   - marker first, and a sweep consumes and clears it before the config commits:
 *     the marker that would have triggered the re-look is already spent.
 * Both leave the screen's promise false for one project with nothing recording it.
 *
 * That promise is the other half of a decision made in 0.5.2: extraction
 * deliberately writes no watermark when it produces nothing, precisely so a
 * corrected pattern can recover the thread. Not writing the watermark only keeps
 * recovery POSSIBLE - something still has to ask for it. Delete this call and that
 * earlier decision quietly stops meaning anything.
 *
 * Recovery has a boundary the UI states: only extractions that stored nothing come
 * back. One that stored a candidate holds a claim, so correcting a pattern does not
 * revisit it - purge is the tool for that.
 */
export async function mergeKnowledgeConfig(
  projectId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ knowledgeConfig: sql`${projects.knowledgeConfig} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(projects.id, projectId))

    await markProjectKnowledgeDirty(tx, projectId)
  })
}
