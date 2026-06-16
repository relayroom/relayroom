import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects } from "@relayroom/db/schema"
import { getProjectBySlug, listProjects } from "./queries"

// Two distinct tenants. They intentionally share a slug ("shared") to prove that
// slug lookups are scoped per-org and never leak across tenants (past IDOR area).
const ORG_A = "test-proj-org-a"
const ORG_B = "test-proj-org-b"

beforeAll(async () => {
  await db.insert(projects).values([
    { organizationId: ORG_A, slug: "shared", name: "Alpha", connectCode: "pa-a" },
    { organizationId: ORG_B, slug: "shared", name: "Beta", connectCode: "pa-b" },
    { organizationId: ORG_B, slug: "beta-only", name: "Beta Only", connectCode: "pa-bo" },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("getProjectBySlug", () => {
  it("resolves a slug within the caller's org", async () => {
    const a = await getProjectBySlug(ORG_A, "shared")
    expect(a.result).toBe(true)
    if (a.result) expect(a.item.name).toBe("Alpha")

    const b = await getProjectBySlug(ORG_B, "shared")
    expect(b.result).toBe(true)
    if (b.result) expect(b.item.name).toBe("Beta")
  })

  it("does not resolve a project that belongs to another org (tenant isolation)", async () => {
    // beta-only exists only in ORG_B; ORG_A must not be able to read it by slug.
    const res = await getProjectBySlug(ORG_A, "beta-only")
    expect(res.result).toBe(false)
  })
})

describe("listProjects", () => {
  it("returns only the caller org's projects", async () => {
    const a = await listProjects(ORG_A)
    expect(a.result).toBe(true)
    if (a.result) {
      expect(a.items).toHaveLength(1)
      expect(a.items[0]!.slug).toBe("shared")
      expect(a.items[0]!.name).toBe("Alpha")
    }

    const b = await listProjects(ORG_B)
    expect(b.result).toBe(true)
    if (b.result) {
      expect(b.items.map((p) => p.slug).sort()).toEqual(["beta-only", "shared"])
    }
  })
})
