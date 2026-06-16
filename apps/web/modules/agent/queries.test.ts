import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, agents } from "@relayroom/db/schema"
import { getAgent, listAgents } from "./queries"

const ORG = "test-agent-org"
let projectId: string
let otherProjectId: string
let otherAgentId: string

beforeAll(async () => {
  const [p1] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "aproj", name: "A", connectCode: "ac-1" })
    .returning({ id: projects.id })
  const [p2] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "aproj2", name: "A2", connectCode: "ac-2" })
    .returning({ id: projects.id })
  projectId = p1!.id
  otherProjectId = p2!.id

  await db.insert(agents).values([
    { projectId, part: "web" },
    { projectId, part: "worker" },
  ])
  const [other] = await db
    .insert(agents)
    .values({ projectId: otherProjectId, part: "solo" })
    .returning({ id: agents.id })
  otherAgentId = other!.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("listAgents", () => {
  it("returns only the given project's agents", async () => {
    const res = await listAgents(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(2)

    const other = await listAgents(otherProjectId)
    expect(other.result).toBe(true)
    if (other.result) expect(other.totalCount).toBe(1)
  })
})

describe("getAgent", () => {
  it("does not return an agent that belongs to a different project (isolation)", async () => {
    // otherAgentId lives in otherProjectId; requesting it under projectId must fail.
    const res = await getAgent(projectId, otherAgentId)
    expect(res.result).toBe(false)
  })
})
