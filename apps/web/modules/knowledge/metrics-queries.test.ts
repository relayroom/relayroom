/**
 * getMetricWindow against the real rollup table.
 *
 * The pure gating/aggregation is covered in metrics.test.ts; this only checks the
 * read: the right project's rows, only the window, oldest-first, and that a date
 * column comes back as a string the aggregation can parse.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { projects, knowledgeMetricDaily } from "@relayroom/db/schema"
import { better_auth_organization } from "@relayroom/db/auth-schema"
import { getMetricWindow } from "./metrics-queries"
import { foldHeadline, HEADLINE_WINDOW_DAYS } from "./metrics"

const ORG = "org-metrics-q"
let projectId: string
let otherProjectId: string

function dayNAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

beforeEach(async () => {
  await db.delete(knowledgeMetricDaily)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()

  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "mq", name: "MQ", connectCode: "mq-cc" })
    .returning({ id: projects.id })
  projectId = p!.id
  const [o] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "mq-o", name: "MQO", connectCode: "mq-cc-o" })
    .returning({ id: projects.id })
  otherProjectId = o!.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("getMetricWindow", () => {
  it("returns only this project's rows, within the window, oldest first", async () => {
    await db.insert(knowledgeMetricDaily).values([
      { projectId, day: dayNAgo(1), recallHitNum: 5, recallHitDen: 10 },
      { projectId, day: dayNAgo(3), recallHitNum: 2, recallHitDen: 10 },
      // Outside the window - must not come back.
      { projectId, day: dayNAgo(HEADLINE_WINDOW_DAYS + 5), recallHitNum: 99, recallHitDen: 99 },
      // Another project - must not come back.
      { projectId: otherProjectId, day: dayNAgo(1), recallHitNum: 1, recallHitDen: 1 },
    ])

    const rows = await getMetricWindow(projectId)
    expect(rows.map((r) => r.day)).toEqual([dayNAgo(3), dayNAgo(1)]) // oldest first
    expect(rows.every((r) => typeof r.day === "string")).toBe(true)
  })

  it("hands rows the pure fold can consume", async () => {
    // 60 recalls over two days, 30 used -> 50% and above the 50-recall threshold.
    await db.insert(knowledgeMetricDaily).values([
      { projectId, day: dayNAgo(2), recallHitNum: 15, recallHitDen: 30, trustedCount: 25 },
      { projectId, day: dayNAgo(1), recallHitNum: 15, recallHitDen: 30, trustedCount: 25 },
    ])
    const rows = await getMetricWindow(projectId)
    const h = foldHeadline(rows, dayNAgo(0))
    expect(h.recallHit.enough).toBe(true)
    if (h.recallHit.enough) expect(h.recallHit.ratio).toBeCloseTo(0.5)
    expect(h.trustedCount).toBe(25) // snapshot from the latest row
  })

  it("is empty (not an error) when the project has no rollup rows", async () => {
    expect(await getMetricWindow(projectId)).toEqual([])
  })
})
