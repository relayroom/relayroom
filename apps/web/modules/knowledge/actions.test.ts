/**
 * Human promotion from the dashboard (FEAT-0001 L0).
 *
 * L0's entire safety argument is that a person is the only thing that can
 * promote: agents write candidates and cannot vouch for their own guesses. So
 * these test the gate from the ACTION side, not by observing which buttons get
 * drawn - a Server Action is a live endpoint that a caller reaches without ever
 * loading the page, and "the button is hidden" is not an authorization check.
 *
 * The invariant that matters most is the second promote. The audit table is
 * supposed to answer "when did this become trusted, and who decided"; if a
 * repeat click appends another row, the ledger starts reporting decisions that
 * never happened.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "kp-owner"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return {
    ...actual, // keep the REAL requireProjectAccess
    getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })),
  }
})

import { db } from "@/lib/db"
import {
  projects,
  projectAccess,
  knowledge,
  knowledgeValidations,
  knowledgeAudits,
} from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { promoteKnowledge } from "./actions"

const ORG = "org-kp"
const OWNER = "kp-owner"       // project_access owner
const WRITER = "kp-writer"     // project_access write
const ORG_ADMIN = "kp-orgadmin" // org admin, NO project_access row
const BANNED = "kp-banned"     // owner grant, but banned
const OUTSIDER = "kp-outsider" // member of another org

let projectId: string
let otherProjectId: string
let entryId: string

async function seedMember(org: string, id: string, role: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
  await db
    .insert(better_auth_member)
    .values({ id: `m-${org}-${id}`, organizationId: org, userId: id, role, createdAt: new Date() })
    .onConflictDoNothing()
}

async function addEntry(pid: string, state = "candidate"): Promise<string> {
  const [row] = await db
    .insert(knowledge)
    .values({
      projectId: pid,
      kind: "fact",
      title: "a claim",
      body: "the body",
      sourceKind: "learn",
      validationState: state,
    })
    .returning({ id: knowledge.id })
  return row!.id
}

async function stateOf(id: string) {
  const [row] = await db
    .select({ state: knowledge.validationState, promotedAt: knowledge.promotedAt })
    .from(knowledge)
    .where(eq(knowledge.id, id))
  return row
}

async function auditRows(id: string) {
  return db
    .select({ action: knowledgeAudits.action, from: knowledgeAudits.fromState, to: knowledgeAudits.toState, actor: knowledgeAudits.actorUserId, detail: knowledgeAudits.detail })
    .from(knowledgeAudits)
    .where(eq(knowledgeAudits.knowledgeId, id))
}

async function validationRows(id: string) {
  return db
    .select({ issuer: knowledgeValidations.issuer, issuerId: knowledgeValidations.issuerId, signal: knowledgeValidations.signal, counted: knowledgeValidations.counted })
    .from(knowledgeValidations)
    .where(eq(knowledgeValidations.knowledgeId, id))
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(knowledge)
  await db.delete(projectAccess)
  for (const org of [ORG, "org-kp-other"]) {
    await db.delete(projects).where(eq(projects.organizationId, org))
    await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, org))
    await db
      .insert(better_auth_organization)
      .values({ id: org, name: org, createdAt: new Date() })
      .onConflictDoNothing()
  }

  await seedMember(ORG, OWNER, "member")
  await seedMember(ORG, WRITER, "member")
  await seedMember(ORG, BANNED, "member")
  await seedMember(ORG, ORG_ADMIN, "admin")
  await seedMember("org-kp-other", OUTSIDER, "owner")

  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "kp", name: "KP", connectCode: "kp-cc", createdByUserId: OWNER })
    .returning({ id: projects.id })
  projectId = p!.id

  const [other] = await db
    .insert(projects)
    .values({ organizationId: "org-kp-other", slug: "kp-other", name: "KPO", connectCode: "kp-cc-o", createdByUserId: OUTSIDER })
    .returning({ id: projects.id })
  otherProjectId = other!.id

  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
    { projectId, userId: BANNED, level: "owner", bannedAt: new Date(), bannedByUserId: OWNER, createdByUserId: OWNER },
  ])

  entryId = await addEntry(projectId)
})

afterAll(async () => {
  await db.$client.end()
})

describe("an owner promoting", () => {
  it("writes validation, state, promotedAt and audit in one go", async () => {
    const res = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(res.result).toBe(true)

    const after = await stateOf(entryId)
    expect(after?.state).toBe("trusted")
    expect(after?.promotedAt).not.toBeNull()

    const validations = await validationRows(entryId)
    expect(validations).toHaveLength(1)
    expect(validations[0]).toMatchObject({
      issuer: "human",
      issuerId: OWNER,
      signal: "support",
      counted: true,
    })

    const audits = await auditRows(entryId)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: "promote",
      from: "candidate",
      to: "trusted",
      actor: OWNER,
    })
    // The override is what makes K=1 legible after the fact.
    expect(audits[0]!.detail).toMatchObject({ override: true })
  })

  it("is idempotent: promoting twice leaves ONE audit row", async () => {
    await promoteKnowledge({ projectId, knowledgeId: entryId })
    const first = await stateOf(entryId)

    const second = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(second.result).toBe(true) // already trusted is not an error

    expect(await auditRows(entryId)).toHaveLength(1)
    expect(await validationRows(entryId)).toHaveLength(1)
    // promotedAt must not move either - it records when it BECAME trusted.
    expect((await stateOf(entryId))?.promotedAt?.getTime()).toBe(first?.promotedAt?.getTime())
  })
})

describe("who may not promote", () => {
  it("refuses a write grant - owner is the bar", async () => {
    actingUserId = WRITER
    const res = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(res.result).toBe(false)

    expect((await stateOf(entryId))?.state).toBe("candidate")
    expect(await auditRows(entryId)).toHaveLength(0)
    expect(await validationRows(entryId)).toHaveLength(0)
  })

  it("refuses a banned member who still holds an owner grant", async () => {
    actingUserId = BANNED
    const res = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(res.result).toBe(false)
    expect((await stateOf(entryId))?.state).toBe("candidate")
  })

  it("refuses a member of another org", async () => {
    actingUserId = OUTSIDER
    const res = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(res.result).toBe(false)
    expect((await stateOf(entryId))?.state).toBe("candidate")
  })
})

describe("org owner/admin with no explicit grant", () => {
  it("may promote - the effective-owner rule reaches this path too", async () => {
    actingUserId = ORG_ADMIN
    const res = await promoteKnowledge({ projectId, knowledgeId: entryId })
    expect(res.result).toBe(true)
    expect((await stateOf(entryId))?.state).toBe("trusted")
    expect(await auditRows(entryId)).toHaveLength(1)
  })
})

describe("tenant boundary", () => {
  it("will not promote another project's entry, even for its own owner", async () => {
    const foreign = await addEntry(otherProjectId)
    actingUserId = OWNER

    // The caller's own project passes the access gate; the entry belongs elsewhere.
    const res = await promoteKnowledge({ projectId, knowledgeId: foreign })
    expect(res.result).toBe(false)

    expect((await stateOf(foreign))?.state).toBe("candidate")
    expect(await auditRows(foreign)).toHaveLength(0)
  })
})
