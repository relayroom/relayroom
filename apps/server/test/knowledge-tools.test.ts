/**
 * `recall` / `learn` / `recall_used` (FEAT-0001 L0).
 *
 * The guard the whole feature rests on: `learn` always writes a CANDIDATE, and
 * `recall` returns ONLY `trusted`. Everything an agent writes is an unverified
 * claim until a human promotes it, and `recall` is what puts text into another
 * agent's context - so if a candidate could leak through it, an agent could
 * effectively author facts for every other agent. That path is tested from both
 * ends here, and the negative control confirms the tests would notice if it opened.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agents, knowledge, projectAccess, projects, recallLogs, threads } from '@relayroom/db'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'
import postgres from 'postgres'
import { resetLearnRateLimit } from '../src/routes/mcp'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const SFX = randomBytes(5).toString('hex')
const USER = `kt-user-${SFX}`
const READER = `kt-reader-${SFX}`
const ORG_OWNER = `kt-orgowner-${SFX}`
const ORG = `kt-org-${SFX}`
const CODE = `kt-cc-${SFX}`
const TOKEN = randomBytes(24).toString('hex')
const READER_TOKEN = randomBytes(24).toString('hex')
const ORG_OWNER_TOKEN = randomBytes(24).toString('hex')
let projectId: string

async function seedUser(id: string, orgRole = 'member') {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${id}, ${id + '@kt.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'kt-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${id}, ${orgRole}, NOW())`
}

async function mintToken(raw: string, userId: string) {
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'kt-tok-' + randomBytes(6).toString('hex')}, ${raw}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${userId}, ${projectScope(projectId)}, NOW(), NOW())`
}

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('kt-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Knowledge Org', NOW())`
  await seedUser(USER)
  await seedUser(READER)
  // An org owner with NO project_access row: the case the interim gate refused and
  // the shared helper allows, because an org manager administers every project in
  // the org without needing a grant in each one.
  await seedUser(ORG_OWNER, 'owner')

  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `kt-${SFX}`, name: 'Knowledge Project', connectCode: CODE,
  }).returning({ id: projects.id })
  projectId = proj!.id

  await db.insert(agents).values({ projectId, part: 'writer', ownerUserId: USER })
  await db.insert(agents).values({ projectId, part: 'reader', ownerUserId: READER })
  await db.insert(agents).values({ projectId, part: 'orgowner', ownerUserId: ORG_OWNER })
  // The writer has write access; the reader is a member with none granted.
  await db.insert(projectAccess).values({ projectId, userId: USER, level: 'write' })

  await mintToken(TOKEN, USER)
  await mintToken(READER_TOKEN, READER)
  await mintToken(ORG_OWNER_TOKEN, ORG_OWNER)
})

beforeEach(() => {
  resetLearnRateLimit()
})

interface ToolResult { isError: boolean; text: string }

async function callTool(
  part: string, token: string, name: string, args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await app.request(`/mcp/${CODE}?part=${part}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9),
      method: 'tools/call', params: { name, arguments: args },
    }),
  })
  const raw = await res.text()
  const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
  const parsed = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : raw)
  const result = parsed.result ?? {}
  return { isError: Boolean(result.isError), text: result.content?.[0]?.text ?? '' }
}

const learn = (args: Record<string, unknown>) => callTool('writer', TOKEN, 'learn', args)
const recall = (args: Record<string, unknown>, part = 'reader', token = READER_TOKEN) =>
  callTool(part, token, 'recall', args)

/** What a human owner's promotion does to the row. The ledgered transaction that
 *  performs it lives in packages/db and is exercised by its own tests; this is the
 *  state change recall reads. */
async function promote(id: string) {
  await db.update(knowledge)
    .set({ validationState: 'trusted', promotedAt: new Date(), confidence: 0.8 })
    .where(eq(knowledge.id, id))
}

