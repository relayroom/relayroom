import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, events, threads } from "@relayroom/db/schema"
import { getUsageSeries, getUsageSeriesForProject } from "./queries"
import {
  getOpenThreadCount,
  getOpenThreadsForOrg,
} from "@/modules/notification/queries"

const ORG = "test-org-usage"
const OTHER_ORG = "test-org-empty"
let projectId: string

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "usage-test-proj",
      name: "Usage Test",
      connectCode: "usage-test-code",
    })
    .returning({ id: projects.id })
  projectId = project!.id

  const today = new Date()
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

  await db.insert(events).values([
    {
      projectId,
      type: "complete",
      usage: { input_tokens: 1000, output_tokens: 400, cost_usd: 0.012 },
      createdAt: today,
    },
    {
      projectId,
      type: "complete",
      usage: { input_tokens: 500, output_tokens: 200, cost_usd: 0.005 },
      createdAt: threeDaysAgo,
    },
    // An event without usage must be ignored by the aggregation.
    { projectId, type: "progress", createdAt: today },
  ])

  await db.insert(threads).values([
    { projectId, subject: "open question", status: "open" },
    { projectId, subject: "resolved", status: "closed" },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("getUsageSeries", () => {
  it("aggregates org token/cost usage over a zero-filled window", async () => {
    const res = await getUsageSeries(ORG, 14)
    expect(res.result).toBe(true)
    if (!res.result) return

    expect(res.item.days).toHaveLength(14)
    expect(res.item.totalInputTokens).toBe(1500)
    expect(res.item.totalOutputTokens).toBe(600)
    expect(res.item.totalTokens).toBe(2100)
    expect(res.item.totalCostUsd).toBeCloseTo(0.017, 6)

    // The most recent day must carry today's event (1000 in / 400 out).
    const last = res.item.days[res.item.days.length - 1]!
    expect(last.inputTokens).toBe(1000)
    expect(last.outputTokens).toBe(400)
  })

  it("returns an all-zero window for an org with no events", async () => {
    const res = await getUsageSeries(OTHER_ORG, 14)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.days).toHaveLength(14)
    expect(res.item.totalTokens).toBe(0)
    expect(res.item.totalCostUsd).toBe(0)
  })
})

describe("getUsageSeriesForProject", () => {
  it("scopes the aggregation to a single project", async () => {
    const res = await getUsageSeriesForProject(projectId, 14)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.totalTokens).toBe(2100)
    expect(res.item.totalCostUsd).toBeCloseTo(0.017, 6)
  })
})

describe("notification queries", () => {
  it("counts only open threads in the org", async () => {
    expect(await getOpenThreadCount(ORG)).toBe(1)
    expect(await getOpenThreadCount(OTHER_ORG)).toBe(0)
  })

  it("lists open threads with their project", async () => {
    const res = await getOpenThreadsForOrg(ORG)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.subject).toBe("open question")
    expect(res.items[0]!.projectSlug).toBe("usage-test-proj")
  })
})
