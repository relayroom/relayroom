/**
 * END-TO-END LOOP EVAL (0.5.0 definition of done).
 *
 * Every other test pins one slice. This one asserts the thing the release actually
 * claims: that the knowledge loop CLOSES. One project walks a full turn -
 *
 *   learn -> candidate (L0)
 *   recall does not return it (trusted-only)
 *   thread close -> marker -> extractor sweep -> candidate (L3)
 *   two DISTINCT non-agent issuers -> trusted (L1)
 *   recall now returns it - the lesson crosses agents (L0)
 *   an agent contradicts it -> demoted (L1)
 *   recurring errors + the contradiction -> pending proposals (L4)
 *   the daily metrics row is written (L2)
 *   a promoted fact appears in the served playbook (L5)
 *
 * against a real Postgres (CI runs a postgres:18 service; see .github/workflows/ci.yml).
 *
 * THE LOAD-BEARING ASSERTION is the negative control in "L1 - the promotion gate":
 * agent-sourced signals alone must NEVER promote. One issuer does not promote, and
 * the same issuer twice does not either (the whole CI system is one voice). If that
 * ever passes when it should not, every safety claim in this design is void - an
 * agent could author facts for every other agent. It is therefore asserted BEFORE
 * the positive promotion, so a regression cannot hide behind a later success.
 *
 * The steps are ordered and share state on purpose: this is a pipeline, and a failure
 * should name the stage that broke.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  agents,
  knowledge,
  knowledgeMetricDaily,
  knowledgeProposals,
  projectAccess,
  projects,
  proposeKnowledgeDiff,
  recordKnowledgeSignal,
} from '@relayroom/db'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'
import postgres from 'postgres'
import { isProjectDirty, runExtractorSweep } from '../src/knowledge/extractor-sweep'
import { runProposerSweep } from '../src/knowledge/proposer'
import { runKnowledgeMetricsRollup } from '../src/knowledge/metrics-rollup'
import { ERROR_SIGNATURE_VERSION } from '../src/knowledge/error-signature'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const SFX = randomBytes(5).toString('hex')
const ORG = `le-org-${SFX}`
const USER = `le-user-${SFX}`
const HUMAN = `le-human-${SFX}`
const CODE = `le-cc-${SFX}`
const TOKEN = randomBytes(24).toString('hex')
const CI_ISSUER = `le-ci-${SFX}`
/** The closed thread's subject; the L3 extractor titles the candidate with it, and
 *  the L5 block should therefore surface exactly this string. */
const SUBJECT = `migrations run before deploy ${SFX}`

let projectId: string

async function seedUser(id: string) {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${id}, ${id + '@le.test'}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'le-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${id}, 'member', NOW())
    ON CONFLICT DO NOTHING`
}

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('le-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Loop Eval Org', NOW())`
  await seedUser(USER)
  await seedUser(HUMAN)

  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `le-${SFX}`, name: 'Loop Eval', connectCode: CODE,
  }).returning({ id: projects.id })
  projectId = proj!.id

  await db.insert(agents).values({ projectId, part: 'worker', ownerUserId: USER })
  await db.insert(agents).values({ projectId, part: 'peer', ownerUserId: USER })
  await db.insert(projectAccess).values({ projectId, userId: USER, level: 'write' })

  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'le-tok-' + randomBytes(6).toString('hex')}, ${TOKEN}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${USER}, ${projectScope(projectId)}, NOW(), NOW())`
})

async function callTool(
  part: string, name: string, args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await app.request(`/mcp/${CODE}?part=${part}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
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

async function stateOf(id: string): Promise<string> {
  const [row] = await db.select({ s: knowledge.validationState }).from(knowledge).where(eq(knowledge.id, id))
  return row!.s
}

/** One support signal from a named issuer identity. Distinct issuerId = distinct voice. */
function support(knowledgeId: string, issuer: 'ci_attest' | 'human', issuerId: string, fp: string) {
  return recordKnowledgeSignal(db, {
    projectId,
    knowledgeId,
    signal: 'support',
    issuer,
    issuerId,
    sourceFingerprint: fp,
    actorKind: issuer === 'human' ? 'human' : 'ci',
    ...(issuer === 'human' ? { actorUserId: issuerId } : {}),
  })
}

let learnedId: string
let extractedId: string
let threadId: string