describe('learn', () => {
  it('records a candidate and says so', async () => {
    const r = await learn({
      title: 'Postgres NOTIFY payloads cap at 8000 bytes',
      body: 'A longer payload throws; the bus falls back to local delivery.',
      kind: 'pitfall',
    })
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.text)).toMatchObject({ validationState: 'candidate' })

    const { id } = JSON.parse(r.text) as { id: string }
    const [row] = await db.select().from(knowledge).where(eq(knowledge.id, id))
    expect(row!.validationState).toBe('candidate')
    expect(row!.sourceKind).toBe('learn')
    expect(row!.promotedAt).toBeNull()
    expect(row!.confidence).toBe(0)
  })

  it('cannot write a trusted entry by any argument it accepts', async () => {
    // The tool takes no state argument, and there is no branch that sets one.
    // Asserted directly because "an agent cannot promote its own claim" is the
    // premise the rest of the design is built on.
    for (const kind of ['fact', 'convention', 'pitfall', 'decision'] as const) {
      const r = await learn({ title: `t-${kind}`, body: `b-${kind}`, kind })
      expect(JSON.parse(r.text).validationState).toBe('candidate')
    }
    const rows = await db.select({ state: knowledge.validationState })
      .from(knowledge)
      .where(and(eq(knowledge.projectId, projectId), eq(knowledge.sourceKind, 'learn')))
    expect(rows.every(r => r.state === 'candidate')).toBe(true)
  })

  it('accepts an org owner who has no project_access row', async () => {
    // The rule lives in decideProjectAccess, shared with the dashboard, so an org
    // manager is an owner everywhere in the org. This is the behaviour the interim
    // gate did not have, and the reason it was marked as replace-me rather than
    // extend-me.
    const r = await callTool('orgowner', ORG_OWNER_TOKEN, 'learn', {
      title: 'org owners can record lessons', body: 'without a per-project grant', kind: 'fact',
    })
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.text).validationState).toBe('candidate')
  })

  it('refuses a caller without write access', async () => {
    const r = await callTool('reader', READER_TOKEN, 'learn', {
      title: 'x', body: 'y', kind: 'fact',
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/write access/)
  })

  it('refuses a sourceThreadId from another project', async () => {
    const other = await db.insert(projects).values({
      organizationId: ORG, slug: `kt-other-${SFX}`, name: 'Other', connectCode: `kt-oc-${SFX}`,
    }).returning({ id: projects.id })
    const [t] = await db.insert(threads)
      .values({ projectId: other[0]!.id, subject: 'elsewhere' }).returning({ id: threads.id })

    const r = await learn({ title: 'x', body: 'y', kind: 'fact', sourceThreadId: t!.id })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not in your project/)
  })

  it('rejects loudly at the rate limit instead of dropping the entry', async () => {
    // An agent that believes it recorded something and did not is worse off than
    // one that was told. The error must say nothing was written.
    let refusal: ToolResult | null = null
    for (let i = 0; i < 25; i++) {
      const r = await learn({ title: `bulk ${i}`, body: `body ${i}`, kind: 'fact' })
      if (r.isError) { refusal = r; break }
    }
    expect(refusal).not.toBeNull()
    expect(refusal!.text).toMatch(/rate limit/)
    expect(refusal!.text).toMatch(/NOTHING was recorded/)
  })

  it('redacts a matched span from title and body before storing (learn path)', async () => {
    // The learn path is not exempt from the denylist - a human can paste a secret.
    // Set a project denylist, then confirm the stored candidate has the span dropped.
    await db.update(projects)
      .set({ knowledgeConfig: { redactionPatterns: ['sk-[a-z0-9]+'] } })
      .where(eq(projects.id, projectId))
    try {
      const r = await learn({
        title: 'rotate sk-deadbeef now', body: 'the key sk-deadbeef must be rotated', kind: 'pitfall',
      })
      expect(r.isError).toBe(false)
      const { id } = JSON.parse(r.text) as { id: string }
      const [row] = await db.select().from(knowledge).where(eq(knowledge.id, id))
      expect(row!.title).not.toContain('sk-deadbeef')
      expect(row!.body).not.toContain('sk-deadbeef')
      expect(row!.body).toContain('must be rotated')
    }
    finally {
      await db.update(projects).set({ knowledgeConfig: {} }).where(eq(projects.id, projectId))
    }
  })

  it('rejects a learn whose body redacts away to nothing', async () => {
    await db.update(projects)
      .set({ knowledgeConfig: { redactionPatterns: ['sk-\\w+'] } })
      .where(eq(projects.id, projectId))
    try {
      const r = await learn({ title: 't', body: 'sk-onlysecret', kind: 'fact' })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/empty after redaction/)
    }
    finally {
      await db.update(projects).set({ knowledgeConfig: {} }).where(eq(projects.id, projectId))
    }
  })
})

