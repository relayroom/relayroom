/**
 * Writing one key of `knowledge_config` without destroying the others, and
 * recording that the project's knowledge settings moved.
 *
 * Both properties are invisible in normal use, and the second one is invisible in a
 * stronger sense since 0.7.0: `knowledge_dirty_at` has no reader at all now that the
 * automatic extractor is gone, so nothing observable happens either way. The column
 * is kept for the reflection pass that will ask when a project last changed, and
 * these tests hold the writes to the shape that pass will need.
 *
 * They are therefore NOT evidence that anything consumes the marker. A test named
 * after a behaviour nobody performs is the way that misreading gets made.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { projects } from "@relayroom/db/schema"
import { mergeKnowledgeConfig } from "./config-write"

const ORG = "org-kc"
let projectId: string

async function config(): Promise<Record<string, unknown>> {
  const [p] = await db.select({ c: projects.knowledgeConfig }).from(projects).where(eq(projects.id, projectId))
  return (p?.c ?? {}) as Record<string, unknown>
}

async function dirtyAt(): Promise<Date | null> {
  const [p] = await db.select({ d: projects.knowledgeDirtyAt }).from(projects).where(eq(projects.id, projectId))
  return p?.d ?? null
}

beforeEach(async () => {
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "kc", name: "KC", connectCode: "kc-cc" })
    .returning({ id: projects.id })
  projectId = p!.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("mergeKnowledgeConfig", () => {
  it("keeps config keys it was not asked to write", async () => {
    // The guard that matters. Nothing sets these today, so a whole-column write
    // would look correct forever - right up until someone adds a way to set one
    // and this write starts clearing it on every save.
    await db
      .update(projects)
      .set({ knowledgeConfig: { kDistinctIssuers: 3, retentionDays: 90 } })
      .where(eq(projects.id, projectId))

    await mergeKnowledgeConfig(projectId, { redactionRules: ["abc"] })

    const c = await config()
    expect(c.kDistinctIssuers).toBe(3)
    expect(c.retentionDays).toBe(90)
    expect(c.redactionRules).toEqual(["abc"])
  })

  it("replaces the value of a key it does write", async () => {
    // Merging must not turn into appending: the operator's new selection is the
    // whole selection, so a removed pattern has to actually go.
    await mergeKnowledgeConfig(projectId, { redactionRules: ["one", "two"] })
    await mergeKnowledgeConfig(projectId, { redactionRules: ["one"] })

    expect((await config()).redactionRules).toEqual(["one"])
  })

  it("records that the project's knowledge settings moved", async () => {
    // Nothing reads this today. It is pinned because the marker's value to the
    // eventual reader is that it is never later than the settings beside it - a
    // save that skipped it would leave the column claiming the project last
    // changed before a change it can see in the same row.
    await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, projectId))

    await mergeKnowledgeConfig(projectId, { redactionRules: [] })

    expect(await dirtyAt()).not.toBeNull()
  })

  it("leaves no marker behind when the save itself failed", async () => {
    // Partial cover for the atomicity requirement, and worth being exact about
    // which part. A NUL byte is rejected by jsonb, so the config write fails
    // deterministically, and the marker must not survive it.
    //
    // Verified by mutation: writing the marker first and the config second, as two
    // separate statements, fails here. The original reason to rule that order out
    // was a sweep consuming the marker before the config committed, and there is no
    // sweep any more; what it rules out now is a marker that claims the settings
    // moved when they did not, which is the one thing the future reader cannot
    // recover from.
    //
    // It does NOT cover the other order, config committed and the marker then
    // failing, because there is no way to make the marker update fail from a test.
    // That direction rests on the transaction boundary alone.
    await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, projectId))

    await expect(
      mergeKnowledgeConfig(projectId, { redactionRules: ["x" + String.fromCharCode(0) + "y"] }),
    ).rejects.toThrow()

    expect(await dirtyAt()).toBeNull()
  })

  it("writes an empty patch without disturbing anything", async () => {
    // Turning every rule off is a legitimate save, not an empty one, and it must
    // still record that the settings moved - it is the largest change an owner can
    // make to what future entries keep.
    await db
      .update(projects)
      .set({ knowledgeConfig: { kDistinctIssuers: 2 }, knowledgeDirtyAt: null })
      .where(eq(projects.id, projectId))

    await mergeKnowledgeConfig(projectId, {})

    expect((await config()).kDistinctIssuers).toBe(2)
    expect(await dirtyAt()).not.toBeNull()
  })
})
