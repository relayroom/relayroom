import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { governanceAlerts, projects, projectAccess } from "@relayroom/db/schema"
import {
  better_auth_member,
  better_auth_organization,
  better_auth_user,
} from "@relayroom/db/auth-schema"
import {
  getGovernanceAlertCount,
  getGovernanceAlertsForManager,
  getManagedProjectIds,
} from "./queries"

// Manager-only visibility of governance alerts (phase 08). Visibility is enforced
// server-side: org owners/admins and project owners see alerts; write/readonly
// members and members of other orgs see none.

const ORG = "gov-test-org"
const OTHER_ORG = "gov-test-other-org"

const ADMIN = "gov_admin"
const PROJ_OWNER = "gov_proj_owner"
const WRITER = "gov_writer"
const OUTSIDER = "gov_outsider" // member of OTHER_ORG only

let projectId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@gov.test`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedMember(org: string, userId: string, role: string): Promise<void> {
  await db
    .insert(better_auth_member)
    .values({ id: `${org}_${userId}`, organizationId: org, userId, role, createdAt: new Date() })
    .onConflictDoNothing()
}

beforeAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await db
      .insert(better_auth_organization)
      .values({ id: org, name: org, slug: org, createdAt: new Date() })
      .onConflictDoNothing()
  }
  for (const u of [ADMIN, PROJ_OWNER, WRITER, OUTSIDER]) await seedUser(u)

  await seedMember(ORG, ADMIN, "admin")
  await seedMember(ORG, PROJ_OWNER, "member")
  await seedMember(ORG, WRITER, "member")
  await seedMember(OTHER_ORG, OUTSIDER, "owner")

  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "gov-proj", name: "GovProj", connectCode: "gov-cc-1" })
    .returning({ id: projects.id })
  projectId = p!.id

  await db.insert(projectAccess).values([
    { projectId, userId: PROJ_OWNER, level: "owner" },
    { projectId, userId: WRITER, level: "write" },
  ])

  // One open + one resolved alert. Only the open one should count.
  await db.insert(governanceAlerts).values([
    { projectId, subjectUserId: WRITER, kind: "phantom_turns", detail: { count: 7, windowMin: 60 } },
    {
      projectId,
      subjectUserId: WRITER,
      kind: "loop_breaker",
      detail: { count: 3, windowMin: 60 },
      resolvedAt: new Date(),
    },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("getManagedProjectIds", () => {
  it("org admin manages every project in the org", async () => {
    const ids = await getManagedProjectIds(ORG, ADMIN)
    expect(ids).toContain(projectId)
  })

  it("project owner manages only their owned project", async () => {
    const ids = await getManagedProjectIds(ORG, PROJ_OWNER)
    expect(ids).toEqual([projectId])
  })

  it("a write member manages nothing", async () => {
    expect(await getManagedProjectIds(ORG, WRITER)).toEqual([])
  })

  it("an outsider (other org) manages nothing in this org", async () => {
    expect(await getManagedProjectIds(ORG, OUTSIDER)).toEqual([])
  })
})

describe("getGovernanceAlertCount", () => {
  it("counts only OPEN alerts for a manager", async () => {
    expect(await getGovernanceAlertCount(ORG, ADMIN)).toBe(1)
    expect(await getGovernanceAlertCount(ORG, PROJ_OWNER)).toBe(1)
  })

  it("returns 0 for a non-manager", async () => {
    expect(await getGovernanceAlertCount(ORG, WRITER)).toBe(0)
    expect(await getGovernanceAlertCount(ORG, OUTSIDER)).toBe(0)
  })
})

describe("getGovernanceAlertsForManager", () => {
  it("returns the open alert with project + subject joins for a manager", async () => {
    const res = await getGovernanceAlertsForManager(ORG, ADMIN)
    expect(res.result).toBe(true)
    if (res.result) {
      expect(res.items).toHaveLength(1)
      expect(res.items[0]!.kind).toBe("phantom_turns")
      expect(res.items[0]!.projectName).toBe("GovProj")
      expect(res.items[0]!.subjectUserId).toBe(WRITER)
    }
  })

  it("returns empty items for a non-manager", async () => {
    const writer = await getGovernanceAlertsForManager(ORG, WRITER)
    expect(writer.result).toBe(true)
    if (writer.result) expect(writer.items).toHaveLength(0)

    const outsider = await getGovernanceAlertsForManager(ORG, OUTSIDER)
    expect(outsider.result).toBe(true)
    if (outsider.result) expect(outsider.items).toHaveLength(0)
  })
})
