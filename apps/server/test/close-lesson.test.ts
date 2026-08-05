/**
 * `close` with a lesson (FEAT-0002 L1): what gets stored, what refuses, and what a
 * refusal costs.
 *
 * THE TWO PROPERTIES THESE TESTS EXIST FOR:
 *
 * 1. A refused lesson never costs the caller their close. Eight refusal codes, and in
 *    all eight the thread still ends up closed - because an agent that reads a refusal
 *    as a failed close will re-close forever.
 * 2. A recorded lesson claims the thread, so nothing records a second one for it. The
 *    claim is the only serialization point - close carries no idempotency key - and the
 *    negative control below is what proves the claim is what does it rather than
 *    something incidental to the test setup. Until 0.6.3 the competitor was the automatic
 *    extractor; it is gone, and a retry or a simultaneous close is what remains.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { agents, knowledge, projectAccess, projects, threadExtractions, threads } from '@relayroom/db'
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
const USER = `cl-user-${SFX}`
const READER = `cl-reader-${SFX}`
const ORG = `cl-org-${SFX}`
const CODE = `cl-cc-${SFX}`
const TOKEN = randomBytes(24).toString('hex')
const READER_TOKEN = randomBytes(24).toString('hex')
let projectId: string

async function seedUser(id: string) {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${id}, ${id + '@cl.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'cl-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${id}, 'member', NOW())`
}

async function mintToken(raw: string, userId: string) {
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'cl-tok-' + randomBytes(6).toString('hex')}, ${raw}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${userId}, ${projectScope(projectId)}, NOW(), NOW())`
}

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('cl-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Close Lesson Org', NOW())`
  await seedUser(USER)
  await seedUser(READER)

  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `cl-${SFX}`, name: 'Close Lesson Project', connectCode: CODE,
  }).returning({ id: projects.id })
  projectId = proj!.id

  await db.insert(agents).values({ projectId, part: 'writer', ownerUserId: USER })
  await db.insert(agents).values({ projectId, part: 'reader', ownerUserId: READER })
  await db.insert(projectAccess).values({ projectId, userId: USER, level: 'write' })

  await mintToken(TOKEN, USER)
  await mintToken(READER_TOKEN, READER)
})

beforeEach(async () => {
  resetLearnRateLimit()
  // Back to a project that configured nothing, which is every project today.
  await db.update(projects).set({ knowledgeConfig: {} }).where(eq(projects.id, projectId))
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

/** Opens a thread and returns its id. */
async function openThread(subject: string, body = 'the conversation body'): Promise<string> {
  const sent = await callTool('writer', TOKEN, 'send', { subject, body, to: ['reader'] })
  return (JSON.parse(sent.text) as { threadId: string }).threadId
}

interface CloseResponse {
  ok: boolean
  status: string
  lesson?: { recorded: true, knowledgeId: string } | { recorded: false, code: string, reason: string }
}

async function closeWith(
  threadId: string, lesson?: Record<string, unknown>, part = 'writer', token = TOKEN,
): Promise<CloseResponse> {
  const r = await callTool(part, token, 'close', lesson ? { threadId, lesson } : { threadId })
  expect(r.isError, r.text).toBe(false)
  return JSON.parse(r.text) as CloseResponse
}

const LESSON = {
  title: 'roll a migration back with the down script',
  body: 'run the down script first, then redeploy - the other order leaves the schema ahead of the code',
  kind: 'pitfall' as const,
}

async function statusOf(threadId: string): Promise<string> {
  const [t] = await db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId))
  return t!.status
}

async function rowsCiting(threadId: string) {
  return db.select().from(knowledge).where(and(
    eq(knowledge.projectId, projectId),
    sql`${knowledge.sourceRefs} @> ${JSON.stringify([{ threadId }])}::jsonb`,
  ))
}

