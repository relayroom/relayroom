/**
 * POST /api/knowledge/attest (FEAT-0001 L1).
 *
 * The security-critical properties, each with the failure it defends and a
 * negative control that a mutation of the endpoint would trip:
 *
 *  - a forged or agent-originated request cannot promote (no valid secret to sign
 *    with, and this channel is not reachable by a connect code at all);
 *  - a replay of a valid request is refused;
 *  - an attestation for a check nobody mapped to the claim is recorded but does not
 *    count toward promotion;
 *  - and the load-bearing invariant: TWO CI attestations alone (one issuer) do NOT
 *    reach K=2, while one CI attestation plus one human (two issuers) does. This is
 *    the whole of the self-promotion defense - you cannot manufacture independent
 *    supports from a single secret.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  knowledge, knowledgeCheckMap, knowledgeNonces, knowledgeValidations, projects, recordKnowledgeSignal,
} from '@relayroom/db'
import postgres from 'postgres'
import { type AttestClaim, signAttest } from '../src/knowledge/attest-canonical'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const SFX = randomBytes(5).toString('hex')
const ORG = `ae-org-${SFX}`
const SECRET = 'attest-secret-current'
const KEY_ID = 'key-current'
const HUMAN = `ae-human-${SFX}`

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${HUMAN}, 'Human', ${HUMAN + '@ae.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Attest Org', NOW())`
})

interface Scene {
  projectId: string
  knowledgeId: string
  checkName: string
}

/** A project with attestation enabled and one candidate entry, optionally mapped. */
async function scene(opts: { mapped?: boolean; checkName?: string } = {}): Promise<Scene> {
  const sfx = randomBytes(6).toString('hex')
  const checkName = opts.checkName ?? `check-${sfx}`
  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `ae-${sfx}`, name: 'Attest Project', connectCode: `ae-cc-${sfx}`,
    attestSecret: SECRET, attestKeyId: KEY_ID,
  }).returning({ id: projects.id })

  const [k] = await db.insert(knowledge).values({
    projectId: proj!.id, kind: 'fact', title: `claim ${sfx}`, body: 'a claim to be attested',
    sourceKind: 'learn', validationState: 'candidate',
  }).returning({ id: knowledge.id })

  if (opts.mapped) {
    await db.insert(knowledgeCheckMap).values({
      projectId: proj!.id, checkName, knowledgeId: k!.id, createdByUserId: HUMAN,
    })
  }
  return { projectId: proj!.id, knowledgeId: k!.id, checkName }
}

function claimFor(s: Scene, over: Partial<AttestClaim> = {}): AttestClaim {
  return {
    projectId: s.projectId,
    knowledgeId: s.knowledgeId,
    runId: `run-${randomBytes(4).toString('hex')}`,
    checkName: s.checkName,
    assertion: 'check_passed',
    keyId: KEY_ID,
    issuedAt: new Date().toISOString(),
    nonce: `nonce-${randomBytes(6).toString('hex')}`,
    ...over,
  }
}

async function post(claim: AttestClaim, opts: { secret?: string; signature?: string } = {}) {
  const signature = opts.signature ?? signAttest(claim, opts.secret ?? SECRET)
  const res = await app.request('/api/knowledge/attest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-RR-Attest-Signature': signature },
    body: JSON.stringify(claim),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json: json as Record<string, unknown> }
}

async function stateOf(id: string): Promise<string> {
  const [row] = await db.select({ s: knowledge.validationState }).from(knowledge).where(eq(knowledge.id, id))
  return row!.s
}

