/**
 * Server tests for GET /:connectCode/relayroom-md.
 *
 * The served markdown appends a "## Current main agent" section reflecting the
 * project's main agent(s): "none set yet" when there is none, and one line per
 * (owner -> main part) otherwise. Soft-deleted mains are excluded.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { agents, projects } from '@relayroom/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

async function insertUser(id: string, name: string): Promise<void> {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${name}, ${id + '@md.test'}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
}

async function createProject(): Promise<{ id: string; connectCode: string }> {
  const connectCode = `md-cc-${randomBytes(6).toString('hex')}`
  const [project] = await db.insert(projects).values({
    organizationId: `md-org-${randomBytes(4).toString('hex')}`,
    slug: `md-proj-${randomBytes(4).toString('hex')}`,
    name: 'MD Test Project',
    connectCode,
  }).returning({ id: projects.id })
  return { id: project!.id, connectCode }
}

describe('GET /:connectCode/relayroom-md - current main section', () => {
  it('unknown connect code -> 404', async () => {
    const res = await app.request('/mcp/no-such-md-code/relayroom-md')
    expect(res.status).toBe(404)
  })

  it('shows "none set yet" when the project has no main agent', async () => {
    const { id: projectId, connectCode } = await createProject()
    // A non-main agent must not count as a main.
    await db.insert(agents).values({ projectId, part: 'backend', role: 'default' })

    const res = await app.request(`/mcp/${connectCode}/relayroom-md`)
    expect(res.status).toBe(200)
    const md = await res.text()
    expect(md).toContain('## Current main agent')
    expect(md).toContain('none set yet')
  })

  it('lists each owner -> main part when a main exists', async () => {
    const owner = `md-owner-${randomBytes(4).toString('hex')}`
    await insertUser(owner, 'Aragorn')
    const { id: projectId, connectCode } = await createProject()
    await db.insert(agents).values({ projectId, part: 'backend', role: 'main', ownerUserId: owner })
    await db.insert(agents).values({ projectId, part: 'frontend', role: 'default', ownerUserId: owner })

    const res = await app.request(`/mcp/${connectCode}/relayroom-md`)
    expect(res.status).toBe(200)
    const md = await res.text()
    expect(md).toContain('## Current main agent')
    expect(md).not.toContain('none set yet')
    // Owner display name (name) and the main part appear.
    expect(md).toContain('Aragorn')
    expect(md).toContain('main part backend')
    // The non-main part is not advertised as a main.
    expect(md).not.toContain('main part frontend')
  })

  it('excludes a soft-deleted main agent', async () => {
    const owner = `md-owner-del-${randomBytes(4).toString('hex')}`
    await insertUser(owner, 'Boromir')
    const { id: projectId, connectCode } = await createProject()
    await db
      .insert(agents)
      .values({ projectId, part: 'backend', role: 'main', ownerUserId: owner, deletedAt: new Date() })

    const res = await app.request(`/mcp/${connectCode}/relayroom-md`)
    const md = await res.text()
    // A soft-deleted main does not count -> "none set yet".
    expect(md).toContain('none set yet')
    expect(md).not.toContain('Boromir')
  })

  it('serves markdown content-type', async () => {
    const { connectCode } = await createProject()
    const res = await app.request(`/mcp/${connectCode}/relayroom-md`)
    expect(res.headers.get('content-type')).toContain('text/markdown')
  })
})
