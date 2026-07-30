/**
 * The redaction denylist write.
 *
 * Two things are worth pinning here and nothing else is. First, the gate: the save
 * button only renders for owners, but the action is reachable without the button,
 * so ownership has to be decided here. Second, that a configuration the resolver
 * refuses is not stored - if it were, distillation would stop for the project and
 * the owner would have been told their save succeeded.
 *
 * What is deliberately NOT tested here is which rules are valid. That judgement
 * lives in `resolveRedactionRules` in `@relayroom/shared` and is tested there. A
 * copy of it in this file would be a second answer to the same question, free to
 * drift from the one the server actually enforces - which is the whole reason this
 * action calls the shared resolver instead of checking rules itself.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "rd-owner"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return { ...actual, getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })) }
})

import { db } from "@/lib/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { saveRedactionRules } from "./redaction-actions"

const ORG = "org-rd"
const OWNER = "rd-owner"
const WRITER = "rd-writer"

let projectId: string

async function seedMember(id: string) {
  await db.insert(better_auth_user).values({ id, name: id, email: `${id}@t.local`, emailVerified: true }).onConflictDoNothing()
  await db.insert(better_auth_member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role: "member", createdAt: new Date() }).onConflictDoNothing()
}

async function storedRules(): Promise<unknown> {
  const [p] = await db.select({ c: projects.knowledgeConfig }).from(projects).where(eq(projects.id, projectId))
  return (p?.c as { redactionRules?: unknown } | null)?.redactionRules
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await seedMember(OWNER)
  await seedMember(WRITER)

  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "rd", name: "RD", connectCode: "rd-cc", createdByUserId: OWNER })
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

describe("saveRedactionRules", () => {
  it("stores what an owner saves", async () => {
    const res = await saveRedactionRules(projectId, [{ kind: "literal", value: "acme-internal" }])

    expect(res.result).toBe(true)
    expect(await storedRules()).toEqual([{ kind: "literal", value: "acme-internal" }])
  })

  it("refuses a write member, who can reach the action without the button", async () => {
    actingUserId = WRITER

    const res = await saveRedactionRules(projectId, [{ kind: "literal", value: "acme-internal" }])

    expect(res.result).toBe(false)
    expect(await storedRules()).toBeUndefined()
  })

  it("stores nothing when the resolver refuses the configuration", async () => {
    // A rule the resolver cannot resolve makes every knowledge write fail closed.
    // Storing it and warning afterwards would stop the project's distillation while
    // the owner believed they had just configured protection - so the save has to
    // fail instead. Which rules are refused is the resolver's call, not this test's;
    // this one only needs an input it rejects.
    await saveRedactionRules(projectId, [{ kind: "literal", value: "acme-internal" }])

    const res = await saveRedactionRules(projectId, [{ kind: "not-a-rule" }])

    expect(res.result).toBe(false)
    // The previous configuration is still the one in force. A refused save must not
    // leave the project with neither the old rules nor the new ones.
    expect(await storedRules()).toEqual([{ kind: "literal", value: "acme-internal" }])
  })

  it("accepts an empty denylist, which is how redaction gets turned off", async () => {
    // Removing every rule is a legitimate save and the recovery path for an
    // over-broad rule, so it must not be mistaken for an empty/no-op submission.
    await saveRedactionRules(projectId, [{ kind: "literal", value: "acme-internal" }])

    const res = await saveRedactionRules(projectId, [])

    expect(res.result).toBe(true)
    expect(await storedRules()).toEqual([])
  })
})
