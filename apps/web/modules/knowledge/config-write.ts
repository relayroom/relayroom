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
 * Merge keys into `project.knowledge_config`, and record that the project's
 * knowledge settings moved.
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
 * MARKS THE PROJECT DIRTY, AND NOTHING READS THAT MARKER TODAY. The automatic
 * extractor was removed in 0.7.0, and it was the only reader; `knowledge_dirty_at`
 * now has four writers and no consumer. This call is one of the four.
 *
 * It is kept rather than deleted because the marker answers a question the next
 * layer needs - when did this project's conversations and knowledge settings last
 * change - and a cross-thread reflection pass is what will ask it. Writing a column
 * nobody reads yet is cheaper than dropping one and adding it back.
 *
 * What must NOT be inferred from this line is that something acts on it. It used to
 * mean "revisit this project", and the recovery the settings screen once promised -
 * a thread emptied by an over-broad pattern coming back once the pattern was fixed -
 * was this call. That promise is gone with its reader, and the screen no longer
 * makes it. Correcting a redaction rule now changes what future distillation keeps
 * and nothing else.
 *
 * ONE TRANSACTION, for a narrower reason than it originally had. The original
 * argument named two failure orders, and one of them - a sweep consuming the marker
 * before the config commits - has no sweep left to do it. What remains is the other:
 * the config committing and the marker not, which would leave the column saying the
 * settings last moved earlier than they did. The eventual reader will be deciding
 * what has changed since a timestamp, and a marker that disagrees with the settings
 * beside it is worse than one that is absent.
 */
export async function mergeKnowledgeConfig(
  projectId: string,
  patch: Record<string, unknown>,
  options?: {
    /**
     * Keys to DELETE from the column before the patch is merged in.
     *
     * Merging cannot express removal - `||` only ever adds or overwrites - so a key
     * that must stop existing needs this. Overwriting it with null would not do: the
     * key would still be present, and a resolver that refuses on presence would go on
     * refusing.
     *
     * Removed before the merge, so a key named in both is set by the patch rather than
     * deleted by this.
     */
    removeKeys?: string[]
  },
): Promise<void> {
  const removeKeys = options?.removeKeys ?? []

  await db.transaction(async (tx) => {
    let config = sql`${projects.knowledgeConfig}`
    for (const key of removeKeys) config = sql`${config} - ${key}::text`
    config = sql`${config} || ${JSON.stringify(patch)}::jsonb`

    await tx
      .update(projects)
      .set({ knowledgeConfig: config })
      .where(eq(projects.id, projectId))

    // WRITTEN, AND NOTHING READS IT TODAY. One of `knowledge_dirty_at`'s four
    // writers and zero readers since the extractor was removed - see the docblock
    // for why the column stays. Do not read this line as evidence that a change to
    // redaction settings causes anything to be revisited.
    await markProjectKnowledgeDirty(tx, projectId)
  })
}
