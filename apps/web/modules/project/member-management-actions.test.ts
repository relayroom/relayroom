/**
 * Web Server Action tests for project membership management
 * (addProjectMember / updateProjectMemberLevel / removeProjectMember).
 *
 * Covers the permission guard (requireProjectManage: org owner/admin OR project
 * owner), org-member-only adds, last-owner protection on demote/remove, and the
 * IDOR guard (a project in another org is invisible). Ban/unban is covered
 * separately in member-ban-actions.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq } from "drizzle-orm"

let actingUserId = "mm-owner"
let activeOrgId: string | null = "org-mm"

vi.mock("@/lib/auth-session", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })),
}))
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrgId: vi.fn(async () => activeOrgId),
}))

import { db } from "@/lib/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import {
  addProjectMember,
  updateProjectMemberLevel,
  removeProjectMember,
} from "./member-actions"

const ORG = "org-mm"
const OTHER_ORG = "org-mm-other"
const OWNER = "mm-owner" // project owner (manager)
const WRITER = "mm-writer" // write member, not a manager
const CANDIDATE = "mm-candidate" // org member, not yet on project
const OUTSIDER = "mm-outsider" // not an org member

let projectId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedMember(orgId: string, userId: string, role = "member"): Promise<void> {
  await db
    .insert(better_auth_member)
    .values({ id: `m-${orgId}-${userId}`, organizationId: orgId, userId, role, createdAt: new Date() })
    .onConflictDoNothing()
}

async function levelOf(pid: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ level: projectAccess.level })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, pid), eq(projectAccess.userId, userId)))
  return row?.level ?? null
}

beforeEach(async () => {
  actingUserId = OWNER
  activeOrgId = ORG

  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(projects).where(eq(projects.organizationId, OTHER_ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, OTHER_ORG))

  for (const org of [ORG, OTHER_ORG]) {
    await db
      .insert(better_auth_organization)
      .values({ id: org, name: `Org ${org}`, createdAt: new Date() })
      .onConflictDoNothing()
  }
  for (const u of [OWNER, WRITER, CANDIDATE, OUTSIDER]) await seedUser(u)
  await seedMember(ORG, OWNER)
  await seedMember(ORG, WRITER)
  await seedMember(ORG, CANDIDATE)
  await seedMember(OTHER_ORG, OUTSIDER)

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: `mm-${Date.now()}`,
      name: "MM Project",
      connectCode: `mm-cc-${Date.now()}`,
      createdByUserId: OWNER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("addProjectMember", () => {
  it("project owner can add an org member", async () => {
    const res = await addProjectMember({ projectId, userId: CANDIDATE, level: "write" })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, CANDIDATE)).toBe("write")
  })

  it("org admin (not on project) can add a member", async () => {
    actingUserId = "mm-org-admin"
    await seedUser("mm-org-admin")
    await seedMember(ORG, "mm-org-admin", "admin")
    const res = await addProjectMember({ projectId, userId: CANDIDATE, level: "readonly" })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, CANDIDATE)).toBe("readonly")
  })

  it("write member (non-manager) cannot add - privilege escalation guard", async () => {
    actingUserId = WRITER
    const res = await addProjectMember({ projectId, userId: CANDIDATE, level: "write" })
    expect(res.result).toBe(false)
    expect(await levelOf(projectId, CANDIDATE)).toBeNull()
  })

  it("cannot add a non-org-member", async () => {
    const res = await addProjectMember({ projectId, userId: OUTSIDER, level: "write" })
    expect(res.result).toBe(false)
    expect(await levelOf(projectId, OUTSIDER)).toBeNull()
  })

  it("re-adding an existing member updates their level (upsert)", async () => {
    await addProjectMember({ projectId, userId: CANDIDATE, level: "readonly" })
    const res = await addProjectMember({ projectId, userId: CANDIDATE, level: "owner" })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, CANDIDATE)).toBe("owner")
  })
})

describe("updateProjectMemberLevel", () => {
  it("owner can change a member's level", async () => {
    const res = await updateProjectMemberLevel({ projectId, userId: WRITER, level: "readonly" })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, WRITER)).toBe("readonly")
  })

  it("non-manager cannot change levels", async () => {
    actingUserId = WRITER
    const res = await updateProjectMemberLevel({ projectId, userId: OWNER, level: "readonly" })
    expect(res.result).toBe(false)
    expect(await levelOf(projectId, OWNER)).toBe("owner")
  })

  it("cannot demote the last owner", async () => {
    const res = await updateProjectMemberLevel({ projectId, userId: OWNER, level: "write" })
    expect(res.result).toBe(false)
    expect(res.message).toMatch(/owner/i)
    expect(await levelOf(projectId, OWNER)).toBe("owner")
  })

  it("can demote an owner when another owner remains", async () => {
    await db
      .update(projectAccess)
      .set({ level: "owner" })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, WRITER)))
    const res = await updateProjectMemberLevel({ projectId, userId: OWNER, level: "write" })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, OWNER)).toBe("write")
  })
})

describe("removeProjectMember", () => {
  it("owner can remove a write member", async () => {
    const res = await removeProjectMember({ projectId, userId: WRITER })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, WRITER)).toBeNull()
  })

  it("non-manager cannot remove", async () => {
    actingUserId = WRITER
    const res = await removeProjectMember({ projectId, userId: OWNER })
    expect(res.result).toBe(false)
    expect(await levelOf(projectId, OWNER)).toBe("owner")
  })

  it("cannot remove the last owner", async () => {
    const res = await removeProjectMember({ projectId, userId: OWNER })
    expect(res.result).toBe(false)
    expect(res.message).toMatch(/owner/i)
    expect(await levelOf(projectId, OWNER)).toBe("owner")
  })

  it("can remove an owner when another owner remains", async () => {
    await db
      .update(projectAccess)
      .set({ level: "owner" })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, WRITER)))
    const res = await removeProjectMember({ projectId, userId: OWNER })
    expect(res.result).toBe(true)
    expect(await levelOf(projectId, OWNER)).toBeNull()
  })

  it("IDOR: a project in another org is invisible -> denied", async () => {
    const [otherProject] = await db
      .insert(projects)
      .values({
        organizationId: OTHER_ORG,
        slug: `mm-other-${Date.now()}`,
        name: "Other",
        connectCode: `mm-cc-other-${Date.now()}`,
        createdByUserId: OUTSIDER,
      })
      .returning({ id: projects.id })
    await db
      .insert(projectAccess)
      .values({ projectId: otherProject!.id, userId: OUTSIDER, level: "owner", createdByUserId: OUTSIDER })

    // OWNER (active org = ORG) targets a project in OTHER_ORG.
    const res = await removeProjectMember({ projectId: otherProject!.id, userId: OUTSIDER })
    expect(res.result).toBe(false)
    expect(await levelOf(otherProject!.id, OUTSIDER)).toBe("owner")
  })
})
