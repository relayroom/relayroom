/**
 * Writing one key of `knowledge_config` without destroying the others, and asking
 * the extractor to look again.
 *
 * Both properties are invisible in normal use. The other config keys have no write
 * path yet, so replacing the column loses nothing observable today; and a missing
 * dirty marker only shows up as a thread that stays empty after its pattern was
 * corrected. Neither would be caught by using the feature.
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

    await mergeKnowledgeConfig(projectId, { redactionPatterns: ["abc"] })

    const c = await config()
    expect(c.kDistinctIssuers).toBe(3)
    expect(c.retentionDays).toBe(90)
    expect(c.redactionPatterns).toEqual(["abc"])
  })

  it("replaces the value of a key it does write", async () => {
    // Merging must not turn into appending: the operator's new selection is the
    // whole selection, so a removed pattern has to actually go.
    await mergeKnowledgeConfig(projectId, { redactionPatterns: ["one", "two"] })
    await mergeKnowledgeConfig(projectId, { redactionPatterns: ["one"] })

    expect((await config()).redactionPatterns).toEqual(["one"])
  })

  it("marks the project dirty, which is what makes a corrected pattern take effect", async () => {
    // Without this the extractor never revisits, so a thread emptied by an
    // over-broad pattern stays empty after the pattern is fixed - until some
    // unrelated thread happens to close.
    await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, projectId))

    await mergeKnowledgeConfig(projectId, { redactionPatterns: [] })

    expect(await dirtyAt()).not.toBeNull()
  })

  it("writes an empty patch without disturbing anything", async () => {
    // Turning every detector off is a legitimate save, and it must still ask for a
    // re-look: that IS the correction in the case where redaction was too broad.
    await db
      .update(projects)
      .set({ knowledgeConfig: { kDistinctIssuers: 2 }, knowledgeDirtyAt: null })
      .where(eq(projects.id, projectId))

    await mergeKnowledgeConfig(projectId, {})

    expect((await config()).kDistinctIssuers).toBe(2)
    expect(await dirtyAt()).not.toBeNull()
  })
})
