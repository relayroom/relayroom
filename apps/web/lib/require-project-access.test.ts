/**
 * Characterization tests for requireProjectAccess.
 *
 * Written BEFORE 0.5.0 L0 moves the rank check into a shared, server-usable
 * helper so the MCP tools can apply the same rule. The point of writing them
 * first is that they describe what the function does TODAY: after the rewiring
 * they must still pass untouched, which is what makes the refactor verifiably
 * behaviour-preserving rather than merely compiling.
 *
 * The rule most at risk in that move is org-owner/admin-as-effective-owner. It
 * has no stored project_access row behind it - it is inferred - so it is the
 * easiest thing to drop while porting, and dropping it locks org administrators
 * out of the projects they administer. Nothing covered it before this file.
 *
 * Ordering matters as much as the outcomes and is asserted too: membership,
 * then ban, then level. A banned org admin must be refused, i.e. the ban has to
 * be checked before the role is promoted to owner.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { requireProjectAccess } from "./auth-session"

const ORG = "org-rpa"
const OTHER_ORG = "org-rpa-other"

const ORG_OWNER = "rpa-org-owner"     // org role owner, no project_access row
const ORG_ADMIN = "rpa-org-admin"     // org role admin, no project_access row
const WRITER = "rpa-writer"           // plain member, write row
const READER = "rpa-reader"           // plain member, readonly row
const ROWLESS = "rpa-rowless"         // plain member, no row at all
const BANNED_OWNER = "rpa-banned-owner"   // owner row, but banned
const BANNED_ADMIN = "rpa-banned-admin"   // org admin, but banned
const OUTSIDER = "rpa-outsider"       // member of a different org

let projectId: string

async function seedUser(id: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedMember(org: string, id: string, role: string) {
  await seedUser(id)
  await db
    .insert(better_auth_member)
    .values({ id: `m-${org}-${id}`, organizationId: org, userId: id, role, createdAt: new Date() })
    .onConflictDoNothing()
}

beforeEach(async () => {
  await db.delete(projectAccess)
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(projects).where(eq(projects.organizationId, org))
    await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, org))
    await db
      .insert(better_auth_organization)
      .values({ id: org, name: org, createdAt: new Date() })
      .onConflictDoNothing()
  }

  await seedMember(ORG, ORG_OWNER, "owner")
  await seedMember(ORG, ORG_ADMIN, "admin")
  await seedMember(ORG, BANNED_ADMIN, "admin")
  for (const u of [WRITER, READER, ROWLESS, BANNED_OWNER]) await seedMember(ORG, u, "member")
  await seedMember(OTHER_ORG, OUTSIDER, "owner")

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "rpa-project",
      name: "RPA Project",
      connectCode: "rpa-cc",
      createdByUserId: ORG_OWNER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  await db.insert(projectAccess).values([
    { projectId, userId: WRITER, level: "write", createdByUserId: ORG_OWNER },
    { projectId, userId: READER, level: "readonly", createdByUserId: ORG_OWNER },
    {
      projectId,
      userId: BANNED_OWNER,
      level: "owner",
      bannedAt: new Date(),
      bannedByUserId: ORG_OWNER,
      createdByUserId: ORG_OWNER,
    },
    {
      projectId,
      userId: BANNED_ADMIN,
      level: "readonly",
      bannedAt: new Date(),
      bannedByUserId: ORG_OWNER,
      createdByUserId: ORG_OWNER,
    },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("org owner/admin is an effective project owner without a stored row", () => {
  it("lets an org owner through at every level", async () => {
    for (const level of ["readonly", "write", "owner"] as const) {
      const res = await requireProjectAccess(ORG_OWNER, projectId, level)
      expect(res.ok, `org owner should pass ${level}`).toBe(true)
      if (res.ok) expect(res.level).toBe("owner")
    }
  })

  it("lets an org admin through at every level", async () => {
    for (const level of ["readonly", "write", "owner"] as const) {
      const res = await requireProjectAccess(ORG_ADMIN, projectId, level)
      expect(res.ok, `org admin should pass ${level}`).toBe(true)
      if (res.ok) expect(res.level).toBe("owner")
    }
  })

  it("reports the project's own org, not the caller's active one", async () => {
    const res = await requireProjectAccess(ORG_ADMIN, projectId, "owner")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.orgId).toBe(ORG)
  })
})

describe("stored project_access levels rank readonly < write < owner", () => {
  it("admits a write grant to write but not to owner", async () => {
    expect((await requireProjectAccess(WRITER, projectId, "readonly")).ok).toBe(true)
    expect((await requireProjectAccess(WRITER, projectId, "write")).ok).toBe(true)
    expect((await requireProjectAccess(WRITER, projectId, "owner")).ok).toBe(false)
  })

  it("admits a readonly grant to readonly only", async () => {
    expect((await requireProjectAccess(READER, projectId, "readonly")).ok).toBe(true)
    expect((await requireProjectAccess(READER, projectId, "write")).ok).toBe(false)
    expect((await requireProjectAccess(READER, projectId, "owner")).ok).toBe(false)
  })

  it("refuses a plain org member with no grant at all", async () => {
    expect((await requireProjectAccess(ROWLESS, projectId, "readonly")).ok).toBe(false)
  })
})

describe("a project ban outranks everything", () => {
  it("refuses a banned owner-level grant", async () => {
    const res = await requireProjectAccess(BANNED_OWNER, projectId, "readonly")
    expect(res.ok).toBe(false)
  })

  it("refuses a banned ORG ADMIN - the ban is checked before the role becomes owner", async () => {
    // Ordering guard: promote-then-ban-check would let this through.
    const res = await requireProjectAccess(BANNED_ADMIN, projectId, "owner")
    expect(res.ok).toBe(false)
  })
})

describe("tenant boundary", () => {
  it("refuses a member of another org", async () => {
    expect((await requireProjectAccess(OUTSIDER, projectId, "readonly")).ok).toBe(false)
  })

  it("refuses a project that does not exist", async () => {
    const res = await requireProjectAccess(ORG_OWNER, "00000000-0000-0000-0000-000000000000", "readonly")
    expect(res.ok).toBe(false)
  })
})

describe("refusals are translated, never raw keys", () => {
  it("returns real copy for each distinct refusal", async () => {
    const refusals = await Promise.all([
      requireProjectAccess(OUTSIDER, projectId, "readonly"),
      requireProjectAccess(ROWLESS, projectId, "readonly"),
      requireProjectAccess(BANNED_OWNER, projectId, "readonly"),
      requireProjectAccess(ORG_OWNER, "00000000-0000-0000-0000-000000000000", "readonly"),
    ])
    for (const res of refusals) {
      expect(res.ok).toBe(false)
      if (!res.ok) {
        // next-intl echoes the key back when it cannot resolve one, so a message
        // that still looks like a key means the copy is missing.
        expect(res.message).not.toMatch(/^(auth|project|common)\.[a-zA-Z]+$/)
        expect(res.message.length).toBeGreaterThan(3)
      }
    }
  })
})