describe('the knowledge loop closes (0.5.0 DoD)', () => {
  it('L0: learn writes a CANDIDATE', async () => {
    const r = await callTool('worker', 'learn', {
      title: 'deploy window is Tuesday morning',
      body: 'releases go out Tuesday before noon so someone is around if it breaks',
      kind: 'convention',
    })
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.text) as { id: string; validationState: string }
    learnedId = parsed.id
    expect(parsed.validationState).toBe('candidate')
  })

  it('L0: recall does NOT return the candidate', async () => {
    const r = await callTool('peer', 'recall', { query: 'deploy window' })
    const { entries } = JSON.parse(r.text) as { entries: { id: string }[] }
    expect(entries.map(e => e.id)).not.toContain(learnedId)
  })

  it('L3: closing a thread raises the marker and the extractor writes a candidate', async () => {
    const sent = await callTool('worker', 'send', {
      subject: SUBJECT, body: 'we always run migrations before deploy, never after', to: ['peer'],
    })
    threadId = (JSON.parse(sent.text) as { threadId: string }).threadId

    const closed = await callTool('worker', 'close', { threadId })
    expect(closed.isError).toBe(false)
    expect(await isProjectDirty(db, projectId)).toBe(true)

    const swept = await runExtractorSweep(db, { projectId })
    expect(swept.candidates).toBe(1)

    const [row] = await db.select({ id: knowledge.id, state: knowledge.validationState, title: knowledge.title })
      .from(knowledge)
      .where(and(eq(knowledge.projectId, projectId), eq(knowledge.sourceKind, 'thread')))
    extractedId = row!.id
    expect(row!.state).toBe('candidate') // extraction is intake, never promotion
    expect(row!.title).toBe(SUBJECT)
  })

  it('L1 NEGATIVE CONTROL: one issuer - and the same issuer twice - never promotes', async () => {
    const first = await support(learnedId, 'ci_attest', CI_ISSUER, `fp-ci-a-${SFX}`)
    expect(first.ok).toBe(true)
    expect(await stateOf(learnedId)).toBe('candidate') // K=1 is not enough

    // The whole CI system is ONE issuer: a second green run is more evidence from
    // the same voice, not a second voice. A hundred of these must not promote.
    await support(learnedId, 'ci_attest', CI_ISSUER, `fp-ci-b-${SFX}`)
    expect(await stateOf(learnedId)).toBe('candidate')

    // Nothing an agent can reach has moved it either: `learn` only ever wrote a
    // candidate, and there is no agent-callable promote.
    expect(await stateOf(extractedId)).toBe('candidate')
  })

  it('L1: a SECOND DISTINCT issuer promotes it to trusted', async () => {
    const r = await support(learnedId, 'human', HUMAN, `fp-human-${SFX}`)
    expect(r.ok).toBe(true)
    expect(r.state).toBe('trusted')
    expect(r.promotingIssuers).toBeGreaterThanOrEqual(2)

    const [row] = await db.select({ promotedAt: knowledge.promotedAt }).from(knowledge)
      .where(eq(knowledge.id, learnedId))
    expect(row!.promotedAt).not.toBeNull()
  })

  it('L0: recall NOW returns it - the lesson crosses agents', async () => {
    const r = await callTool('peer', 'recall', { query: 'deploy window' })
    const { entries, queryId } = JSON.parse(r.text) as { entries: { id: string }[]; queryId: string }
    expect(entries.map(e => e.id)).toContain(learnedId)
    expect(queryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('L1: an agent CONTRADICTS a trusted entry and it is demoted', async () => {
    const r = await callTool('worker', 'event', {
      type: 'error',
      detail: { contradicts: learnedId, code: 'E_DEPLOY_WINDOW', area: 'deploy' },
    })
    expect(r.isError).toBe(false)
    // Agents may demote, never promote - the asymmetry the trust model rests on.
    expect(await stateOf(learnedId)).toBe('contradicted')
  })

  it('L4: recurring errors and the contradiction become PENDING proposals', async () => {
    // A second agent hits the same failure -> 2 distinct agents -> threshold met.
    await callTool('peer', 'event', {
      type: 'error', detail: { code: 'E_DEPLOY_WINDOW', area: 'deploy' },
    })

    const r = await runProposerSweep(db, { propose: proposeKnowledgeDiff, projectId })
    expect(r.proposals).toBeGreaterThanOrEqual(1)

    const rows = await db.select().from(knowledgeProposals)
      .where(eq(knowledgeProposals.projectId, projectId))
    expect(rows.every(p => p.status === 'pending')).toBe(true)
    // Nothing is auto-applied: a proposal is a queue entry a human decides.
    expect(rows.every(p => p.decidedAt === null)).toBe(true)

    // Trigger 1: the recurring error signature.
    const fromError = rows.find(p => /^[0-9a-f]{64}$/.test(p.triggerSignature ?? ''))
    expect(fromError).toBeDefined()
    expect((fromError!.change as { kind?: string }).kind).toBe('pitfall')
    expect(fromError!.evidence.agents).toBe(2)

    // Trigger 2: the contradicted entry, as an input signal.
    expect(rows.some(p => p.triggerSignature === `contradicted:${learnedId}`)).toBe(true)
  })

  it('L2: the daily metrics rollup writes the row for the day', async () => {
    // The rollup closes days up to YESTERDAY, so run it as of tomorrow to close today.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const r = await runKnowledgeMetricsRollup(db, { projectId, now: tomorrow })
    expect(r.rows).toBeGreaterThan(0)

    const rows = await db.select().from(knowledgeMetricDaily)
      .where(eq(knowledgeMetricDaily.projectId, projectId))
    expect(rows.length).toBeGreaterThan(0)
    // The series is tied to the signature definition, so a redefinition is visible.
    expect(rows[0]!.normalizationVersion).toBe(ERROR_SIGNATURE_VERSION)
  })

  it('L5: a promoted fact reaches every agent through the served playbook', async () => {
    // Promote the EXTRACTED candidate through the same two-issuer gate: the thread
    // that closed in L3 becomes a fact the playbook serves.
    await support(extractedId, 'ci_attest', CI_ISSUER, `fp-ci-x-${SFX}`)
    const promoted = await support(extractedId, 'human', HUMAN, `fp-human-x-${SFX}`)
    expect(promoted.state).toBe('trusted')

    await db.update(projects)
      .set({ knowledgeConfig: { dynamicFactsBlock: true } })
      .where(eq(projects.id, projectId))

    const res = await app.request(`/mcp/${CODE}/relayroom-md`)
    expect(res.status).toBe(200)
    const md = await res.text()
    expect(md).toContain('## Trusted project facts')
    expect(md).toContain(SUBJECT)
    // The demoted entry must NOT be served.
    expect(md).not.toContain('deploy window is Tuesday morning')
    // And the norms hash is exposed for rr.sh drift checks.
    expect(res.headers.get('x-relayroom-playbook-hash')).toMatch(/^[0-9a-f]{64}$/)
  })
})
