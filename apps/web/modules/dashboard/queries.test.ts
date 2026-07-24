/**
 * Dashboard summary.
 *
 * The case that matters here is TWO OR MORE projects in an org. The agent-status
 * lookup used to split on `projectIds.length === 1`, and only the single-project
 * side was ever exercised - the many-projects side built its own
 * `ANY(ARRAY[...]::text[])` against a uuid column, so Postgres rejected the query
 * ("operator does not exist: uuid = text"), the catch swallowed it, and the whole
 * dashboard reported a failure. An org with one project never saw it.
 *
 * So: every test here uses at least two projects unless it is specifically about
 * the boundary.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { projects, projectAccess, agents } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { getDashboardSummary } from "./queries"

const ORG = "org-dash"
const USER = "dash-user"

async function seedUser(id: string) {
  await db.insert(better_auth_user).values({ id, name: id, email: `${id}@t.local`, emailVerified: true }).onConflictDoNothing()
  await db.insert(better_auth_member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role: "member", createdAt: new Date() }).onConflictDoNothing()
}

async function addProject(slug: string): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug, name: slug, connectCode: `cc-${slug}`, createdByUserId: USER })
    .returning({ id: projects.id })
  await db.insert(projectAccess).values({ projectId: p!.id, userId: USER, level: "owner", createdByUserId: USER })
  return p!.id
}

async function addAgent(projectId: string, part: string, lastSeenAt: Date | null) {
  await db.insert(agents).values({ projectId, part, nickname: part, lastSeenAt })
}

beforeEach(async () => {
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await seedUser(USER)
})

afterAll(async () => {
  await db.$client.end()
})

describe("getDashboardSummary with more than one project", () => {
  it("succeeds and counts agents across all of them - the uuid = text regression", async () => {
    const a = await addProject("alpha")
    const b = await addProject("beta")
    await addAgent(a, "one", new Date())          // connected
    await addAgent(b, "two", new Date(Date.now() - 60 * 60 * 1000)) // offline

    const res = await getDashboardSummary(ORG, USER)

    // Before the fix this was `{ result: false }`: the query threw and the catch
    // turned the entire dashboard into a failure.
    expect(res.result).toBe(true)
    if (!res.result) return

    expect(res.item.projectCount).toBe(2)
    expect(res.item.agentSummary.total).toBe(2)     // agents from BOTH projects
    expect(res.item.agentSummary.connected).toBe(1)
    expect(res.item.agentSummary.offline).toBe(1)
  })

  it("still works at three, where the old array literal also failed", async () => {
    const ids = [await addProject("p1"), await addProject("p2"), await addProject("p3")]
    for (const [i, id] of ids.entries()) await addAgent(id, `a${i}`, new Date())

    const res = await getDashboardSummary(ORG, USER)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.projectCount).toBe(3)
    expect(res.item.agentSummary.total).toBe(3)
  })

  it("excludes the virtual human participant from the agent summary", async () => {
    const a = await addProject("alpha")
    await addProject("beta")
    await addAgent(a, "human", new Date())
    await addAgent(a, "real", new Date())

    const res = await getDashboardSummary(ORG, USER)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.agentSummary.total).toBe(1)
  })
})

describe("boundaries", () => {
  it("one project still works - the branch that used to be the only tested one", async () => {
    const a = await addProject("solo")
    await addAgent(a, "one", new Date())

    const res = await getDashboardSummary(ORG, USER)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.projectCount).toBe(1)
    expect(res.item.agentSummary.total).toBe(1)
  })

  it("no projects returns an empty summary rather than failing", async () => {
    const res = await getDashboardSummary(ORG, USER)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.projectCount).toBe(0)
    expect(res.item.agentSummary).toEqual({ total: 0, connected: 0, offline: 0 })
  })

  it("counts a project with no agents at all", async () => {
    await addProject("empty-one")
    await addProject("empty-two")

    const res = await getDashboardSummary(ORG, USER)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.projectCount).toBe(2)
    expect(res.item.agentSummary.total).toBe(0)
  })
})
