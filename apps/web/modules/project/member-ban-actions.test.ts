/**
 * Web Server Action tests for governance ban/unban (phase 09).
 *
 * Exercises authorization + guards (requireProjectManage, last-owner, self-ban)
 * and reversibility against the real test DB. The session/active-org lookups are
 * mocked so we can act as different principals.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq } from "drizzle-orm"

// ── Session mocks (control the acting principal per test) ─────────────────────
let actingUserId = "actor-owner"
let activeOrgId: string | null = "org-ban-web"

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
import { banProjectMember, unbanProjectMember } from "./member-actions"

const ORG = "org-ban-web"
const OWNER = "actor-owner" // project owner + org member (manager)
const TARGET = "target-member"
const TARGET2 = "target-member-2"
const READER = "reader-member" // non-manager (write) member

let projectId: string

async function seedUser(id: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedOrgMember(userId: string, role: string) {
  await db
    .insert(better_auth_member)
    .values({ id: `m-${userId}`, organizationId: ORG, userId, role, createdAt: new Date() })
    .onConflictDoNothing()
}

async function bannedAtOf(pid: string, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ bannedAt: projectAccess.bannedAt })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, pid), eq(projectAccess.userId, userId)))
  return row?.bannedAt ?? null
}

beforeEach(async () => {
  actingUserId = OWNER
  activeOrgId = ORG

  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))

  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Ban Web Org", createdAt: new Date() })
    .onConflictDoNothing()
  for (const u of [OWNER, TARGET, TARGET2, READER]) await seedUser(u)
  await seedOrgMember(OWNER, "member")
  await seedOrgMember(TARGET, "member")
  await seedOrgMember(TARGET2, "member")
  await seedOrgMember(READER, "member")

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: `ban-web-${Date.now()}`,
      name: "Ban Web Project",
      connectCode: `ban-web-cc-${Date.now()}`,
      createdByUserId: OWNER,
    })
    .returning({ id: projects.id })
  projectId = p.id

  // OWNER is project owner (manager); TARGET + READER are write members.
  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: TARGET, level: "write", createdByUserId: OWNER },
    { projectId, userId: READER, level: "write", createdByUserId: OWNER },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("banProjectMember", () => {
  it("project owner (manager) can ban a write member", async () => {
    const res = await banProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(res.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull()
  })

  it("org owner/admin can ban a project member", async () => {
    // Acting principal is only an org admin, not a project owner.
    actingUserId = "org-admin"
    await seedUser("org-admin")
    await seedOrgMember("org-admin", "admin")

    const res = await banProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(res.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull()
  })

  it("non-manager (write member) cannot ban", async () => {
    actingUserId = READER // write member, not owner/admin
    const res = await banProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(res.result).toBe(false)
    expect(await bannedAtOf(projectId, TARGET)).toBeNull()
  })

  it("last owner cannot be banned", async () => {
    // OWNER is the sole owner; an org admin tries to ban them.
    actingUserId = "org-admin"
    await seedUser("org-admin")
    await seedOrgMember("org-admin", "admin")

    const res = await banProjectMember({ projectId, userId: OWNER, scope: "project" })
    expect(res.result).toBe(false)
    expect(res.message).toMatch(/owner/)
    expect(await bannedAtOf(projectId, OWNER)).toBeNull()
  })

  it("a manager cannot ban themselves", async () => {
    // Add a second owner so the last-owner guard would otherwise pass.
    await db
      .update(projectAccess)
      .set({ level: "owner" })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, TARGET)))
    const res = await banProjectMember({ projectId, userId: OWNER, scope: "project" })
    expect(res.result).toBe(false)
    expect(await bannedAtOf(projectId, OWNER)).toBeNull()
  })

  it("is reversible: unban clears bannedAt, row preserved", async () => {
    await banProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull()

    const res = await unbanProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(res.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET)).toBeNull()

    // Row still exists (not hard-deleted).
    const [row] = await db
      .select({ userId: projectAccess.userId })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, TARGET)))
    expect(row).toBeTruthy()
  })

  it("org scope bans the member on every project in the org", async () => {
    const [p2] = await db
      .insert(projects)
      .values({
        organizationId: ORG,
        slug: `ban-web-2-${Date.now()}`,
        name: "Second",
        connectCode: `ban-web-cc2-${Date.now()}`,
        createdByUserId: OWNER,
      })
      .returning({ id: projects.id })
    await db.insert(projectAccess).values([
      { projectId: p2.id, userId: OWNER, level: "owner", createdByUserId: OWNER },
      { projectId: p2.id, userId: TARGET, level: "write", createdByUserId: OWNER },
    ])

    const res = await banProjectMember({ projectId, userId: TARGET, scope: "org" })
    expect(res.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull()
    expect(await bannedAtOf(p2.id, TARGET)).not.toBeNull()
  })

  it("org scope refuses if the target is a last owner on ANY project", async () => {
    // TARGET is the sole owner of a second project: org-scope ban must refuse.
    const [p2] = await db
      .insert(projects)
      .values({
        organizationId: ORG,
        slug: `ban-web-3-${Date.now()}`,
        name: "Third",
        connectCode: `ban-web-cc3-${Date.now()}`,
        createdByUserId: TARGET,
      })
      .returning({ id: projects.id })
    await db
      .insert(projectAccess)
      .values({ projectId: p2.id, userId: TARGET, level: "owner", createdByUserId: TARGET })

    const res = await banProjectMember({ projectId, userId: TARGET, scope: "org" })
    expect(res.result).toBe(false)
    // Nothing applied because the guard runs before applyBan.
    expect(await bannedAtOf(projectId, TARGET)).toBeNull()
    expect(await bannedAtOf(p2.id, TARGET)).toBeNull()
  })

  it("bans an org member who has NO project_access row (upsert, not a silent no-op)", async () => {
    // TARGET2 is an org member but was never granted project_access (no row). A bare
    // UPDATE would touch 0 rows and the ban would be silently ineffective on the bus;
    // applyBan upserts a banned row so resolveConnection's bannedAt gate fires.
    expect(await bannedAtOf(projectId, TARGET2)).toBeNull() // no row exists at all
    const res = await banProjectMember({ projectId, userId: TARGET2, scope: "project" })
    expect(res.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET2)).not.toBeNull()
  })
})

describe("banned owner cannot self-unban or retaliate (governance takeover guard)", () => {
  beforeEach(async () => {
    // Promote TARGET to a second owner so neither is the "last owner", then OWNER
    // bans co-owner TARGET. (Outer beforeEach already reset state + actingUserId=OWNER.)
    await db
      .update(projectAccess)
      .set({ level: "owner" })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, TARGET)))
    const banned = await banProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(banned.result).toBe(true)
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull()
  })

  it("a banned owner cannot unban themselves", async () => {
    actingUserId = TARGET // the banned co-owner acts
    const res = await unbanProjectMember({ projectId, userId: TARGET, scope: "project" })
    expect(res.result).toBe(false)
    expect(await bannedAtOf(projectId, TARGET)).not.toBeNull() // still banned
  })

  it("a banned owner cannot retaliate by banning the manager who banned them", async () => {
    actingUserId = TARGET // banned co-owner tries to ban OWNER
    const res = await banProjectMember({ projectId, userId: OWNER, scope: "project" })
    expect(res.result).toBe(false)
    expect(await bannedAtOf(projectId, OWNER)).toBeNull()
  })
})
