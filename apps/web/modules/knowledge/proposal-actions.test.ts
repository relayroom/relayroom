/**
 * Proposer decisions from the dashboard (FEAT-0005 L4).
 *
 * decideProposal/rollbackPlaybook belong to @relayroom/db and are tested there;
 * these cover the web action contract - owner-only from the action (not the
 * button), and the one invariant this slice must never break: approving a
 * KNOWLEDGE proposal writes a candidate, never trusted. If a single owner click
 * could produce a trusted entry, the proposer queue would be a K=1 promotion
 * path around the whole attestation model.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "pr-owner"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return { ...actual, getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })) }
})

import { db } from "@/lib/db"
import { projects, projectAccess, knowledge, knowledgeProposals, playbookVersions } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { decideProposalAction, rollbackPlaybookAction } from "./proposal-actions"

const ORG = "org-pr"
const OWNER = "pr-owner"
const WRITER = "pr-writer"

let projectId: string

async function seedMember(id: string, role: string) {
  await db.insert(better_auth_user).values({ id, name: id, email: `${id}@t.local`, emailVerified: true }).onConflictDoNothing()
  await db.insert(better_auth_member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role, createdAt: new Date() }).onConflictDoNothing()
}

async function addProposal(target: "knowledge" | "playbook", change: Record<string, unknown>): Promise<string> {
  const [r] = await db
    .insert(knowledgeProposals)
    .values({ projectId, status: "pending", target, hypothesis: "h", change })
    .returning({ id: knowledgeProposals.id })
  return r!.id
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(playbookVersions)
  await db.delete(knowledgeProposals)
  await db.delete(knowledge)
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await seedMember(OWNER, "member")
  await seedMember(WRITER, "member")

  const [p] = await db.insert(projects).values({ organizationId: ORG, slug: "pr", name: "PR", connectCode: "pr-cc", createdByUserId: OWNER, relayroomMd: "ORIGINAL" }).returning({ id: projects.id })
  projectId = p!.id
  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("approving a knowledge proposal", () => {
  it("writes a CANDIDATE, never trusted - the load-bearing invariant", async () => {
    const id = await addProposal("knowledge", { title: "a fact", body: "the body", kind: "pitfall" })
    const res = await decideProposalAction(projectId, id, "approved")
    expect(res.result).toBe(true)

    const rows = await db.select({ state: knowledge.validationState, source: knowledge.sourceKind }).from(knowledge).where(eq(knowledge.projectId, projectId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe("candidate")   // NOT trusted
    expect(rows[0]!.source).toBe("proposer")

    const [prop] = await db.select({ s: knowledgeProposals.status }).from(knowledgeProposals).where(eq(knowledgeProposals.id, id))
    expect(prop!.s).toBe("approved")
  })

  it("is refused for a write grant, and writes no knowledge", async () => {
    const id = await addProposal("knowledge", { title: "x", body: "y", kind: "fact" })
    actingUserId = WRITER
    const res = await decideProposalAction(projectId, id, "approved")
    expect(res.result).toBe(false)
    expect(await db.select().from(knowledge).where(eq(knowledge.projectId, projectId))).toHaveLength(0)
    const [prop] = await db.select({ s: knowledgeProposals.status }).from(knowledgeProposals).where(eq(knowledgeProposals.id, id))
    expect(prop!.s).toBe("pending") // untouched
  })
})

describe("rejecting a proposal", () => {
  it("closes it without writing knowledge", async () => {
    const id = await addProposal("knowledge", { title: "x", body: "y", kind: "fact" })
    const res = await decideProposalAction(projectId, id, "rejected")
    expect(res.result).toBe(true)
    expect(await db.select().from(knowledge).where(eq(knowledge.projectId, projectId))).toHaveLength(0)
    const [prop] = await db.select({ s: knowledgeProposals.status }).from(knowledgeProposals).where(eq(knowledgeProposals.id, id))
    expect(prop!.s).toBe("rejected")
  })

  it("a second decision on an already-decided proposal is refused, nothing re-written", async () => {
    const id = await addProposal("knowledge", { title: "x", body: "y", kind: "fact" })
    expect((await decideProposalAction(projectId, id, "approved")).result).toBe(true)
    const before = await db.select().from(knowledge).where(eq(knowledge.projectId, projectId))
    // Re-decide: not_pending -> refused.
    expect((await decideProposalAction(projectId, id, "rejected")).result).toBe(false)
    expect(await db.select().from(knowledge).where(eq(knowledge.projectId, projectId))).toHaveLength(before.length)
  })
})

describe("approving a playbook proposal", () => {
  it("applies content, versions it, and is rollback-able", async () => {
    const id = await addProposal("playbook", { content: "NEW BODY" })
    const res = await decideProposalAction(projectId, id, "approved")
    expect(res.result).toBe(true)

    const [proj] = await db.select({ md: projects.relayroomMd }).from(projects).where(eq(projects.id, projectId))
    expect(proj!.md).toBe("NEW BODY")
    const versions = await db.select({ v: playbookVersions.version, c: playbookVersions.content }).from(playbookVersions).where(eq(playbookVersions.projectId, projectId))
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(versions.some((v) => v.c === "NEW BODY")).toBe(true)
  })
})

describe("rollbackPlaybookAction", () => {
  it("owner rolls back to a prior version by appending a new one", async () => {
    // Two playbook approvals -> versions 1 (V1) and 2 (V2), current = V2.
    await decideProposalAction(projectId, await addProposal("playbook", { content: "V1" }), "approved")
    await decideProposalAction(projectId, await addProposal("playbook", { content: "V2" }), "approved")

    const res = await rollbackPlaybookAction(projectId, 1)
    expect(res.result).toBe(true)

    const [proj] = await db.select({ md: projects.relayroomMd }).from(projects).where(eq(projects.id, projectId))
    expect(proj!.md).toBe("V1") // served content is now V1's

    // Append-only: a new highest version exists, and V2's row still there.
    const versions = await db.select({ v: playbookVersions.version, c: playbookVersions.content }).from(playbookVersions).where(eq(playbookVersions.projectId, projectId))
    expect(versions.some((r) => r.c === "V2")).toBe(true)      // history kept
    expect(Math.max(...versions.map((r) => r.v))).toBeGreaterThanOrEqual(3) // new version appended
  })

  it("is refused for a write grant", async () => {
    await decideProposalAction(projectId, await addProposal("playbook", { content: "V1" }), "approved")
    actingUserId = WRITER
    const res = await rollbackPlaybookAction(projectId, 1)
    expect(res.result).toBe(false)
  })

  it("refuses a version that does not exist", async () => {
    const res = await rollbackPlaybookAction(projectId, 99)
    expect(res.result).toBe(false)
  })
})
