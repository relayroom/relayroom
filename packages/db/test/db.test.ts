import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateAgent, getOrCreateProject } from '../src/bootstrap'
import { messages, threads } from '../src/schema'

const db = createDb('postgres://hub:hub@localhost:48802/hub_test')
afterAll(() => db.$client.end())

describe('bootstrap + round trip', () => {
  it('getOrCreateProject is idempotent', async () => {
    const a = await getOrCreateProject(db, 'test-idempotent')
    const b = await getOrCreateProject(db, 'test-idempotent')
    expect(a.id).toBe(b.id)
    expect(a.slug).toBe('test-idempotent')
  })

  it('creates thread and message with uuidv7 ids', async () => {
    const project = await getOrCreateProject(db, 'demo-project')
    const web = await getOrCreateAgent(db, project.id, 'web')
    const [thread] = await db.insert(threads)
      .values({ projectId: project.id, subject: 'test', createdByAgentId: web.id }).returning()
    const [message] = await db.insert(messages)
      .values({ threadId: thread.id, fromAgentId: web.id, body: 'hello' }).returning()
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/)
    const found = await db.select().from(messages).where(eq(messages.threadId, thread.id))
    expect(found).toHaveLength(1)
  })

  it('getOrCreateAgent dedupes by (project, part)', async () => {
    const project = await getOrCreateProject(db, 'demo-project')
    const a = await getOrCreateAgent(db, project.id, 'android')
    const b = await getOrCreateAgent(db, project.id, 'android')
    expect(a.id).toBe(b.id)
  })
})
