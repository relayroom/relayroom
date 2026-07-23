/**
 * listKnowledge / countKnowledgeByState against the real schema.
 *
 * The claim worth pinning is the supporting-issuer count. The list shows it so a
 * reader can see WHY something is or is not trusted, which only helps if it is
 * the same number the promotion transaction acts on. It is counted here the way
 * 02-data-model counts it - DISTINCT issuer_id, signal='support', counted=true,
 * issuer in (ci_attest, human) - and each of those filters is exercised below,
 * because a count that merely looks plausible would be worse than none.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { projects, knowledge, knowledgeValidations } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization } from "@relayroom/db/auth-schema"
import { listKnowledge, countKnowledgeByState } from "./queries"

const ORG = "org-knowledge-q"
const USER = "knowledge-q-user"

let projectId: string
let otherProjectId: string

async function addEntry(
  pid: string,
  fields: Partial<{ kind: string; title: string; body: string; state: string; sourceKind: string }> = {},
): Promise<string> {
  const [row] = await db
    .insert(knowledge)
    .values({
      projectId: pid,
      kind: fields.kind ?? "fact",
      title: fields.title ?? "a claim",
      body: fields.body ?? "the body",
      sourceKind: fields.sourceKind ?? "learn",
      validationState: fields.state ?? "candidate",
    })
    .returning({ id: knowledge.id })
  return row!.id
}

async function addSupport(
  knowledgeId: string,
  opts: { issuer: string; issuerId: string; counted?: boolean; signal?: string },
) {
  await db.insert(knowledgeValidations).values({
    knowledgeId,
    signal: opts.signal ?? "support",
    issuer: opts.issuer,
    issuerId: opts.issuerId,
    counted: opts.counted ?? true,
    sourceFingerprint: `${opts.issuer}:${opts.issuerId}:${opts.signal ?? "support"}:${Math.random()}`,
  })
}

beforeEach(async () => {
  await db.delete(knowledge)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Knowledge Q", createdAt: new Date() })
    .onConflictDoNothing()
  await db
    .insert(better_auth_user)
    .values({ id: USER, name: USER, email: `${USER}@test.local`, emailVerified: true })
    .onConflictDoNothing()

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "kq-project",
      name: "KQ",
      connectCode: "kq-cc",
      createdByUserId: USER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  const [other] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "kq-other",
      name: "KQ Other",
      connectCode: "kq-cc-other",
      createdByUserId: USER,
    })
    .returning({ id: projects.id })
  otherProjectId = other!.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("listKnowledge", () => {
  it("returns only the given project's entries", async () => {
    await addEntry(projectId, { title: "mine" })
    await addEntry(otherProjectId, { title: "theirs" })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) {
      expect(res.items.map((e) => e.title)).toEqual(["mine"])
      expect(res.totalCount).toBe(1)
    }
  })

  it("narrows to one state when asked, and counts that state only", async () => {
    await addEntry(projectId, { title: "c1", state: "candidate" })
    await addEntry(projectId, { title: "c2", state: "candidate" })
    await addEntry(projectId, { title: "t1", state: "trusted" })

    const res = await listKnowledge(projectId, { state: "trusted" })
    expect(res.result).toBe(true)
    if (res.result) {
      expect(res.items.map((e) => e.title)).toEqual(["t1"])
      expect(res.totalCount).toBe(1)
    }
  })

  it("paginates without losing the unfiltered total", async () => {
    for (let i = 0; i < 5; i++) await addEntry(projectId, { title: `e${i}` })

    const first = await listKnowledge(projectId, { page: 1, limit: 2 })
    const second = await listKnowledge(projectId, { page: 2, limit: 2 })
    expect(first.result && second.result).toBe(true)
    if (first.result && second.result) {
      expect(first.items).toHaveLength(2)
      expect(second.items).toHaveLength(2)
      expect(first.totalCount).toBe(5)
      // Pages must not overlap.
      const ids = new Set([...first.items, ...second.items].map((e) => e.id))
      expect(ids.size).toBe(4)
    }
  })
})

describe("supportingIssuers matches what the promotion transaction counts", () => {
  it("counts DISTINCT issuers, so one issuer signing twice is still one", async () => {
    const id = await addEntry(projectId)
    await addSupport(id, { issuer: "ci_attest", issuerId: "ci" })
    await addSupport(id, { issuer: "ci_attest", issuerId: "ci" })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items[0]!.supportingIssuers).toBe(1)
  })

  it("counts two different issuers as two", async () => {
    const id = await addEntry(projectId)
    await addSupport(id, { issuer: "ci_attest", issuerId: "ci" })
    await addSupport(id, { issuer: "human", issuerId: USER })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items[0]!.supportingIssuers).toBe(2)
  })

  it("excludes counted=false rows (an unmapped CI attestation)", async () => {
    const id = await addEntry(projectId)
    await addSupport(id, { issuer: "ci_attest", issuerId: "unmapped", counted: false })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items[0]!.supportingIssuers).toBe(0)
  })

  it("excludes error_event, which may never promote", async () => {
    const id = await addEntry(projectId)
    await addSupport(id, { issuer: "error_event", issuerId: "error" })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items[0]!.supportingIssuers).toBe(0)
  })

  it("excludes contradictions - they are not support", async () => {
    const id = await addEntry(projectId)
    await addSupport(id, { issuer: "human", issuerId: USER, signal: "contradict" })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) expect(res.items[0]!.supportingIssuers).toBe(0)
  })

  it("does not bleed another entry's validations into this one", async () => {
    const a = await addEntry(projectId, { title: "a" })
    const b = await addEntry(projectId, { title: "b" })
    await addSupport(a, { issuer: "human", issuerId: USER })

    const res = await listKnowledge(projectId)
    expect(res.result).toBe(true)
    if (res.result) {
      const byTitle = Object.fromEntries(res.items.map((e) => [e.title, e.supportingIssuers]))
      expect(byTitle).toEqual({ a: 1, b: 0 })
    }
  })
})

describe("countKnowledgeByState", () => {
  it("reports every state, including the empty ones", async () => {
    await addEntry(projectId, { state: "candidate" })
    await addEntry(projectId, { state: "candidate" })
    await addEntry(projectId, { state: "trusted" })
    await addEntry(otherProjectId, { state: "retired" })

    expect(await countKnowledgeByState(projectId)).toEqual({
      candidate: 2,
      trusted: 1,
      contradicted: 0,
      retired: 0,
    })
  })
})
