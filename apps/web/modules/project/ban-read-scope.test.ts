/**
 * Regression: a project-scope ban must cut READS, not only writes and the live
 * SSE stream.
 *
 * The ban gate existed on the thread Server Actions (see
 * modules/thread/ban-enforcement.test.ts) and on /api/realtime, while every
 * server-rendered read ignored it - so a banned member who simply reloaded kept
 * seeing the project in their list, its threads in the inbox, and the whole
 * project surface behind the tabs. These exercise the listing/enumeration half
 * of that fix against the real test DB; the per-project page gate lives in
 * app/(dashboard)/projects/[slug]/layout.tsx.
 *
 * Also covers the search-scope rule: search must agree with requireProjectAccess,
 * which counts an org owner/admin as a project owner even with no project_access
 * row. Scoping search on project_access rows alone hid such a project from the
 * very people who administer it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { projects, projectAccess, threads } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { listProjects } from "./queries"
import { getOpenThreadsForOrg, getOpenThreadCount } from "@/modules/notification/queries"
import { searchDashboard } from "@/modules/search/queries"

const ORG = "org-ban-read"
const BANNED = "ban-read-banned"
const MEMBER = "ban-read-member"
/** Org admin with NO project_access row - the L-4 case. */
const ORG_ADMIN = "ban-read-orgadmin"

const SUBJECT = "zzsearchable ban read subject"

let projectId: string

async function seedUser(id: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

beforeEach(async () => {
  await db.delete(projectAccess)
  await db.delete(threads)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))

  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Ban Read Org", createdAt: new Date() })
    .onConflictDoNothing()

  for (const [u, role] of [
    [BANNED, "member"],
    [MEMBER, "member"],
    [ORG_ADMIN, "admin"],
  ] as const) {
    await seedUser(u)
    await db
      .insert(better_auth_member)
      .values({ id: `m-${u}`, organizationId: ORG, userId: u, role, createdAt: new Date() })
      .onConflictDoNothing()
  }

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "ban-read-project",
      name: "Ban Read Project",
      connectCode: "ban-read-cc",
      createdByUserId: MEMBER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  // BANNED is banned; MEMBER holds a normal grant; ORG_ADMIN deliberately has NO row.
  await db.insert(projectAccess).values([
    {
      projectId,
      userId: BANNED,
      level: "readonly",
      bannedAt: new Date(),
      bannedByUserId: MEMBER,
      createdByUserId: MEMBER,
    },
    { projectId, userId: MEMBER, level: "write", createdByUserId: MEMBER },
  ])

  await db
    .insert(threads)
    .values({ projectId, subject: SUBJECT, status: "open", createdByUserId: MEMBER })
})

afterAll(async () => {
  await db.$client.end()
})

describe("listProjects ban scoping", () => {
  it("hides a project the viewer is banned from", async () => {
    const res = await listProjects(ORG, BANNED)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items).toHaveLength(0)
  })

  it("still shows the project to a non-banned member", async () => {
    const res = await listProjects(ORG, MEMBER)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items.map((p) => p.slug)).toEqual(["ban-read-project"])
  })

  it("does not filter when no viewer is supplied (documented opt-in)", async () => {
    const res = await listProjects(ORG)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items).toHaveLength(1)
  })
})

describe("inbox ban scoping", () => {
  it("hides a banned member's project threads from the inbox list", async () => {
    const res = await getOpenThreadsForOrg(ORG, BANNED)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items).toHaveLength(0)
  })

  it("still lists them for a non-banned member", async () => {
    const res = await getOpenThreadsForOrg(ORG, MEMBER)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items.map((t) => t.subject)).toContain(SUBJECT)
  })

  it("excludes banned projects from the sidebar open-thread count", async () => {
    expect(await getOpenThreadCount(ORG, BANNED)).toBe(0)
    expect(await getOpenThreadCount(ORG, MEMBER)).toBeGreaterThan(0)
  })
})

describe("searchDashboard scoping", () => {
  it("returns nothing from a project the caller is banned from", async () => {
    const res = await searchDashboard(BANNED, SUBJECT)
    expect(res.threads).toHaveLength(0)
  })

  it("finds threads in a project the caller holds project_access for", async () => {
    const res = await searchDashboard(MEMBER, SUBJECT)
    expect(res.threads.map((t) => t.subject)).toContain(SUBJECT)
  })

  it("finds threads for an org admin with no project_access row (matches requireProjectAccess)", async () => {
    const res = await searchDashboard(ORG_ADMIN, SUBJECT)
    expect(res.threads.map((t) => t.subject)).toContain(SUBJECT)
  })

  it("returns nothing for a user outside the org entirely", async () => {
    const res = await searchDashboard("ban-read-stranger", SUBJECT)
    expect(res.threads).toHaveLength(0)
  })
})
