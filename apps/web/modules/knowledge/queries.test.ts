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
import { projects, knowledge, knowledgeValidations, threads } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization } from "@relayroom/db/auth-schema"
import { listKnowledge, countKnowledgeByState, getKnowledgeEntry, listSourceThreads } from "./queries"

const ORG = "org-knowledge-q"
const USER = "knowledge-q-user"

const THREAD_A = "00000000-0000-0000-0000-0000000000a1"
const THREAD_B = "00000000-0000-0000-0000-0000000000b1"
/** A well-formed uuid that names nothing, for the "it is gone" cases. */
const MISSING_UUID = "00000000-0000-0000-0000-0000000000ff"

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
  await db.delete(threads)
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

describe("getKnowledgeEntry", () => {
  it("returns the entry, with the same support count the list shows", async () => {
    // Same number, deliberately asserted in both suites. The detail view showing a
    // different count from the row it was opened from would read as a correction.
    const id = await addEntry(projectId, { title: "detail me" })
    await addSupport(id, { issuer: "human", issuerId: "h1" })
    await addSupport(id, { issuer: "ci_attest", issuerId: "c1" })

    const res = await getKnowledgeEntry(projectId, id)

    expect(res.result).toBe(true)
    if (res.result) {
      expect(res.item.title).toBe("detail me")
      expect(res.item.supportingIssuers).toBe(2)
    }
  })

  it("refuses an entry belonging to another project", async () => {
    // The id comes out of the URL. Querying by id alone would serve any project's
    // entry to anyone who could name one, and the project layout only proves
    // membership of the project in the path.
    const foreign = await addEntry(otherProjectId, { title: "not yours" })

    expect((await getKnowledgeEntry(projectId, foreign)).result).toBe(false)
  })

  it("reports a missing entry rather than throwing", async () => {
    expect((await getKnowledgeEntry(projectId, MISSING_UUID)).result).toBe(false)
  })
})

describe("listSourceThreads", () => {
  it("resolves every ref, in order, keeping duplicates", async () => {
    // Not sourceRefs[0]. The column has always been a list, and an entry drawn from
    // several threads is what it was made a list for - rendering only the first
    // would drop evidence silently on the day that starts happening.
    await db.insert(threads).values([
      { id: THREAD_A, projectId, subject: "first discussion" },
      { id: THREAD_B, projectId, subject: "second discussion" },
    ])

    const out = await listSourceThreads(projectId, [
      { threadId: THREAD_B },
      { threadId: THREAD_A },
      { threadId: THREAD_B },
    ])

    expect(out).toEqual([
      { threadId: THREAD_B, subject: "second discussion" },
      { threadId: THREAD_A, subject: "first discussion" },
      { threadId: THREAD_B, subject: "second discussion" },
    ])
  })

  it("reports a thread that is gone as unresolved rather than dropping it", async () => {
    // The ref has to survive to the screen. Dropping it would make an entry that
    // lost its evidence look identical to one that never recorded any, and those
    // two states tell the reader different things.
    const out = await listSourceThreads(projectId, [{ threadId: MISSING_UUID }])

    expect(out).toEqual([{ threadId: MISSING_UUID, subject: null }])
  })

  it("does not resolve a thread in another project", async () => {
    // source_refs is JSONB written by agents, so an id in it is a claim rather than
    // a checked reference. Without the project filter this claim would print another
    // project's thread subject on this page.
    await db.insert(threads).values({ id: THREAD_A, projectId: otherProjectId, subject: "other project" })

    expect(await listSourceThreads(projectId, [{ threadId: THREAD_A }])).toEqual([
      { threadId: THREAD_A, subject: null },
    ])
  })

  it("survives a ref that is not a uuid, without losing the others", async () => {
    // A non-uuid would make Postgres reject the whole statement, taking every other
    // source on the entry with it. Verified by mutation: dropping the shape filter
    // turns the good thread's subject to null here.
    await db.insert(threads).values({ id: THREAD_A, projectId, subject: "still readable" })

    const out = await listSourceThreads(projectId, [{ threadId: "not-a-uuid" }, { threadId: THREAD_A }])

    expect(out).toEqual([
      { threadId: "not-a-uuid", subject: null },
      { threadId: THREAD_A, subject: "still readable" },
    ])
  })

  it("returns nothing for refs that name no thread at all", async () => {
    // An event-only ref is not a missing thread; the screen says something different
    // for each, so an empty list here has to mean "no thread was recorded".
    expect(await listSourceThreads(projectId, [])).toEqual([])
    expect(await listSourceThreads(projectId, [{ eventId: "e1" } as { threadId?: string }])).toEqual([])
  })
})
