/**
 * Web Server Action tests for project mutations (AC-1).
 *
 * requireProjectAccess (lib/auth-session.ts) gates updateProject/updateRelayroomMd
 * on `write`+ project_access and archiveProject/regenerateConnectCode on `owner`.
 * Previously these only checked org membership (requireOrgAccess), so ANY org
 * member - including a `readonly` grant, or a member with no project_access row
 * at all - could mutate or archive a project. requireProjectAccess itself is kept
 * REAL (spread of the actual auth-session module) so the level gate is genuinely
 * exercised; only getServerSession is mocked to act as different principals.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq } from "drizzle-orm"

let actingUserId = "proj-owner"
let activeOrgId: string | null = "org-proj-ac1"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return {
    ...actual, // keep the REAL requireProjectAccess/isBannedFromProject (AC-1)
    getServerSession: vi.fn(async () => (actingUserId ? { user: { id: actingUserId } } : null)),
  }
})
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrgId: vi.fn(async () => activeOrgId),
}))

import { db } from "@/lib/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { updateProject, updateRelayroomMd, archiveProject, regenerateConnectCode } from "./actions"

const ORG = "org-proj-ac1"
const OWNER = "proj-owner" // project_access level=owner
const WRITER = "proj-writer" // project_access level=write
const READER = "proj-reader" // project_access level=readonly
const NO_GRANT = "proj-no-grant" // org member, no project_access row at all
const ORG_ADMIN = "proj-org-admin" // org role=admin, no project_access row

let projectId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedMember(userId: string, role = "member"): Promise<void> {
  await db
    .insert(better_auth_member)
    .values({ id: `m-${userId}`, organizationId: ORG, userId, role, createdAt: new Date() })
    .onConflictDoNothing()
}

beforeEach(async () => {
  actingUserId = OWNER
  activeOrgId = ORG

  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))

  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "AC-1 Org", createdAt: new Date() })
    .onConflictDoNothing()
  for (const u of [OWNER, WRITER, READER, NO_GRANT, ORG_ADMIN]) await seedUser(u)
  await seedMember(OWNER)
  await seedMember(WRITER)
  await seedMember(READER)
  await seedMember(NO_GRANT)
  await seedMember(ORG_ADMIN, "admin")

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: `ac1-${Date.now()}`,
      name: "AC-1 Project",
      connectCode: `ac1-cc-${Date.now()}`,
      createdByUserId: OWNER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
    { projectId, userId: READER, level: "readonly", createdByUserId: OWNER },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("updateProject (AC-1: write+ required)", () => {
  it("a write member can update", async () => {
    actingUserId = WRITER
    const res = await updateProject({ projectId, name: "New Name" })
    expect(res.result).toBe(true)
  })

  it("an owner can update", async () => {
    actingUserId = OWNER
    const res = await updateProject({ projectId, name: "New Name 2" })
    expect(res.result).toBe(true)
  })

  it("a readonly member is denied", async () => {
    actingUserId = READER
    const res = await updateProject({ projectId, name: "Hijacked" })
    expect(res.result).toBe(false)
    const [row] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId))
    expect(row?.name).not.toBe("Hijacked")
  })

  it("an org member with NO project_access row is denied", async () => {
    actingUserId = NO_GRANT
    const res = await updateProject({ projectId, name: "Hijacked" })
    expect(res.result).toBe(false)
  })

  it("an org admin (no explicit project_access row) can update as an effective owner", async () => {
    actingUserId = ORG_ADMIN
    const res = await updateProject({ projectId, name: "Admin Edit" })
    expect(res.result).toBe(true)
  })

  it("a member banned from the project is denied even with an owner-level row", async () => {
    await db
      .update(projectAccess)
      .set({ bannedAt: new Date() })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, OWNER)))
    actingUserId = OWNER
    const res = await updateProject({ projectId, name: "Banned Edit" })
    expect(res.result).toBe(false)
  })
})

describe("updateRelayroomMd (AC-1: write+ required)", () => {
  it("a readonly member is denied", async () => {
    actingUserId = READER
    const res = await updateRelayroomMd({ projectId, content: "# hijacked" })
    expect(res.result).toBe(false)
  })

  it("a write member can update", async () => {
    actingUserId = WRITER
    const res = await updateRelayroomMd({ projectId, content: "# ok" })
    expect(res.result).toBe(true)
  })
})

describe("archiveProject (AC-1: owner required)", () => {
  it("a write member is denied (not owner)", async () => {
    actingUserId = WRITER
    const res = await archiveProject(projectId)
    expect(res.result).toBe(false)
    const [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId))
    expect(row?.archivedAt).toBeNull()
  })

  it("an owner can archive", async () => {
    actingUserId = OWNER
    const res = await archiveProject(projectId)
    expect(res.result).toBe(true)
    const [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId))
    expect(row?.archivedAt).not.toBeNull()
  })
})

describe("regenerateConnectCode (AC-1: owner required)", () => {
  it("a write member is denied (not owner)", async () => {
    actingUserId = WRITER
    const [before] = await db.select({ connectCode: projects.connectCode }).from(projects).where(eq(projects.id, projectId))
    const res = await regenerateConnectCode(projectId)
    expect(res.result).toBe(false)
    const [after] = await db.select({ connectCode: projects.connectCode }).from(projects).where(eq(projects.id, projectId))
    expect(after?.connectCode).toBe(before?.connectCode)
  })

  it("an owner can regenerate", async () => {
    actingUserId = OWNER
    const [before] = await db.select({ connectCode: projects.connectCode }).from(projects).where(eq(projects.id, projectId))
    const res = await regenerateConnectCode(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.item.connectCode).not.toBe(before?.connectCode)
  })
})
