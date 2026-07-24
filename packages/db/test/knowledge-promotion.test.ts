import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject } from '../src/bootstrap'
import { knowledge, knowledgeAudits, knowledgeValidations } from '../src/schema'
import { recordKnowledgeSignal, type RecordKnowledgeSignalInput } from '../src/knowledge'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/**
 * Promotion is the point where a claim stops being an agent's opinion and starts
 * being something other agents are told to trust. Every case here is a way that
 * could happen on evidence that should not have counted, or a way the audit trail
 * could end up describing something that never occurred.
 */
describe('knowledge promotion transaction', () => {
  let n = 0
  const seed = async (slug: string) => {
    const project = await getOrCreateProject(db, `kp-${slug}`)
    const [entry] = await db.insert(knowledge).values({
      projectId: project.id,
      kind: 'fact',
      title: `claim ${slug} ${n++}`,
      body: 'the extractor wrote this as a candidate',
      sourceKind: 'learn',
    }).returning()
    return { project, entry: entry! }
  }

  const support = (
    over: Partial<RecordKnowledgeSignalInput> & Pick<RecordKnowledgeSignalInput, 'projectId' | 'knowledgeId'>,
  ): RecordKnowledgeSignalInput => ({
    signal: 'support',
    issuer: 'human',
    issuerId: 'user-a',
    sourceFingerprint: 'fp-a',
    actorKind: 'human',
    ...over,
  })

  const stateOf = async (id: string) => {
    const [row] = await db.select().from(knowledge).where(eq(knowledge.id, id))
    return row!
  }
  const auditsOf = async (id: string) =>
    db.select().from(knowledgeAudits).where(eq(knowledgeAudits.knowledgeId, id))

  it('does not promote on a single issuer', async () => {
    // One voice is not agreement. This is the default the whole design rests on.
    const { project, entry } = await seed('single')
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
    }))
    expect(result).toMatchObject({ ok: true, recorded: true, changed: false, state: 'candidate' })
    expect(result.promotingIssuers).toBe(1)
    expect((await stateOf(entry.id)).promotedAt).toBeNull()
    expect(await auditsOf(entry.id)).toHaveLength(0)
  })

  it('promotes on two distinct issuers and audits it once', async () => {
    const { project, entry } = await seed('two-issuers')
    await recordKnowledgeSignal(db, support({ projectId: project.id, knowledgeId: entry.id }))
    const second = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      issuer: 'ci_attest', issuerId: 'ci', sourceFingerprint: 'fp-ci-1', actorKind: 'ci',
    }))
    expect(second).toMatchObject({ ok: true, changed: true, state: 'trusted', promotingIssuers: 2 })

    const row = await stateOf(entry.id)
    expect(row.validationState).toBe('trusted')
    expect(row.promotedAt).not.toBeNull()

    const audits = await auditsOf(entry.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'promote', fromState: 'candidate', toState: 'trusted' })
    expect(audits[0]!.detail).toMatchObject({ override: false, promotingIssuers: 2 })
  })

  it('counts identities, not runs: many CI runs stay one voice', async () => {
    // The reason promotion counts DISTINCT issuer_id. A pipeline that can run
    // itself N times must not be able to reach K on its own.
    const { project, entry } = await seed('ci-runs')
    for (const run of ['r1', 'r2', 'r3']) {
      const result = await recordKnowledgeSignal(db, support({
        projectId: project.id, knowledgeId: entry.id,
        issuer: 'ci_attest', issuerId: 'ci', sourceFingerprint: `fp-${run}`, actorKind: 'ci',
      }))
      expect(result.promotingIssuers).toBe(1)
      expect(result.changed).toBe(false)
    }
    expect((await stateOf(entry.id)).validationState).toBe('candidate')
  })

  it('ignores an uncounted attestation entirely', async () => {
    // An attestation with no check mapping is history, not evidence: it must be
    // stored and must not move the count.
    const { project, entry } = await seed('uncounted')
    await recordKnowledgeSignal(db, support({ projectId: project.id, knowledgeId: entry.id }))
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      issuer: 'ci_attest', issuerId: 'ci', sourceFingerprint: 'fp-unmapped',
      counted: false, actorKind: 'ci',
    }))
    expect(result.recorded).toBe(true)
    expect(result.promotingIssuers).toBe(1)
    expect(result.changed).toBe(false)
    expect((await stateOf(entry.id)).validationState).toBe('candidate')
  })

  it('never lets an error event promote', async () => {
    // error_event is a contradiction source. Two of them are not two voices for.
    const { project, entry } = await seed('error-issuer')
    for (const id of ['e1', 'e2']) {
      const result = await recordKnowledgeSignal(db, support({
        projectId: project.id, knowledgeId: entry.id,
        issuer: 'error_event', issuerId: id, sourceFingerprint: `fp-${id}`, actorKind: 'system',
      }))
      expect(result.promotingIssuers).toBe(0)
    }
    expect((await stateOf(entry.id)).validationState).toBe('candidate')
  })

  it('promotes at K=1 on an owner override, and records the override', async () => {
    const { project, entry } = await seed('override')
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true,
    }))
    expect(result).toMatchObject({ changed: true, state: 'trusted', promotingIssuers: 1 })
    const audits = await auditsOf(entry.id)
    expect(audits[0]!.detail).toMatchObject({ override: true })
  })

  it('blocks promotion while a contradiction stands', async () => {
    // Even an owner override does not promote something currently refuted.
    const { project, entry } = await seed('contradicted-block')
    await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error',
      sourceFingerprint: 'fp-err', actorKind: 'system',
    }))
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true,
    }))
    expect(result.contradictions).toBe(1)
    expect(result.changed).toBe(false)
    expect((await stateOf(entry.id)).validationState).toBe('contradicted')
  })

  it('demotes a trusted entry immediately, keeping the promotion in history', async () => {
    const { project, entry } = await seed('demote')
    await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true,
    }))
    const promotedAt = (await stateOf(entry.id)).promotedAt
    expect(promotedAt).not.toBeNull()

    const demoted = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error',
      sourceFingerprint: 'fp-err', actorKind: 'system',
    }))
    expect(demoted).toMatchObject({ changed: true, state: 'contradicted' })

    const row = await stateOf(entry.id)
    expect(row.validationState).toBe('contradicted')
    expect(row.promotedAt).toEqual(promotedAt) // history, not current state

    const audits = await auditsOf(entry.id)
    expect(audits.map(a => a.action).sort()).toEqual(['demote', 'promote'])
    expect(audits.find(a => a.action === 'demote')).toMatchObject({
      fromState: 'trusted', toState: 'contradicted',
    })
  })

  it('lets an agent error event demote a candidate', async () => {
    // L1: demotion is the safe direction, so an agent-sourced error_event may
    // trigger it (promotion by the same issuer never can - covered above). A
    // candidate that was contradicted before it was ever trusted still ends up
    // contradicted, and the audit records the candidate it came from.
    const { project, entry } = await seed('demote-candidate')
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error',
      sourceFingerprint: 'fp-err', actorKind: 'system',
    }))
    expect(result).toMatchObject({ changed: true, state: 'contradicted' })
    expect((await stateOf(entry.id)).promotedAt).toBeNull() // never promoted

    const audits = await auditsOf(entry.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'demote', fromState: 'candidate', toState: 'contradicted', actorKind: 'system',
    })
  })

  it('records a further contradiction as evidence but does not demote or audit twice', async () => {
    // Once contradicted, the state does not change again, so a second error must
    // not write a second demote audit - but it is still recorded as evidence.
    const { project, entry } = await seed('demote-again')
    const contradict = (fp: string) => support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error', sourceFingerprint: fp,
      actorKind: 'system',
    })
    await recordKnowledgeSignal(db, contradict('fp-1'))
    const second = await recordKnowledgeSignal(db, contradict('fp-2'))
    expect(second).toMatchObject({ ok: true, recorded: true, changed: false, state: 'contradicted' })
    expect(await auditsOf(entry.id)).toHaveLength(1) // still one demote

    const validations = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(validations).toHaveLength(2) // both errors kept as evidence
  })

  it('dedups a repeated error signature so one flake is not two contradictions', async () => {
    // The same failing check re-run is one contradiction, exactly as the same
    // green check re-run is one support.
    const { project, entry } = await seed('demote-dedup')
    const same = support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error', sourceFingerprint: 'fp-flake',
      actorKind: 'system',
    })
    const first = await recordKnowledgeSignal(db, same)
    const again = await recordKnowledgeSignal(db, same)
    expect(first.recorded).toBe(true)
    expect(again.recorded).toBe(false)
    expect(again.contradictions).toBe(1)
    const validations = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(validations).toHaveLength(1)
  })

  it('is idempotent: replaying the same signal writes no second audit row', async () => {
    // A retried request must not double-audit, and must not report a change it
    // did not make.
    const { project, entry } = await seed('replay')
    const input = support({ projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true })
    const first = await recordKnowledgeSignal(db, input)
    const again = await recordKnowledgeSignal(db, input)
    expect(first.changed).toBe(true)
    expect(again).toMatchObject({ ok: true, recorded: false, changed: false, state: 'trusted' })
    expect(await auditsOf(entry.id)).toHaveLength(1)
    const validations = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(validations).toHaveLength(1)
  })

  it('refuses an entry that belongs to another project, and writes nothing', async () => {
    // The tenant boundary. A project's CI secret reaches this path, so a wrong
    // projectId must not become a write against someone else's claim.
    const { entry } = await seed('tenant-owner')
    const other = await getOrCreateProject(db, 'kp-tenant-attacker')
    const result = await recordKnowledgeSignal(db, support({
      projectId: other.id, knowledgeId: entry.id, humanOwnerOverride: true,
    }))
    expect(result.ok).toBe(false)
    expect((await stateOf(entry.id)).validationState).toBe('candidate')
    const validations = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(validations).toHaveLength(0)
    expect(await auditsOf(entry.id)).toHaveLength(0)
  })

  it('reports a missing entry the same way as another project\'s entry', async () => {
    // Same answer for "does not exist" and "is not yours": otherwise the caller
    // can probe which ids exist elsewhere.
    const { project } = await seed('missing')
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: '00000000-0000-0000-0000-000000000000',
    }))
    expect(result).toMatchObject({ ok: false, recorded: false, state: null, changed: false })
  })

  it('does not resurrect a contradicted entry', async () => {
    // The state guard lives in the WHERE clause. Support arriving after a
    // contradiction must not promote it back behind a human's back.
    const { project, entry } = await seed('resurrect')
    await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error',
      sourceFingerprint: 'fp-err', actorKind: 'system',
    }))
    // Age the contradiction out of the window, so nothing but the state guard is
    // left standing between two agreeing issuers and a silent promotion.
    await db.update(knowledgeValidations)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000) })
      .where(eq(knowledgeValidations.knowledgeId, entry.id))

    // Two honest issuers agree, but the entry is under review: it stays put.
    await recordKnowledgeSignal(db, support({ projectId: project.id, knowledgeId: entry.id }))
    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      issuer: 'ci_attest', issuerId: 'ci', sourceFingerprint: 'fp-ci', actorKind: 'ci',
    }))
    expect(result.promotingIssuers).toBe(2)
    expect(result.contradictions).toBe(0) // the block is the state, not the count
    expect(result.changed).toBe(false)
    expect((await stateOf(entry.id)).validationState).toBe('contradicted')
  })

  it('ignores a contradiction that has aged out of the window', async () => {
    const { project, entry } = await seed('window')
    await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id,
      signal: 'contradict', issuer: 'error_event', issuerId: 'error',
      sourceFingerprint: 'fp-old', actorKind: 'system',
    }))
    // Age it past the window, and put the entry back under review as a human would.
    await db.update(knowledgeValidations)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000) })
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    await db.update(knowledge).set({ validationState: 'candidate' })
      .where(eq(knowledge.id, entry.id))

    const result = await recordKnowledgeSignal(db, support({
      projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true, windowDays: 30,
    }))
    expect(result.contradictions).toBe(0)
    expect(result.changed).toBe(true)
    expect(result.state).toBe('trusted')
  })

  it('makes a second signal wait for the first, so the Kth vote sees the others', async () => {
    // The row lock, observed rather than assumed: two callers racing by luck
    // usually happen to serialize anyway. Here the first holds its transaction
    // open on purpose, and the second must be unable to proceed until it commits.
    //
    // Without the lock the second caller reads a count that does not yet include
    // the first, concludes K-1, and the entry never reaches trusted at all.
    const { project, entry } = await seed('race')
    let secondSettled = false
    let second!: Promise<Awaited<ReturnType<typeof recordKnowledgeSignal>>>

    await db.transaction(async tx => {
      const first = await recordKnowledgeSignal(tx, support({
        projectId: project.id, knowledgeId: entry.id,
        issuerId: 'user-a', sourceFingerprint: 'fp-a',
      }))
      expect(first.changed).toBe(false) // one issuer so far

      second = recordKnowledgeSignal(db, support({
        projectId: project.id, knowledgeId: entry.id,
        issuerId: 'user-b', sourceFingerprint: 'fp-b',
      })).then(r => { secondSettled = true; return r })

      await Promise.race([second, new Promise(r => setTimeout(r, 300))])
      expect(secondSettled).toBe(false) // queued behind the lock, not reading past it
    })

    expect(await second).toMatchObject({ changed: true, state: 'trusted', promotingIssuers: 2 })
    expect((await stateOf(entry.id)).validationState).toBe('trusted')
    expect(await auditsOf(entry.id)).toHaveLength(1)
  })

  it('composes into a caller\'s transaction and rolls back with it', async () => {
    // The reason it takes a handle rather than opening its own connection: the
    // attest endpoint does more than this in one unit of work.
    const { project, entry } = await seed('rollback')
    await expect(db.transaction(async tx => {
      const result = await recordKnowledgeSignal(tx, support({
        projectId: project.id, knowledgeId: entry.id, humanOwnerOverride: true,
      }))
      expect(result.state).toBe('trusted')
      throw new Error('caller failed after promoting')
    })).rejects.toThrow('caller failed after promoting')

    expect((await stateOf(entry.id)).validationState).toBe('candidate')
    expect(await auditsOf(entry.id)).toHaveLength(0)
  })
})