describe('attest: authentication', () => {
  it('accepts a correctly signed, mapped attestation', async () => {
    const s = await scene({ mapped: true })
    const r = await post(claimFor(s))
    expect(r.status).toBe(200)
    expect(r.json.counted).toBe(true)
    expect(r.json.validationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a forged signature (wrong secret) with 401', async () => {
    const s = await scene({ mapped: true })
    const r = await post(claimFor(s), { secret: 'not-the-secret' })
    expect(r.status).toBe(401)
    // Nothing was recorded.
    expect(await stateOf(s.knowledgeId)).toBe('candidate')
  })

  it('rejects a request with no signature', async () => {
    const s = await scene({ mapped: true })
    const res = await app.request('/api/knowledge/attest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(claimFor(s)),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a project with attestation disabled the same as a bad key (401, not 404)', async () => {
    // A disabled project must be indistinguishable from a wrong key: whether a
    // project has attestation on is not probeable.
    const sfx = randomBytes(6).toString('hex')
    const [proj] = await db.insert(projects).values({
      organizationId: ORG, slug: `ae-off-${sfx}`, name: 'Off', connectCode: `ae-off-cc-${sfx}`,
      // no attestSecret
    }).returning({ id: projects.id })
    const [k] = await db.insert(knowledge).values({
      projectId: proj!.id, kind: 'fact', title: 't', body: 'b', sourceKind: 'learn', validationState: 'candidate',
    }).returning({ id: knowledge.id })

    const r = await post(claimFor({ projectId: proj!.id, knowledgeId: k!.id, checkName: 'c' }))
    expect(r.status).toBe(401)
  })

  it('honors the previous key only during its grace window', async () => {
    const sfx = randomBytes(6).toString('hex')
    const [proj] = await db.insert(projects).values({
      organizationId: ORG, slug: `ae-rot-${sfx}`, name: 'Rot', connectCode: `ae-rot-cc-${sfx}`,
      attestSecret: 'new-secret', attestKeyId: 'key-new',
      attestSecretPrev: 'old-secret', attestKeyIdPrev: 'key-old',
      attestSecretPrevExpiresAt: new Date(Date.now() + 60_000),
    }).returning({ id: projects.id })
    const [k] = await db.insert(knowledge).values({
      projectId: proj!.id, kind: 'fact', title: 't', body: 'b', sourceKind: 'learn', validationState: 'candidate',
    }).returning({ id: knowledge.id })
    const base: Scene = { projectId: proj!.id, knowledgeId: k!.id, checkName: 'c' }

    // Old key, signed with old secret, inside grace: accepted.
    const inGrace = await post(claimFor(base, { keyId: 'key-old' }), { secret: 'old-secret' })
    expect(inGrace.status).toBe(200)

    // Expire the grace; the same old key is now dead even though the column is set.
    await db.update(projects).set({ attestSecretPrevExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(projects.id, proj!.id))
    const expired = await post(claimFor(base, { keyId: 'key-old' }), { secret: 'old-secret' })
    expect(expired.status).toBe(401)
  })
})

describe('attest: format and skew', () => {
  it('rejects an unknown assertion with 400', async () => {
    const s = await scene({ mapped: true })
    const r = await post(claimFor(s, { assertion: 'check_failed' }))
    expect(r.status).toBe(400)
  })

  it('rejects a stale issuedAt with 400', async () => {
    const s = await scene({ mapped: true })
    const r = await post(claimFor(s, { issuedAt: new Date(Date.now() - 3600_000).toISOString() }))
    expect(r.status).toBe(400)
  })
})

describe('attest: replay', () => {
  it('refuses a byte-identical replay (same nonce) with 409', async () => {
    const s = await scene({ mapped: true })
    const claim = claimFor(s)
    expect((await post(claim)).status).toBe(200)
    expect((await post(claim)).status).toBe(409)
  })

  it('a re-run of the same check (new nonce) returns the ORIGINAL validation id', async () => {
    // Same runId + checkName is one source (dedup fingerprint), so a second post
    // with a fresh nonce is idempotent: it must answer with the first validation's
    // id and its stored counted flag, not a new row and not null.
    const s = await scene({ mapped: true })
    const first = await post(claimFor(s, { runId: 'run-same' }))
    const second = await post(claimFor(s, { runId: 'run-same' }))
    expect(second.status).toBe(200)
    expect(second.json.validationId).toBe(first.json.validationId)
    expect(second.json.counted).toBe(true)
  })

  it('a replay reports the STORED counted, not the resent body\'s', async () => {
    // First attest is mapped -> counted=true. If the mapping is later removed and
    // the same source re-posts, dedup returns the original row, whose counted stays
    // true - the truth on record, not a recomputation from the new request.
    const s = await scene({ mapped: true })
    const first = await post(claimFor(s, { runId: 'run-stored' }))
    expect(first.json.counted).toBe(true)
    await db.delete(knowledgeCheckMap).where(eq(knowledgeCheckMap.projectId, s.projectId))
    const second = await post(claimFor(s, { runId: 'run-stored' }))
    expect(second.json.counted).toBe(true)
  })

  it('does not burn a nonce on a forged request', async () => {
    // A 401 must not consume the nonce, or an attacker could grief a CI run by
    // pre-spending its nonces with forged requests.
    const s = await scene({ mapped: true })
    const claim = claimFor(s)
    expect((await post(claim, { secret: 'wrong' })).status).toBe(401)
    const [seen] = await db.select().from(knowledgeNonces)
      .where(and(eq(knowledgeNonces.projectId, s.projectId), eq(knowledgeNonces.nonce, claim.nonce)))
    expect(seen).toBeUndefined()
    // And the genuine request still goes through.
    expect((await post(claim)).status).toBe(200)
  })
})

describe('attest: tenant boundary', () => {
  it('rejects a claim from another project with 404', async () => {
    const a = await scene({ mapped: true })
    const b = await scene({ mapped: true })
    // Sign for project A's secret but point at project B's knowledge.
    const claim = claimFor(a, { knowledgeId: b.knowledgeId })
    const r = await post(claim)
    expect(r.status).toBe(404)
    expect(await stateOf(b.knowledgeId)).toBe('candidate')
  })
})

describe('attest: counting and the promotion invariant', () => {
  it('records an unmapped attestation as counted=false and does not promote', async () => {
    const s = await scene({ mapped: false })
    const r = await post(claimFor(s))
    expect(r.status).toBe(200)
    expect(r.json.counted).toBe(false)
    expect(await stateOf(s.knowledgeId)).toBe('candidate')

    // It IS recorded - the audit trail wants it - just with counted=false.
    const [v] = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, s.knowledgeId))
    expect(v).toBeDefined()
    expect(v!.counted).toBe(false)
  })

  it('TWO CI attestations alone do NOT reach K=2 (one issuer)', async () => {
    // The whole point: a single secret cannot manufacture two independent supports.
    const s = await scene({ mapped: true })
    expect((await post(claimFor(s))).status).toBe(200)
    expect((await post(claimFor(s))).status).toBe(200)
    // Two distinct runs, both counted, but the CI issuer identity is one.
    expect(await stateOf(s.knowledgeId)).toBe('candidate')
  })

  it('ONE CI attestation plus ONE human (two issuers) reaches trusted', async () => {
    const s = await scene({ mapped: true })
    expect((await post(claimFor(s))).status).toBe(200)
    expect(await stateOf(s.knowledgeId)).toBe('candidate')

    // The human confirm is the second, distinct promoting issuer. The dashboard
    // performs this via the same core function; here we call it directly.
    const r = await recordKnowledgeSignal(db, {
      projectId: s.projectId,
      knowledgeId: s.knowledgeId,
      signal: 'support',
      issuer: 'human',
      issuerId: HUMAN,
      sourceFingerprint: `human:${HUMAN}`,
      sourceRef: { userId: HUMAN },
      counted: true,
      actorKind: 'human',
      actorUserId: HUMAN,
    })
    expect(r.state).toBe('trusted')
    expect(await stateOf(s.knowledgeId)).toBe('trusted')
  })
})
