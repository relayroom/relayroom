import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, events } from "@relayroom/db/schema"
import { listEvents } from "./queries"

const ORG = "test-event-org"
let projectId: string
let otherProjectId: string

beforeAll(async () => {
  const [p1] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "eproj", name: "E", connectCode: "ec-1" })
    .returning({ id: projects.id })
  const [p2] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "eproj2", name: "E2", connectCode: "ec-2" })
    .returning({ id: projects.id })
  projectId = p1!.id
  otherProjectId = p2!.id

  await db.insert(events).values([
    { projectId, type: "complete" },
    { projectId, type: "error" },
    { projectId, type: "progress" },
    { projectId: otherProjectId, type: "complete" },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("listEvents", () => {
  it("returns only the given project's events", async () => {
    const res = await listEvents(projectId, { page: 1, limit: 50 })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(3)

    const other = await listEvents(otherProjectId, { page: 1, limit: 50 })
    expect(other.result).toBe(true)
    if (other.result) expect(other.totalCount).toBe(1)
  })

  it("filters by type search (case-insensitive)", async () => {
    const res = await listEvents(projectId, { q: "ERR" })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(1)
  })
})
