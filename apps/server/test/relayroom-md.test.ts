/**
 * Server tests for GET /:connectCode/relayroom-md.
 *
 * The served markdown appends a "## Current main agent" section reflecting the
 * project's main agent(s): "none set yet" when there is none, and one line per
 * (owner -> main part) otherwise. Soft-deleted mains are excluded.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { agents, knowledge, projects } from '@relayroom/db'
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

async function createProject(
  knowledgeConfig?: { dynamicFactsBlock?: boolean },
): Promise<{ id: string; connectCode: string }> {
  const connectCode = `md-cc-${randomBytes(6).toString('hex')}`
  const [project] = await db.insert(projects).values({
    organizationId: `md-org-${randomBytes(4).toString('hex')}`,
    slug: `md-proj-${randomBytes(4).toString('hex')}`,
    name: 'MD Test Project',
    connectCode,
    ...(knowledgeConfig ? { knowledgeConfig } : {}),
  }).returning({ id: projects.id })
  return { id: project!.id, connectCode }
}

/** Insert a knowledge row with an explicit state (defaults to trusted + promoted). */
async function addFact(
  projectId: string,
  f: { title: string; body: string; kind?: string; confidence?: number; state?: string; promotedAt?: Date },
): Promise<void> {
  const state = f.state ?? 'trusted'
  await db.insert(knowledge).values({
    projectId,
    kind: f.kind ?? 'fact',
    title: f.title,
    body: f.body,
    sourceKind: 'human',
    confidence: f.confidence ?? 0,
    validationState: state,
    promotedAt: state === 'trusted' ? (f.promotedAt ?? new Date()) : null,
  })
}

/** N trusted facts, cheap filler for threshold/cap tests. */
async function addTrustedFacts(projectId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await addFact(projectId, { title: `Fact ${i}`, body: `body ${i}`, confidence: i / 100 })
  }
}

async function fetchMd(connectCode: string): Promise<{ md: string; hash: string | null }> {
  const res = await app.request(`/mcp/${connectCode}/relayroom-md`)
  return { md: await res.text(), hash: res.headers.get('x-relayroom-playbook-hash') }
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

describe('GET /:connectCode/relayroom-md - trusted facts block (L5)', () => {
  it('auto: no block for a brand-new project (below the small threshold)', async () => {
    const { id, connectCode } = await createProject()
    await addTrustedFacts(id, 2) // below TRUSTED_FACTS_AUTO_THRESHOLD (3)
    const { md } = await fetchMd(connectCode)
    expect(md).not.toContain('## Trusted project facts')
  })

  it('auto: block appears once the project has enough trusted facts', async () => {
    const { id, connectCode } = await createProject()
    await addFact(id, { title: 'Deploy only on green CI', body: 'never deploy on a red pipeline', kind: 'convention' })
    await addFact(id, { title: 'DB is postgres 16', body: 'use jsonb containment', kind: 'fact' })
    await addFact(id, { title: 'No Friday deploys', body: 'freeze window', kind: 'decision' })
    const { md } = await fetchMd(connectCode)
    expect(md).toContain('## Trusted project facts (top 10)')
    // Delimited as generated, not authored.
    expect(md).toContain('Not part of the authored playbook')
    expect(md).toContain('Deploy only on green CI')
    expect(md).toContain('_(convention)_')
  })

  it('orders by confidence desc', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'LowConf', body: 'x', confidence: 0.1 })
    await addFact(id, { title: 'HighConf', body: 'y', confidence: 0.9 })
    const { md } = await fetchMd(connectCode)
    expect(md.indexOf('HighConf')).toBeLessThan(md.indexOf('LowConf'))
  })

  it('opt-in: block shows below the auto threshold when explicitly enabled', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'The one fact', body: 'lonely but trusted' })
    const { md } = await fetchMd(connectCode)
    expect(md).toContain('## Trusted project facts')
    expect(md).toContain('The one fact')
  })

  it('opt-out: explicit false suppresses the block even with many trusted facts', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: false })
    await addTrustedFacts(id, 6) // well above threshold
    const { md } = await fetchMd(connectCode)
    expect(md).not.toContain('## Trusted project facts')
  })

  it('only trusted facts appear - candidate/contradicted/retired are excluded', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'TrustedOne', body: 'shown' })
    await addFact(id, { title: 'CandidateOne', body: 'hidden', state: 'candidate' })
    await addFact(id, { title: 'ContradictedOne', body: 'hidden', state: 'contradicted' })
    await addFact(id, { title: 'RetiredOne', body: 'hidden', state: 'retired' })
    const { md } = await fetchMd(connectCode)
    expect(md).toContain('TrustedOne')
    expect(md).not.toContain('CandidateOne')
    expect(md).not.toContain('ContradictedOne')
    expect(md).not.toContain('RetiredOne')
  })

  it('caps the block at 10 facts', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addTrustedFacts(id, 15)
    const { md } = await fetchMd(connectCode)
    const block = md.slice(md.indexOf('## Trusted project facts'))
    const bullets = block.split('\n').filter(l => l.startsWith('- '))
    expect(bullets).toHaveLength(10)
  })
})

describe('GET /:connectCode/relayroom-md - playbook norms hash (L5)', () => {
  it('emits the norms hash header and a matching /hash endpoint', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'A', body: 'a' })
    const { hash } = await fetchMd(connectCode)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const res = await app.request(`/mcp/${connectCode}/relayroom-md/hash`)
    expect(res.status).toBe(200)
    const body = await res.json() as { hash: string }
    expect(body.hash).toBe(hash)
  })

  it('the hash changes when a trusted fact is added (block is in the norms)', async () => {
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'First', body: 'one' })
    const { hash: before } = await fetchMd(connectCode)
    await addFact(id, { title: 'Second', body: 'two' })
    const { hash: after } = await fetchMd(connectCode)
    expect(after).not.toBe(before)
  })

  it('the hash is STABLE across a main-agent change - current-main is operational, not a norm', async () => {
    const owner = `md-owner-hash-${randomBytes(4).toString('hex')}`
    await insertUser(owner, 'Faramir')
    const { id, connectCode } = await createProject({ dynamicFactsBlock: true })
    await addFact(id, { title: 'Norm', body: 'stable' })

    const { md: before, hash: hashBefore } = await fetchMd(connectCode)
    // A main handoff changes the SERVED bytes (current-main section) ...
    await db.insert(agents).values({ projectId: id, part: 'backend', role: 'main', ownerUserId: owner })
    const { md: after, hash: hashAfter } = await fetchMd(connectCode)

    expect(after).not.toBe(before) // served content did change
    expect(after).toContain('Faramir')
    expect(hashAfter).toBe(hashBefore) // ... but the norms hash did not
  })
})
