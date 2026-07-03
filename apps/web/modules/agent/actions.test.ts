/**
 * Web Server Action tests for the agent flows (connect / delete / setMain).
 *
 * Exercises authorization (requireOrgAccess / requireAgentInOrg IDOR), the
 * regression that issuing a token must NOT pre-create a connection, the agent
 * upsert + appearance persistence + soft-delete revive, the soft-delete +
 * revoke behaviour, and the one-main-per-(project, owner) swap + broadcast.
 *
 * Session/active-org lookups are mocked so we can act as different principals.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq, isNull } from "drizzle-orm"

// Session mocks - control the acting principal per test.
let actingUserId = "agent-owner"
let actingEmail: string | null = "agent-owner@test.local"
let activeOrgId: string | null = "org-agent-web"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return {
    ...actual, // keep the REAL requireProjectAccess/isBannedFromProject/isOrgMember (AC-2)
    getServerSession: vi.fn(async () =>
      actingUserId ? { user: { id: actingUserId, email: actingEmail } } : null,
    ),
  }
})
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrgId: vi.fn(async () => activeOrgId),
}))

import { db } from "@/lib/db"
import {
  projects,
  projectAccess,
  agents,
  agentConnections,
  events,
  threads,
  messages,
  messageRecipients,
} from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
  better_auth_oauth_access_token,
} from "@relayroom/db/auth-schema"
import { connectAgent, deleteAgent, setMainAgent, updateAgent, disconnectConnection } from "./actions"
import { listAgents, listMyAgents, getMyMainAgent } from "./queries"

const ORG = "org-agent-web"
const OTHER_ORG = "org-agent-web-other"
const OWNER = "agent-owner"
const OWNER2 = "agent-owner-2"
const OUTSIDER = "agent-outsider" // not a member of ORG

let projectId: string
let connectCode: string

async function seedUser(id: string, name = id): Promise<void> {
  await db
    .insert(better_auth_user)
    .values({ id, name, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedOrg(id: string): Promise<void> {
  await db
    .insert(better_auth_organization)
    .values({ id, name: `Org ${id}`, createdAt: new Date() })
    .onConflictDoNothing()
}

async function seedMember(orgId: string, userId: string, role = "member"): Promise<void> {
  await db
    .insert(better_auth_member)
    .values({ id: `m-${orgId}-${userId}`, organizationId: orgId, userId, role, createdAt: new Date() })
    .onConflictDoNothing()
}

// AC-2 gates connectAgent on project_access `write`+, so tests must seed the same
// grant createProject would give a real caller (owner row for the creator).
async function makeProject(orgId: string, cc: string, ownerUserId = OWNER): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({
      organizationId: orgId,
      slug: `agent-web-${cc}`,
      name: "Agent Web Project",
      connectCode: cc,
      createdByUserId: ownerUserId,
    })
    .returning({ id: projects.id })
  await db
    .insert(projectAccess)
    .values({ projectId: p!.id, userId: ownerUserId, level: "owner", createdByUserId: ownerUserId })
    .onConflictDoNothing()
  return p!.id
}

async function agentRow(id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
  return row
}

beforeEach(async () => {
  actingUserId = OWNER
  actingEmail = "agent-owner@test.local"
  activeOrgId = ORG

  // Clean dependent tables first (FK order), scoped to our orgs.
  const ourProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, ORG))
  const otherProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, OTHER_ORG))
  const pids = [...ourProjects, ...otherProjects].map((r) => r.id)
  for (const pid of pids) {
    const ags = await db.select({ id: agents.id }).from(agents).where(eq(agents.projectId, pid))
    for (const a of ags) {
      await db.delete(agentConnections).where(eq(agentConnections.agentId, a.id))
    }
    const ths = await db.select({ id: threads.id }).from(threads).where(eq(threads.projectId, pid))
    for (const th of ths) {
      const msgs = await db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, th.id))
      for (const m of msgs) await db.delete(messageRecipients).where(eq(messageRecipients.messageId, m.id))
      await db.delete(messages).where(eq(messages.threadId, th.id))
    }
    await db.delete(threads).where(eq(threads.projectId, pid))
    await db.delete(events).where(eq(events.projectId, pid))
    await db.delete(agents).where(eq(agents.projectId, pid))
  }
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(projects).where(eq(projects.organizationId, OTHER_ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, OTHER_ORG))
  // Clean the tokens this owner minted (unique scopes per project, but be safe).
  await db
    .delete(better_auth_oauth_access_token)
    .where(eq(better_auth_oauth_access_token.userId, OWNER))

  await seedOrg(ORG)
  await seedOrg(OTHER_ORG)
  for (const u of [OWNER, OWNER2, OUTSIDER]) await seedUser(u)
  await seedMember(ORG, OWNER)
  await seedMember(ORG, OWNER2)
  // OUTSIDER is intentionally NOT a member of ORG.
  await seedMember(OTHER_ORG, OUTSIDER)

  connectCode = `agent-cc-${Date.now()}`
  projectId = await makeProject(ORG, connectCode)
})

afterAll(async () => {
  await db.$client.end()
})

describe("connectAgent", () => {
  it("issues a token and does NOT pre-create a connection (regression)", async () => {
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.token).toMatch(/^[0-9a-f]{64}$/)

    // The agent row was upserted, owned by the caller.
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "backend")))
    expect(agent).toBeTruthy()
    expect(agent!.ownerUserId).toBe(OWNER)
    expect(agent!.role).toBe("default")

    // REGRESSION: no agent_connection should exist yet (a connection only appears
    // when the agent actually connects over MCP, via resolveConnection).
    const conns = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agent!.id))
    expect(conns).toHaveLength(0)

    // A token row was created for the caller, scoped to the project.
    const toks = await db
      .select()
      .from(better_auth_oauth_access_token)
      .where(eq(better_auth_oauth_access_token.accessToken, res.item.token))
    expect(toks).toHaveLength(1)
    expect(toks[0]!.userId).toBe(OWNER)
    expect(toks[0]!.scopes).toBe(`project:${projectId}`)
  })

  it("persists appearance fields (nickname/color/icon)", async () => {
    const res = await connectAgent({
      connectCode,
      part: "frontend",
      nickname: "Frodo",
      color: "violet",
      icon: "sparkles",
    })
    expect(res.result).toBe(true)

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "frontend")))
    expect(agent!.nickname).toBe("Frodo")
    expect(agent!.color).toBe("violet")
    expect(agent!.icon).toBe("sparkles")
  })

  it("reconnect with blank appearance does not wipe existing identity", async () => {
    await connectAgent({ connectCode, part: "frontend", nickname: "Frodo", color: "violet" })
    const res = await connectAgent({ connectCode, part: "frontend" })
    expect(res.result).toBe(true)
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "frontend")))
    expect(agent!.nickname).toBe("Frodo")
    expect(agent!.color).toBe("violet")
  })

  it("re-adding a soft-deleted part revives it (clears deleted_at)", async () => {
    await connectAgent({ connectCode, part: "backend" })
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "backend")))
    // Soft-delete it.
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent!.id))

    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(true)
    const revived = await agentRow(agent!.id)
    expect(revived!.deletedAt).toBeNull()
  })

  it("invalid connect code -> result:false", async () => {
    const res = await connectAgent({ connectCode: "no-such-code", part: "backend" })
    expect(res.result).toBe(false)
    if (res.result) return
    expect(res.message).toMatch(/connect code|code/i)
  })

  it("non-member of the org -> denied", async () => {
    actingUserId = OUTSIDER
    actingEmail = "agent-outsider@test.local"
    // OUTSIDER's active org is ORG (which they do not belong to).
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(false)
  })

  it("connect code belonging to another org is not visible -> denied", async () => {
    // A project in OTHER_ORG; OWNER (active org = ORG) tries to use its code.
    const otherCc = `agent-cc-other-${Date.now()}`
    await makeProject(OTHER_ORG, otherCc)
    const res = await connectAgent({ connectCode: otherCc, part: "backend" })
    expect(res.result).toBe(false)
  })

  it("ownership: a different org member cannot seize an existing part (no takeover)", async () => {
    // OWNER claims "backend".
    const first = await connectAgent({ connectCode, part: "backend" })
    expect(first.result).toBe(true)

    // OWNER2 is a trusted member of the same org but tries to grab OWNER's part
    // using the shared connect code. Must be rejected (ownership is not transferable
    // by merely connecting), and ownership must stay with OWNER.
    actingUserId = OWNER2
    actingEmail = "agent-owner-2@test.local"
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(false)

    const [row] = await db
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "backend")))
      .limit(1)
    expect(row?.ownerUserId).toBe(OWNER)
  })

  it("ownership: the same owner can reconnect their own part", async () => {
    const first = await connectAgent({ connectCode, part: "backend" })
    expect(first.result).toBe(true)
    const again = await connectAgent({ connectCode, part: "backend" })
    expect(again.result).toBe(true)
  })
})

describe("deleteAgent", () => {
  it("soft-deletes, revokes connections + tokens, hides from lists, keeps the row", async () => {
    // Issue a token + agent, then fabricate a connected connection bound to it.
    const conn = await connectAgent({ connectCode, part: "backend" })
    expect(conn.result).toBe(true)
    if (!conn.result) return
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, "backend")))
    const [tok] = await db
      .select({ id: better_auth_oauth_access_token.id })
      .from(better_auth_oauth_access_token)
      .where(eq(better_auth_oauth_access_token.accessToken, conn.item.token))
    await db.insert(agentConnections).values({
      agentId: agent!.id,
      accessTokenId: tok!.id,
      status: "connected",
    })

    const res = await deleteAgent(agent!.id)
    expect(res.result).toBe(true)

    // Row still exists (history) but soft-deleted.
    const row = await agentRow(agent!.id)
    expect(row).toBeTruthy()
    expect(row!.deletedAt).not.toBeNull()

    // Connections revoked, token deleted.
    const conns = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agent!.id))
    expect(conns.every((c) => c.status === "revoked")).toBe(true)
    const toks = await db
      .select()
      .from(better_auth_oauth_access_token)
      .where(eq(better_auth_oauth_access_token.id, tok!.id))
    expect(toks).toHaveLength(0)

    // Disappears from listAgents + listMyAgents.
    const la = await listAgents(projectId)
    expect(la.result).toBe(true)
    if (la.result) expect(la.items.some((a) => a.id === agent!.id)).toBe(false)
    const lma = await listMyAgents(OWNER)
    expect(lma.result).toBe(true)
    if (lma.result) expect(lma.items.some((a) => a.id === agent!.id)).toBe(false)
  })

  it("IDOR: cannot delete an agent in another org", async () => {
    // Create an agent in OTHER_ORG directly.
    const otherCc = `agent-cc-other2-${Date.now()}`
    const otherPid = await makeProject(OTHER_ORG, otherCc)
    const [otherAgent] = await db
      .insert(agents)
      .values({ projectId: otherPid, part: "backend", ownerUserId: OUTSIDER })
      .returning({ id: agents.id })

    // OWNER (active org = ORG) tries to delete it.
    const res = await deleteAgent(otherAgent!.id)
    expect(res.result).toBe(false)
    // The foreign agent is untouched.
    const row = await agentRow(otherAgent!.id)
    expect(row!.deletedAt).toBeNull()
  })
})

describe("setMainAgent", () => {
  it("promotes to main, demotes the owner's previous main, records event, broadcasts", async () => {
    // Two agents owned by OWNER, plus one owned by OWNER2, plus a soft-deleted one.
    const [a1] = await db
      .insert(agents)
      .values({ projectId, part: "backend", role: "main", ownerUserId: OWNER })
      .returning({ id: agents.id })
    const [a2] = await db
      .insert(agents)
      .values({ projectId, part: "frontend", role: "default", ownerUserId: OWNER })
      .returning({ id: agents.id })
    const [b1] = await db
      .insert(agents)
      .values({ projectId, part: "infra", role: "default", ownerUserId: OWNER2 })
      .returning({ id: agents.id })
    const [dead] = await db
      .insert(agents)
      .values({ projectId, part: "ghost", role: "default", ownerUserId: OWNER2, deletedAt: new Date() })
      .returning({ id: agents.id })

    const res = await setMainAgent(a2!.id)
    expect(res.result).toBe(true)

    // a2 is now main; a1 demoted to default (one main per project+owner).
    expect((await agentRow(a2!.id))!.role).toBe("main")
    expect((await agentRow(a1!.id))!.role).toBe("default")
    // OWNER2's agent is untouched.
    expect((await agentRow(b1!.id))!.role).toBe("default")

    // main_changed event recorded for the new main.
    const evs = await db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.type, "main_changed")))
    expect(evs.length).toBe(1)
    expect(evs[0]!.agentId).toBe(a2!.id)
    const detail = evs[0]!.detail as { fromPart: string | null; toPart: string; byUserId: string }
    expect(detail.toPart).toBe("frontend")
    expect(detail.fromPart).toBe("backend")
    expect(detail.byUserId).toBe(OWNER)

    // Broadcast: one thread + message + recipients for every non-deleted agent.
    const ths = await db.select().from(threads).where(eq(threads.projectId, projectId))
    expect(ths.length).toBe(1)
    const msgs = await db.select().from(messages).where(eq(messages.threadId, ths[0]!.id))
    expect(msgs.length).toBe(1)
    const liveAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), isNull(agents.deletedAt)))
    expect(msgs[0]!.recipientCount).toBe(liveAgents.length)
    const recips = await db
      .select()
      .from(messageRecipients)
      .where(eq(messageRecipients.messageId, msgs[0]!.id))
    const recipIds = new Set(recips.map((r) => r.agentId))
    expect(recipIds.size).toBe(liveAgents.length)
    // The soft-deleted agent is excluded from the broadcast.
    expect(recipIds.has(dead!.id)).toBe(false)
    // Every live agent (across owners) is a recipient.
    for (const a of liveAgents) expect(recipIds.has(a.id)).toBe(true)
  })

  it("getMyMainAgent returns the current main for the owner", async () => {
    const [a1] = await db
      .insert(agents)
      .values({ projectId, part: "backend", role: "default", ownerUserId: OWNER })
      .returning({ id: agents.id })
    expect(await getMyMainAgent(projectId, OWNER)).toBeNull()

    const res = await setMainAgent(a1!.id)
    expect(res.result).toBe(true)
    const main = await getMyMainAgent(projectId, OWNER)
    expect(main).toBeTruthy()
    expect(main!.id).toBe(a1!.id)
    expect(main!.part).toBe("backend")
  })

  it("each owner keeps an independent main (no cross-owner demotion)", async () => {
    const [a1] = await db
      .insert(agents)
      .values({ projectId, part: "backend", role: "main", ownerUserId: OWNER })
      .returning({ id: agents.id })
    const [b1] = await db
      .insert(agents)
      .values({ projectId, part: "infra", role: "main", ownerUserId: OWNER2 })
      .returning({ id: agents.id })
    const [a2] = await db
      .insert(agents)
      .values({ projectId, part: "frontend", role: "default", ownerUserId: OWNER })
      .returning({ id: agents.id })

    const res = await setMainAgent(a2!.id)
    expect(res.result).toBe(true)
    expect((await agentRow(a1!.id))!.role).toBe("default") // OWNER's old main demoted
    expect((await agentRow(a2!.id))!.role).toBe("main")
    expect((await agentRow(b1!.id))!.role).toBe("main") // OWNER2's main untouched
  })

  it("IDOR: cannot set main on an agent in another org", async () => {
    const otherCc = `agent-cc-other3-${Date.now()}`
    const otherPid = await makeProject(OTHER_ORG, otherCc)
    const [otherAgent] = await db
      .insert(agents)
      .values({ projectId: otherPid, part: "backend", role: "default", ownerUserId: OUTSIDER })
      .returning({ id: agents.id })

    const res = await setMainAgent(otherAgent!.id)
    expect(res.result).toBe(false)
    expect((await agentRow(otherAgent!.id))!.role).toBe("default")
  })

  it("malformed (non-UUID) agentId is rejected cleanly, not a DB error", async () => {
    // Would otherwise raise a Postgres 'invalid input syntax for type uuid'.
    const res = await setMainAgent("not-a-uuid")
    expect(res.result).toBe(false)
  })
})

// ── AC-2: connectAgent requires project_access write+, not just org membership ──

describe("connectAgent (AC-2: project write+ required)", () => {
  it("a readonly project member cannot connect an agent", async () => {
    await db
      .insert(projectAccess)
      .values({ projectId, userId: OWNER2, level: "readonly", createdByUserId: OWNER })
    actingUserId = OWNER2
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(false)
  })

  it("an org member with no project_access row at all cannot connect an agent", async () => {
    // OWNER2 is an org member of ORG but was never granted project_access here.
    actingUserId = OWNER2
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(false)
  })

  it("a write project member CAN connect an agent", async () => {
    await db
      .insert(projectAccess)
      .values({ projectId, userId: OWNER2, level: "write", createdByUserId: OWNER })
    actingUserId = OWNER2
    const res = await connectAgent({ connectCode, part: "backend" })
    expect(res.result).toBe(true)
  })
})

// ── AC-3: agent edit/main/disconnect/delete require agent owner OR project manager ──

describe("agent management gate (AC-3: agent owner or project owner/org manager)", () => {
  it("a write project member who is NOT the agent owner cannot update the agent", async () => {
    await db
      .insert(projectAccess)
      .values({ projectId, userId: OWNER2, level: "write", createdByUserId: OWNER })
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "backend", ownerUserId: OWNER })
      .returning({ id: agents.id })

    actingUserId = OWNER2
    const res = await updateAgent({ agentId: agent!.id, nickname: "Hijacked" })
    expect(res.result).toBe(false)
    expect((await agentRow(agent!.id))!.nickname).not.toBe("Hijacked")
  })

  it("the agent's own owner CAN update it, even with no project_access grant", async () => {
    // OWNER2 owns the agent part but has no project_access row on this project -
    // agent ownership alone is sufficient authority over the agent's own fields.
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "backend", ownerUserId: OWNER2 })
      .returning({ id: agents.id })

    actingUserId = OWNER2
    const res = await updateAgent({ agentId: agent!.id, nickname: "MyOwnPart" })
    expect(res.result).toBe(true)
    expect((await agentRow(agent!.id))!.nickname).toBe("MyOwnPart")
  })

  it("a project owner (manager) CAN update an agent they do not own", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "backend", ownerUserId: OWNER2 })
      .returning({ id: agents.id })

    actingUserId = OWNER // has project_access level=owner via makeProject
    const res = await updateAgent({ agentId: agent!.id, nickname: "ManagedByOwner" })
    expect(res.result).toBe(true)
  })

  it("an org admin (manager) CAN disconnect a connection they do not own", async () => {
    const conn = await connectAgent({ connectCode, part: "backend" })
    expect(conn.result).toBe(true)
    if (!conn.result) return
    const [dbConn] = await db
      .insert(agentConnections)
      .values({ agentId: conn.item.agentId, status: "connected" })
      .returning({ id: agentConnections.id })

    const ADMIN = "agent-org-admin"
    await seedUser(ADMIN)
    await seedMember(ORG, ADMIN, "admin")
    actingUserId = ADMIN
    const res = await disconnectConnection(dbConn!.id)
    expect(res.result).toBe(true)
  })

  it("a write project member who is NOT the agent owner cannot delete the agent", async () => {
    await db
      .insert(projectAccess)
      .values({ projectId, userId: OWNER2, level: "write", createdByUserId: OWNER })
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "backend", ownerUserId: OWNER })
      .returning({ id: agents.id })

    actingUserId = OWNER2
    const res = await deleteAgent(agent!.id)
    expect(res.result).toBe(false)
    expect((await agentRow(agent!.id))!.deletedAt).toBeNull()
  })

  it("a write project member who is NOT the agent owner cannot set it as main", async () => {
    await db
      .insert(projectAccess)
      .values({ projectId, userId: OWNER2, level: "write", createdByUserId: OWNER })
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "backend", role: "default", ownerUserId: OWNER })
      .returning({ id: agents.id })

    actingUserId = OWNER2
    const res = await setMainAgent(agent!.id)
    expect(res.result).toBe(false)
    expect((await agentRow(agent!.id))!.role).toBe("default")
  })
})
