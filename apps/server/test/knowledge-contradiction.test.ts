/**
 * Agent-driven demotion via `event type:error` + detail.contradicts (FEAT-0001 L1).
 *
 * The asymmetry that keeps a work agent from self-promoting: an agent MAY demote
 * (the safe direction - worst case a true fact drops to candidate and self-heals)
 * and may NEVER promote. This exercises the demote path and pins that it is exactly
 * that - a demotion, not a back door to trusted.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agents, knowledge, knowledgeValidations, projects } from '@relayroom/db'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const SFX = randomBytes(5).toString('hex')
const USER = `kc-user-${SFX}`
const ORG = `kc-org-${SFX}`
const CODE = `kc-cc-${SFX}`
const TOKEN = randomBytes(24).toString('hex')
let projectId: string

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('kc-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'U', ${USER + '@kc.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'KC Org', NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'kc-mem-' + SFX}, ${ORG}, ${USER}, 'member', NOW())`

  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `kc-${SFX}`, name: 'Contradiction', connectCode: CODE,
  }).returning({ id: projects.id })
  projectId = proj!.id
  await db.insert(agents).values({ projectId, part: 'worker', ownerUserId: USER })
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'kc-tok-' + SFX}, ${TOKEN}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${USER}, ${projectScope(projectId)}, NOW(), NOW())`
})

async function errorEvent(detail: Record<string, unknown>) {
  const res = await app.request(`/mcp/${CODE}?part=worker`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'event', arguments: { type: 'error', detail } },
    }),
  })
  const raw = await res.text()
  const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
  const parsed = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : raw)
  return JSON.parse(parsed.result.content[0].text) as {
    eventId: string
    contradiction?: { applied: boolean; reason?: string }
  }
}

async function entry(state: string): Promise<string> {
  const [k] = await db.insert(knowledge).values({
    projectId, kind: 'fact', title: `e-${randomBytes(3).toString('hex')}`, body: 'b',
    sourceKind: 'human', validationState: state, ...(state === 'trusted' ? { confidence: 0.9 } : {}),
  }).returning({ id: knowledge.id })
  return k!.id
}

async function stateOf(id: string): Promise<string> {
  const [row] = await db.select({ s: knowledge.validationState }).from(knowledge).where(eq(knowledge.id, id))
  return row!.s
}

describe('event error contradicts knowledge', () => {
  it('demotes a trusted entry to contradicted', async () => {
    const id = await entry('trusted')
    const r = await errorEvent({ contradicts: id, note: 'this fact is wrong' })
    expect(r.contradiction).toEqual({ applied: true })
    expect(await stateOf(id)).toBe('contradicted')

    // The demotion rides on the event row - provenance for why it dropped.
    const [v] = await db.select().from(knowledgeValidations).where(eq(knowledgeValidations.knowledgeId, id))
    expect(v!.signal).toBe('contradict')
    expect(v!.issuer).toBe('error_event')
    expect(v!.sourceRef).toMatchObject({ eventId: r.eventId })
  })

  it('demotes a candidate too', async () => {
    const id = await entry('candidate')
    await errorEvent({ contradicts: id })
    expect(await stateOf(id)).toBe('contradicted')
  })

  it('can NEVER promote - an error event is demote-only', async () => {
    // Whatever an agent puts in the detail, the signal is 'contradict'. There is no
    // argument that turns this into a support/promotion.
    const id = await entry('candidate')
    await errorEvent({ contradicts: id, signal: 'support', validationState: 'trusted', promote: true })
    expect(await stateOf(id)).not.toBe('trusted')
    expect(await stateOf(id)).toBe('contradicted')
  })

  it('reports when the target is not in this project instead of silently doing nothing', async () => {
    // recordKnowledgeSignal answers the same for "missing" and "another project's",
    // and the tool must surface that rather than swallow it.
    const r = await errorEvent({ contradicts: randomBytes(16).toString('hex') }) // not a uuid
    expect(r.contradiction?.applied).toBe(false)
    expect(r.contradiction?.reason).toMatch(/valid knowledge id/)

    const foreign = randomBytes(16).toString('hex')
    // A real UUID that does not exist here.
    const uuid = '00000000-0000-4000-8000-000000000000'
    const r2 = await errorEvent({ contradicts: uuid })
    expect(r2.contradiction?.applied).toBe(false)
    expect(r2.contradiction?.reason).toMatch(/no such knowledge/)
    void foreign
  })

  it('records the event even when the contradiction does not apply', async () => {
    // The telemetry is valid regardless; only the demotion signal is withheld.
    const r = await errorEvent({ contradicts: '00000000-0000-4000-8000-000000000000' })
    expect(r.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.contradiction?.applied).toBe(false)
  })

  it('leaves an ordinary error event (no contradicts) untouched', async () => {
    const r = await errorEvent({ note: 'just an error, contradicts nothing' })
    expect(r.contradiction).toBeUndefined()
    expect(r.eventId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is idempotent on the same entry - a second contradict does not re-demote', async () => {
    const id = await entry('trusted')
    const first = await errorEvent({ contradicts: id })
    expect(first.contradiction).toEqual({ applied: true })
    const second = await errorEvent({ contradicts: id })
    // Already contradicted: no state change, reported as not-applied with the reason.
    expect(second.contradiction?.applied).toBe(false)
    expect(second.contradiction?.reason).toMatch(/already contradicted/)
  })
})
