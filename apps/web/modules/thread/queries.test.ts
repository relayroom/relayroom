import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, threads, agents, messages, messageRecipients } from "@relayroom/db/schema"
import { listThreads, getThread } from "./queries"

const ORG = "test-thread-org"
let projectId: string
let otherProjectId: string

beforeAll(async () => {
  const [p1] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "tproj", name: "T", connectCode: "tc-1" })
    .returning({ id: projects.id })
  const [p2] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "tproj2", name: "T2", connectCode: "tc-2" })
    .returning({ id: projects.id })
  projectId = p1!.id
  otherProjectId = p2!.id

  await db.insert(threads).values([
    { projectId, subject: "deploy bug", status: "open" },
    { projectId, subject: "deploy plan", status: "open" },
    { projectId, subject: "random note", status: "closed" },
    { projectId: otherProjectId, subject: "other project thread", status: "open" },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("listThreads", () => {
  it("returns only the given project's threads", async () => {
    const res = await listThreads(projectId, { page: 1, limit: 30 })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(3)

    const other = await listThreads(otherProjectId, { page: 1, limit: 30 })
    expect(other.result).toBe(true)
    if (other.result) expect(other.totalCount).toBe(1)
  })

  it("filters by status", async () => {
    const res = await listThreads(projectId, { status: "open" })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(2)
  })

  it("filters by subject search (case-insensitive)", async () => {
    const res = await listThreads(projectId, { q: "DEPLOY" })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(2)
  })

  it("ignores an unknown status filter", async () => {
    const res = await listThreads(projectId, { status: "not-a-status" })
    expect(res.result).toBe(true)
    if (res.result) expect(res.totalCount).toBe(3)
  })
})

describe("getThread read receipts", () => {
  it("include readAt (the timestamp the thread-view timeline renders)", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ projectId, part: "reader-x" })
      .returning({ id: agents.id })
    const [thread] = await db
      .insert(threads)
      .values({ projectId, subject: "read-receipt test", status: "open" })
      .returning({ id: threads.id })
    const [msg] = await db
      .insert(messages)
      .values({ threadId: thread!.id, body: "hi" })
      .returning({ id: messages.id })
    await db
      .insert(messageRecipients)
      .values({ messageId: msg!.id, agentId: agent!.id, readAt: new Date() })

    const res = await getThread(projectId, thread!.id)
    expect(res.result).toBe(true)
    if (!res.result) return
    const m = res.item.messages.find((mm) => mm.id === msg!.id)
    expect(m).toBeTruthy()
    expect(m!.readReceipts.length).toBeGreaterThan(0)
    expect(m!.readReceipts[0]!.readAt).toBeInstanceOf(Date)
    expect(m!.readReceipts[0]!.agentPart).toBe("reader-x")
  })

  it("recipients carry live presence (online) from the pager heartbeat", async () => {
    const [onAgent] = await db
      .insert(agents)
      .values({ projectId, part: "online-x", pagerLastSeenAt: new Date() })
      .returning({ id: agents.id })
    const [thread] = await db
      .insert(threads)
      .values({ projectId, subject: "presence test", status: "open" })
      .returning({ id: threads.id })
    const [msg] = await db
      .insert(messages)
      .values({ threadId: thread!.id, body: "hi" })
      .returning({ id: messages.id })
    await db
      .insert(messageRecipients)
      .values({ messageId: msg!.id, agentId: onAgent!.id })

    const res = await getThread(projectId, thread!.id)
    expect(res.result).toBe(true)
    if (!res.result) return
    const m = res.item.messages.find((mm) => mm.id === msg!.id)
    const rcpt = m!.recipients.find((x) => x.agentId === onAgent!.id)
    expect(rcpt?.online).toBe(true)
  })
})