describe('close with a lesson', () => {
  it('records a candidate citing the thread, claims it, and closes the thread', async () => {
    const threadId = await openThread('how to roll back a migration')
    const res = await closeWith(threadId, LESSON)

    expect(res.lesson).toMatchObject({ recorded: true })
    expect(await statusOf(threadId)).toBe('closed')

    const rows = await rowsCiting(threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe(LESSON.title)
    expect(rows[0]!.body).toBe(LESSON.body)
    // 'lesson', not 'thread' - the value the removed extractor used. Two writers sharing
    // one source_kind is what made the two indistinguishable in the data.
    expect(rows[0]!.sourceKind).toBe('lesson')
    // A lesson an agent wrote is a claim, not a fact - the same rule `learn` follows.
    // If this could ever be 'trusted', an agent would be authoring facts for every
    // other agent through `recall`.
    expect(rows[0]!.validationState).toBe('candidate')

    const [mark] = await db.select().from(threadExtractions).where(and(
      eq(threadExtractions.projectId, projectId), eq(threadExtractions.threadId, threadId),
    ))
    expect(mark!.reason).toBe('extracted')
  })

  it('claims the thread, so nothing else can record a second lesson for it', async () => {
    // REWRITTEN in 0.6.3. This used to run the automatic extractor and assert it skipped
    // the claimed thread, with a second unlessoned thread as the control that the sweep
    // had really run. The sweep is gone, and with it the competitor this claim was built
    // against - but not the claim's job: a retry and two simultaneous closes still have
    // to produce one lesson. The control is now the same thread's second close.
    const threadId = await openThread('a thread that carries its own lesson')
    expect(await closeWith(threadId, LESSON)).toMatchObject({ lesson: { recorded: true } })

    const again = await closeWith(threadId, { ...LESSON, title: 'a second attempt' })
    expect(again.lesson).toMatchObject({ recorded: false, code: 'already_decided' })
    expect(await rowsCiting(threadId)).toHaveLength(1)
  })

  it('applies the project redaction rules to what it stores', async () => {
    await db.update(projects).set({
      knowledgeConfig: { redactionRules: [{ kind: 'literal', value: 'ACME-SECRET' }] },
    }).where(eq(projects.id, projectId))

    const threadId = await openThread('a thread with a secret in its lesson')
    const res = await closeWith(threadId, {
      ...LESSON, body: 'the token ACME-SECRET is what the deploy needs',
    })
    expect(res.lesson).toMatchObject({ recorded: true })

    const rows = await rowsCiting(threadId)
    expect(rows[0]!.body).not.toContain('ACME-SECRET')
    // And the rest of the sentence survived - redaction drops the match, not the body.
    expect(rows[0]!.body).toContain('is what the deploy needs')
  })
})

describe('close with a lesson - every refusal still closes the thread', () => {
  it('refuses a caller who may close but may not write knowledge', async () => {
    const threadId = await openThread('a thread closed by a reader')
    const res = await closeWith(threadId, LESSON, 'reader', READER_TOKEN)

    expect(res.lesson).toMatchObject({ recorded: false, code: 'unauthorized' })
    expect(res.ok).toBe(true)
    expect(await statusOf(threadId)).toBe('closed')
    expect(await rowsCiting(threadId)).toHaveLength(0)
    // Nothing was claimed either, so a later close can still record a lesson here.
    const marks = await db.select().from(threadExtractions)
      .where(eq(threadExtractions.threadId, threadId))
    expect(marks).toHaveLength(0)
  })

  it('refuses when the project turned distillation off, and records when it is absent', async () => {
    await db.update(projects).set({ knowledgeConfig: { distillOnClose: false } })
      .where(eq(projects.id, projectId))
    const off = await openThread('a thread in a project that opted out')
    expect(await closeWith(off, LESSON)).toMatchObject({
      lesson: { recorded: false, code: 'distill_disabled' },
    })
    expect(await statusOf(off)).toBe('closed')

    // ABSENT IS ON. Every project holds `{}` today, so a default of off would mean the
    // feature exists for nobody until each owner finds a switch they were never told
    // about. `=== false` is what distinguishes the two, and this is the assertion that
    // would go red if it became a truthiness check.
    await db.update(projects).set({ knowledgeConfig: {} }).where(eq(projects.id, projectId))
    const on = await openThread('a thread in a project that configured nothing')
    expect(await closeWith(on, LESSON)).toMatchObject({ lesson: { recorded: true } })
  })

  it('refuses on a canceled thread', async () => {
    const threadId = await openThread('a thread that was abandoned')
    await db.update(threads).set({ status: 'canceled' }).where(eq(threads.id, threadId))

    const res = await closeWith(threadId, LESSON)
    expect(res.lesson).toMatchObject({ recorded: false, code: 'thread_canceled' })
    // And the cancellation stands - the conditional update must not overwrite it.
    expect(await statusOf(threadId)).toBe('canceled')
    expect(await rowsCiting(threadId)).toHaveLength(0)
  })

  it('refuses when a configured redaction rule cannot be resolved', async () => {
    // Fail closed: a rule the owner switched on and we cannot apply means nothing is
    // stored. Storing it anyway and logging the problem is observation, not protection.
    await db.update(projects).set({
      knowledgeConfig: { redactionRules: [{ kind: 'detector', id: 'no-such-detector', v: 1 }] },
    }).where(eq(projects.id, projectId))

    const threadId = await openThread('a thread in a misconfigured project')
    const res = await closeWith(threadId, LESSON)
    expect(res.lesson).toMatchObject({ recorded: false, code: 'redaction_unresolvable' })
    expect(await statusOf(threadId)).toBe('closed')
    expect(await rowsCiting(threadId)).toHaveLength(0)
  })

  it('refuses a lesson that redaction emptied', async () => {
    await db.update(projects).set({
      knowledgeConfig: { redactionRules: [{ kind: 'literal', value: 'WHOLE-BODY' }] },
    }).where(eq(projects.id, projectId))

    const threadId = await openThread('a thread whose lesson was all secret')
    const res = await closeWith(threadId, { ...LESSON, body: 'WHOLE-BODY' })
    expect(res.lesson).toMatchObject({ recorded: false, code: 'empty_after_redaction' })
    expect(await rowsCiting(threadId)).toHaveLength(0)
  })

  it('refuses a second lesson for the same thread', async () => {
    const threadId = await openThread('a thread closed twice')
    expect(await closeWith(threadId, LESSON)).toMatchObject({ lesson: { recorded: true } })

    // The retry an agent makes when a response is lost. One code for retry, competing
    // close and purge, because close carries no idempotency key and the data cannot tell
    // them apart. (It covered the extractor too until 0.6.3 removed it.)
    const again = await closeWith(threadId, { ...LESSON, title: 'a different lesson' })
    expect(again.lesson).toMatchObject({ recorded: false, code: 'already_decided' })
    expect(await rowsCiting(threadId)).toHaveLength(1)
  })

  it('gives one of two concurrent closes the lesson and the other a refusal', async () => {
    // The contended case, run concurrently rather than reasoned about: the watermark's
    // primary key is what decides it, so one insert waits for the other to commit and
    // then finds a conflict. Both closes succeed; exactly one lesson exists.
    const threadId = await openThread('a thread two agents closed at once')
    const [a, b] = await Promise.all([
      closeWith(threadId, LESSON),
      closeWith(threadId, { ...LESSON, title: 'the other agent\'s version' }),
    ])
    const outcomes = [a.lesson, b.lesson]
    expect(outcomes.filter(o => o?.recorded === true)).toHaveLength(1)
    expect(outcomes.filter(o => o?.recorded === false)).toMatchObject([{ code: 'already_decided' }])
    expect(await rowsCiting(threadId)).toHaveLength(1)
    expect(await statusOf(threadId)).toBe('closed')
  })

  it('does not share the learn ceiling', async () => {
    // Separate limiters, because the two are bounded by different things: `learn` is
    // bounded by an agent's willingness to call it, which a loop removes, while a
    // close-carried lesson is bounded by closes. A shared ceiling would mean a busy day
    // of closing silently costs the project its knowledge.
    let learnRefusals = 0
    for (let i = 0; i < 25; i++) {
      const r = await callTool('writer', TOKEN, 'learn', {
        title: `filler ${i}`, body: `filler body ${i}`, kind: 'fact',
      })
      if (r.isError || /rate|limit/i.test(r.text)) learnRefusals++
    }
    expect(learnRefusals).toBeGreaterThan(0) // the learn ceiling really was reached

    const threadId = await openThread('a thread closed after a day of learning')
    expect(await closeWith(threadId, LESSON)).toMatchObject({ lesson: { recorded: true } })
  })
})

/**
 * The rule-change window: a trigger that fires BETWEEN the claim and the lesson insert,
 * which is the one interval a test outside the process cannot otherwise reach. The
 * extractor's removed test reached the same window in the same way, and this is now the
 * only place that guard is exercised against a real interleaving.
 *
 * What this proves and what it does not: it proves the guard sits on the statement that
 * stores the text, because the trigger's UPDATE commits into this transaction's view
 * before that statement runs. It does NOT prove that an independently committed settings
 * save survives - the trigger's own change rolls back with the savepoint, and claiming
 * otherwise is the mistake review loop 10 found in the extractor's version of this test.
 */
describe('close with a lesson - the rules changing under the write', () => {
  async function withTrigger(body: string, fn: () => Promise<void>) {
    // SCOPED TO THIS FILE'S PROJECT, and that is not tidiness. A trigger is database-wide
    // and vitest runs files in parallel over one database, so an unguarded body fires on
    // every other file's watermark inserts too - which is exactly what happened:
    // extractor-stale-patterns (since removed) failed in the full run and passed alone,
    // because this trigger was rewriting ITS project's redaction rules mid-run.
    await rawSql.unsafe(`
      create or replace function cl_mutate() returns trigger as $$
      begin
        if new.project_id <> '${projectId}' then return new; end if;
        ${body} return new; end $$ language plpgsql`)
    await rawSql.unsafe(`
      create trigger cl_mutate_trg after insert on thread_extraction
      for each row execute function cl_mutate()`)
    try { await fn() }
    finally {
      await rawSql.unsafe('drop trigger if exists cl_mutate_trg on thread_extraction')
      await rawSql.unsafe('drop function if exists cl_mutate()')
    }
  }

  it('refuses when the redaction rules change between the claim and the write', async () => {
    const threadId = await openThread('a thread closed while settings were being saved')
    await withTrigger(
      `update project set knowledge_config =
         jsonb_set(knowledge_config, '{redactionRules}', '[{"kind":"literal","value":"LATE-RULE"}]'::jsonb)
       where id = new.project_id;`,
      async () => {
        const res = await closeWith(threadId, LESSON)
        expect(res.lesson).toMatchObject({ recorded: false, code: 'storage_failed' })
        expect((res.lesson as { reason: string }).reason).toMatch(/redaction rules changed/)
        // The close still committed. That is the whole reason the lesson lives in a
        // savepoint rather than in the outer transaction.
        expect(await statusOf(threadId)).toBe('closed')
      },
    )
    expect(await rowsCiting(threadId)).toHaveLength(0)
    // And the claim went back with the savepoint, so this thread is not foreclosed.
    const marks = await db.select().from(threadExtractions)
      .where(eq(threadExtractions.threadId, threadId))
    expect(marks).toHaveLength(0)
    // And the thread can still receive a lesson later, which is the whole point of
    // rolling the claim back rather than keeping it.
    expect(await closeWith(threadId, LESSON)).toMatchObject({ lesson: { recorded: true } })
    expect(await rowsCiting(threadId)).toHaveLength(1)
  })

  it('refuses the lesson when a cancellation lands between the read and the transaction', async () => {
    // THE WINDOW REVIEW LOOP 14 FOUND, reached the only way it can be from outside the
    // process. `close` decides `thread_canceled` from a read taken before its transaction
    // opens; a cancellation committing in that gap used to leave the lesson and its
    // watermark durable, the conditional update finding zero rows, and the response
    // reporting "closed" over a canceled thread.
    //
    // The hook is `touchAgent`, which UPDATEs the agent row inside the pre-transaction
    // refusal block. THE COUNTER IS NOT DECORATION: the auth path calls touchAgent too,
    // BEFORE the tool handler reads the thread, so a trigger that fires on the first
    // update cancels the thread before the read and the close then refuses through the
    // ordinary pre-transaction branch. The test passes either way and proves nothing -
    // which the mutation control caught, and which is the same "the name says it reached
    // the window" failure this round has now produced four times. Firing on the SECOND
    // update puts the cancellation after the read and before the transaction.
    const threadId = await openThread('a thread canceled between the read and the write')
    await rawSql.unsafe('drop sequence if exists cl_touch_seq')
    await rawSql.unsafe('create sequence cl_touch_seq')
    await rawSql.unsafe(`
      create or replace function cl_cancel() returns trigger as $$
      begin
        -- Same scoping rule as cl_mutate: this fires on every agent row in the database,
        -- so anything it does has to be keyed to this file's own project.
        if new.project_id <> '${projectId}' then return new; end if;
        if nextval('cl_touch_seq') >= 2 then
          update thread set status = 'canceled'
           where id = '${threadId}' and status <> 'canceled';
        end if;
        return new;
      end $$ language plpgsql`)
    await rawSql.unsafe(`
      create trigger cl_cancel_trg after update on agent
      for each row execute function cl_cancel()`)
    try {
      const res = await closeWith(threadId, LESSON)
      expect(res.lesson).toMatchObject({ recorded: false, code: 'thread_canceled' })
      // The reason distinguishes this from the pre-transaction refusal, so a test that
      // reached the wrong window cannot pass by landing on the other branch.
      expect((res.lesson as { reason: string }).reason).toMatch(/while this close was being prepared/)
      // And the response says what the thread IS, not what the call asked for.
      expect(res.status).toBe('canceled')
    }
    finally {
      await rawSql.unsafe('drop trigger if exists cl_cancel_trg on agent')
      await rawSql.unsafe('drop function if exists cl_cancel()')
      await rawSql.unsafe('drop sequence if exists cl_touch_seq')
    }

    expect(await statusOf(threadId)).toBe('canceled')
    expect(await rowsCiting(threadId)).toHaveLength(0)
    // Nothing was claimed, so the thread is not foreclosed - though a canceled thread has
    // nothing to record either, which is the point of refusing rather than storing.
    const marks = await db.select().from(threadExtractions)
      .where(eq(threadExtractions.threadId, threadId))
    expect(marks).toHaveLength(0)
  })

  it('keeps a lesson when the cancellation lands after the close committed its status', async () => {
    // The other side of the same boundary, and the reason the test above is not just
    // "cancellation always wins": once this close has changed the status, the thread WAS
    // resolved and the lesson is legitimate. A later cancellation is a different writer's
    // decision about a closed thread, not a refusal of ours.
    //
    // The trigger fires on the watermark insert, which the reorder put AFTER the status
    // update - so this reaches the second half of the window rather than the first.
    const threadId = await openThread('a thread canceled after it was closed')
    await withTrigger(
      `update thread set status = 'canceled' where id = new.thread_id;`,
      async () => {
        const res = await closeWith(threadId, LESSON)
        expect(res.lesson).toMatchObject({ recorded: true })
      },
    )
    expect(await statusOf(threadId)).toBe('canceled')
    expect(await rowsCiting(threadId)).toHaveLength(1)
  })

  it('is not disturbed by a project update that changes no redaction rule', async () => {
    // THE NEGATIVE CONTROL. Without it, the test above is equally consistent with a
    // guard that fails on ANY concurrent write to the project row - which would make
    // every close race with every unrelated settings save. The snapshot covers the
    // redaction keys and nothing else, and this is what says so.
    const threadId = await openThread('a thread closed while an unrelated setting moved')
    await withTrigger(
      `update project set knowledge_config =
         jsonb_set(knowledge_config, '{windowDays}', '30'::jsonb)
       where id = new.project_id;`,
      async () => {
        expect(await closeWith(threadId, LESSON)).toMatchObject({ lesson: { recorded: true } })
      },
    )
    expect(await rowsCiting(threadId)).toHaveLength(1)
  })
})
