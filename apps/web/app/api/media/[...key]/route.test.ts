/**
 * REL-4 regression: the media serve route must require a session and verify the
 * caller is authorized for the resolved-from-key project/org before returning
 * bytes, plus set the hardening response headers (nosniff, Content-Disposition,
 * private cache). getServerSession is mocked to act as different principals;
 * the route's membership check queries the real DB directly (not through
 * lib/auth-session's request-scoped helpers), so org membership seeded below is
 * genuinely exercised.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId: string | null = "media-actor"

vi.mock("@/lib/auth-session", () => ({
  getServerSession: vi.fn(async () =>
    actingUserId ? { user: { id: actingUserId } } : null,
  ),
}))

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => ({
    get: vi.fn(async (key: string) => {
      if (key.endsWith("missing/key.webp")) return null
      return { bytes: Buffer.from("fake-bytes"), contentType: "image/webp" }
    }),
  })),
}))

import { db } from "@/lib/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { GET } from "./route"

const ORG = "media-org"
const OTHER_ORG = "media-other-org"
const MEMBER = "media-actor" // member of ORG
const OUTSIDER = "media-outsider" // member of OTHER_ORG only

let projectId: string

async function seedUser(id: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedOrgMember(orgId: string, userId: string) {
  await db
    .insert(better_auth_member)
    .values({ id: `${orgId}-${userId}`, organizationId: orgId, userId, role: "member", createdAt: new Date() })
    .onConflictDoNothing()
}

function callGet(keySegments: string[]) {
  const req = new Request(`http://localhost/api/media/${keySegments.join("/")}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GET(req as any, { params: Promise.resolve({ key: keySegments }) })
}

beforeEach(async () => {
  actingUserId = MEMBER

  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, OTHER_ORG))

  for (const orgId of [ORG, OTHER_ORG]) {
    await db
      .insert(better_auth_organization)
      .values({ id: orgId, name: orgId, createdAt: new Date() })
      .onConflictDoNothing()
  }
  for (const u of [MEMBER, OUTSIDER]) await seedUser(u)
  await seedOrgMember(ORG, MEMBER)
  await seedOrgMember(OTHER_ORG, OUTSIDER)

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: `media-${Date.now()}`,
      name: "Media Project",
      connectCode: `media-cc-${Date.now()}`,
      createdByUserId: MEMBER,
    })
    .returning({ id: projects.id })
  projectId = p.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("GET /api/media/[...key] — REL-4 authorization", () => {
  it("returns 401 with no session", async () => {
    actingUserId = null
    const res = await callGet(["project", projectId, "thumbnail-abc.webp"])
    expect(res.status).toBe(401)
  })

  it("returns 403 for a user outside the project's org", async () => {
    actingUserId = OUTSIDER
    const res = await callGet(["project", projectId, "thumbnail-abc.webp"])
    expect(res.status).toBe(403)
  })

  it("returns 200 for a member of the project's org", async () => {
    actingUserId = MEMBER
    const res = await callGet(["project", projectId, "thumbnail-abc.webp"])
    expect(res.status).toBe(200)
  })

  it("returns 403 for a project id that does not exist", async () => {
    const res = await callGet(["project", "00000000-0000-0000-0000-000000000000", "x.webp"])
    expect(res.status).toBe(403)
  })

  it("allows the uploading user to read their own upload/<userId>/ staging key", async () => {
    actingUserId = MEMBER
    const res = await callGet(["upload", MEMBER, "thumbnail-abc.webp"])
    expect(res.status).toBe(200)
  })

  it("denies a different user reading someone else's upload/<userId>/ staging key", async () => {
    actingUserId = OUTSIDER
    const res = await callGet(["upload", MEMBER, "thumbnail-abc.webp"])
    expect(res.status).toBe(403)
  })

  it("denies an unrecognized key shape by default", async () => {
    const res = await callGet(["weird-prefix", "abc.webp"])
    expect(res.status).toBe(403)
  })

  it("returns 404 for an authorized-but-missing key", async () => {
    const res = await callGet(["project", projectId, "missing", "key.webp"])
    expect(res.status).toBe(404)
  })

  it("sets nosniff, Content-Disposition, and private Cache-Control on a successful response", async () => {
    const res = await callGet(["project", projectId, "thumbnail-abc.webp"])
    expect(res.status).toBe(200)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="thumbnail-abc\.webp"$/)
    expect(res.headers.get("cache-control")).toMatch(/^private/)
  })
})