describe('recall', () => {
  it('does NOT return a candidate', async () => {
    const created = await learn({
      title: 'kryptonite handling procedure',
      body: 'kryptonite must be stored in a lead-lined container',
      kind: 'convention',
    })
    const { id } = JSON.parse(created.text) as { id: string }

    const r = await recall({ query: 'kryptonite handling' })
    expect(r.isError).toBe(false)
    const { entries } = JSON.parse(r.text) as { entries: { id: string }[] }
    expect(entries.map(e => e.id)).not.toContain(id)
  })

  it('returns it once a human promotes it - the whole loop', async () => {
    const created = await learn({
      title: 'deploy window is Tuesday morning',
      body: 'releases go out Tuesday before noon so someone is around if it breaks',
      kind: 'convention',
    })
    const { id } = JSON.parse(created.text) as { id: string }

    expect(JSON.parse((await recall({ query: 'deploy window' })).text).entries).toHaveLength(0)
    await promote(id)

    // A DIFFERENT agent recalls it: the point is that a lesson crosses agents.
    const r = await recall({ query: 'deploy window' })
    const { entries, queryId } = JSON.parse(r.text) as {
      entries: { id: string; kind: string; title: string; confidence: number; sourceRefs: unknown[] }[]
      queryId: string
    }
    expect(entries.map(e => e.id)).toContain(id)
    const hit = entries.find(e => e.id === id)!
    expect(hit.kind).toBe('convention')
    expect(hit.confidence).toBeCloseTo(0.8)
    expect(Array.isArray(hit.sourceRefs)).toBe(true)
    expect(queryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('filters by kind', async () => {
    const a = JSON.parse((await learn({
      title: 'zeppelin inflation checklist', body: 'check the seams first', kind: 'convention',
    })).text) as { id: string }
    const b = JSON.parse((await learn({
      title: 'zeppelin inflation incident', body: 'the seams failed in 1937', kind: 'pitfall',
    })).text) as { id: string }
    await promote(a.id); await promote(b.id)

    const r = await recall({ query: 'zeppelin inflation', kind: 'pitfall' })
    const ids = (JSON.parse(r.text) as { entries: { id: string }[] }).entries.map(e => e.id)
    expect(ids).toContain(b.id)
    expect(ids).not.toContain(a.id)
  })

  it('omits an expired entry', async () => {
    const created = JSON.parse((await learn({
      title: 'temporary embargo on widget shipments', body: 'do not ship widgets', kind: 'fact',
    })).text) as { id: string }
    await promote(created.id)
    await db.update(knowledge)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(knowledge.id, created.id))

    const r = await recall({ query: 'widget shipments embargo' })
    expect((JSON.parse(r.text) as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('does not reach another project\'s knowledge', async () => {
    const [other] = await db.insert(projects).values({
      organizationId: ORG, slug: `kt-x-${SFX}`, name: 'X', connectCode: `kt-xc-${SFX}`,
    }).returning({ id: projects.id })
    await db.insert(knowledge).values({
      projectId: other!.id, kind: 'fact', title: 'flux capacitor calibration',
      body: 'calibrate the flux capacitor quarterly', sourceKind: 'human',
      validationState: 'trusted', confidence: 1,
    })

    const r = await recall({ query: 'flux capacitor calibration' })
    expect((JSON.parse(r.text) as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('logs the query as a hash, never the text', async () => {
    const secret = 'incident with customer acme corp'
    const r = await recall({ query: secret })
    const { queryId } = JSON.parse(r.text) as { queryId: string }

    const [log] = await db.select().from(recallLogs).where(eq(recallLogs.id, queryId))
    expect(log!.projectId).toBe(projectId)
    expect(log!.queryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(log!.queryHash).not.toContain('acme')
    // Same query, same hash - that grouping is what a hit rate is computed over.
    const again = JSON.parse((await recall({ query: `  ${secret.toUpperCase()}  ` })).text) as { queryId: string }
    const [log2] = await db.select().from(recallLogs).where(eq(recallLogs.id, again.queryId))
    expect(log2!.queryHash).toBe(log!.queryHash)
  })

  it('is available to a member with no access level granted', async () => {
    // recall requires only a non-banned member; resolveConnection already proved
    // that, which is why the tool adds no check of its own.
    const created = JSON.parse((await learn({
      title: 'lighthouse keeper rotation', body: 'rotates every six weeks', kind: 'fact',
    })).text) as { id: string }
    await promote(created.id)

    const r = await recall({ query: 'lighthouse keeper' }, 'reader', READER_TOKEN)
    expect(r.isError).toBe(false)
    expect((JSON.parse(r.text) as { entries: { id: string }[] }).entries.map(e => e.id))
      .toContain(created.id)
  })
})

describe('recall_used', () => {
  it('records the entry that was acted on', async () => {
    const created = JSON.parse((await learn({
      title: 'barometer readings drift in humidity', body: 'recalibrate above 80% humidity', kind: 'pitfall',
    })).text) as { id: string }
    await promote(created.id)

    const { queryId } = JSON.parse((await recall({ query: 'barometer humidity' })).text) as { queryId: string }
    const r = await callTool('reader', READER_TOKEN, 'recall_used', { queryId, knowledgeId: created.id })
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.text)).toEqual({ ok: true })

    const [log] = await db.select().from(recallLogs).where(eq(recallLogs.id, queryId))
    expect(log!.usedKnowledgeId).toBe(created.id)
  })

  it('refuses an entry that query never returned', async () => {
    // Otherwise an agent could name any id and inflate the hit rate.
    const unrelated = JSON.parse((await learn({
      title: 'unrelated entry', body: 'not returned by the query below', kind: 'fact',
    })).text) as { id: string }
    const { queryId } = JSON.parse((await recall({ query: 'something else entirely' })).text) as { queryId: string }

    const r = await callTool('reader', READER_TOKEN, 'recall_used', {
      queryId, knowledgeId: unrelated.id,
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not among the results/)
  })

  it('refuses a queryId from another project', async () => {
    const [other] = await db.insert(projects).values({
      organizationId: ORG, slug: `kt-y-${SFX}`, name: 'Y', connectCode: `kt-yc-${SFX}`,
    }).returning({ id: projects.id })
    const [foreign] = await db.insert(recallLogs)
      .values({ projectId: other!.id, returnedKnowledgeIds: [] })
      .returning({ id: recallLogs.id })

    const r = await callTool('reader', READER_TOKEN, 'recall_used', {
      queryId: foreign!.id, knowledgeId: foreign!.id,
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/unknown queryId/)
  })
})
