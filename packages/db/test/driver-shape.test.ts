/**
 * This package on the OTHER driver.
 *
 * `packages/db` is consumed by two clients: postgres-js (its own `createDb`, used by
 * apps/server) and node-postgres (apps/web). Every other test file here runs on
 * postgres-js, so a green run is a statement about half the callers - and the half it
 * says nothing about is the only production caller of `decideProposal`.
 *
 * That is not hypothetical. `2230041` wrote `const [row] = await tx.execute(...)`, which
 * postgres-js satisfies (it returns an array) and node-postgres does not (it returns
 * `{ rows, rowCount }`). The function threw `TypeError: (intermediate value) is not
 * iterable` everywhere it actually ran; the dashboard caught it and told the user the
 * proposal was already decided. This package was green throughout, and it was the web
 * suite that caught it, in a different repository slice, during release assembly.
 *
 * So these cases run the real functions through a real node-postgres connection. They
 * are slower than the rest of the file set and that is the price of testing the caller
 * that exists rather than the one that is convenient.
 */
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { createDb } from '../src/client'
import { decideProposal, proposeKnowledgeDiff } from '../src/knowledge'
import { knowledge, knowledgeProposals, projects } from '../src/schema'
import { better_auth_user } from '../src/auth-schema'
import { TEST_DATABASE_URL } from '../../../test/db-url'

// The same client apps/web builds: drizzle over a pg Pool.
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const webDb = drizzle({ client: pool })
// postgres-js, for the seeding that is not the subject of the test.
const db = createDb(TEST_DATABASE_URL)

afterAll(async () => {
  await pool.end()
  await db.$client.end()
})

const USER = `usr-driver-${randomBytes(4).toString('hex')}`

async function seed(secret = ''): Promise<{ projectId: string; proposalId: string }> {
  const sfx = randomBytes(6).toString('hex')
  await db.insert(better_auth_user)
    .values({ id: USER, name: 'Driver Tester', email: `${USER}@test.local` })
    .onConflictDoNothing()
  const [p] = await db.insert(projects).values({
    organizationId: `dr-org-${sfx}`, slug: `dr-${sfx}`, name: 'Driver', connectCode: `dr-cc-${sfx}`,
  }).returning({ id: projects.id })

  // Created through the OTHER driver too - proposeKnowledgeDiff has the same idiom and
  // today only the server calls it, which is how a second copy of this bug sat in the
  // same file undetected.
  const proposal = await proposeKnowledgeDiff(webDb as never, {
    projectId: p!.id,
    target: 'knowledge',
    hypothesis: 'agents keep forgetting to run migrations',
    disconfirming: 'the error stops appearing without any playbook change',
    change: {
      kind: 'pitfall',
      title: 'run migrations first',
      body: `the schema moves before the code does${secret}`,
    },
    triggerSignature: `sig-${sfx}`,
  })
  if (!proposal) throw new Error('proposeKnowledgeDiff returned null on node-postgres')
  return { projectId: p!.id, proposalId: proposal.id }
}

describe('packages/db on node-postgres (the driver apps/web uses)', () => {
  it('approves a proposal and writes the knowledge row', async () => {
    const { projectId, proposalId } = await seed()

    const result = await decideProposal(webDb as never, {
      proposalId, projectId, userId: USER, decision: 'approved',
    })

    // The failure this pins would not be a wrong answer, it would be a throw - so the
    // assertion is on the shape of a success, not on an error code.
    expect(result).toMatchObject({ ok: true, status: 'approved', target: 'knowledge' })
    if (!result.ok) return
    expect(result.knowledgeId, JSON.stringify(result)).toBeTruthy()
    const [row] = await db.select().from(knowledge).where(eq(knowledge.id, result.knowledgeId!))
    expect(row!.title).toBe('run migrations first')
    expect(row!.validationState).toBe('candidate')
  })

  it('redacts on that path too, so the fix did not restore the hole it closed', async () => {
    // The commit that broke this was the one that closed decideProposal's redaction gap.
    // A repair that made the function run again without redacting would look identical
    // from the outside - hence this case rather than a bare "it does not throw".
    const { projectId, proposalId } = await seed(' - the token ACME-SECRET unlocks the deploy')
    await db.update(projects)
      .set({ knowledgeConfig: { redactionRules: [{ kind: 'literal', value: 'ACME-SECRET' }] } })
      .where(eq(projects.id, projectId))

    const result = await decideProposal(webDb as never, {
      proposalId, projectId, userId: USER, decision: 'approved',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(knowledge).where(eq(knowledge.id, result.knowledgeId!))
    expect(row!.body).not.toContain('ACME-SECRET')
    expect(row!.body).toContain('unlocks the deploy')
  })

  it('rejects a proposal without throwing on this driver either', async () => {
    const { projectId, proposalId } = await seed()
    const result = await decideProposal(webDb as never, {
      proposalId, projectId, userId: USER, decision: 'rejected',
    })
    expect(result.ok).toBe(true)
    const [row] = await db.select().from(knowledgeProposals)
      .where(eq(knowledgeProposals.id, proposalId))
    expect(row!.status).toBe('rejected')
  })
})

/**
 * The structural half. The cases above catch the two call sites that exist; this catches
 * the next one, which will be written by someone who never read this file.
 *
 * A source scan rather than a type: drizzle's `execute` is typed per driver, and the
 * shared functions take a widened database type, so TypeScript cannot see the
 * difference - which is exactly why the original destructure compiled.
 */
describe('no raw execute() result is destructured in packages/db', () => {
  it('every execute() reads its rows through the helper', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
    const offenders: string[] = []
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(srcDir + name, 'utf8')
      text.split('\n').forEach((line, i) => {
        // Comments describing the bug are not the bug - execute.ts quotes the broken
        // form on purpose, and a scan that cannot tell those apart gets deleted.
        const code = line.trim()
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
        // Three ways to read an execute() result as if it were an array:
        //   const [x] = await tx.execute(...)      destructure
        //   (await tx.execute(...))[0]             index
        //   const rows = await tx.execute(...)     assign, then .length/.map later
        // The third is the one this scan nearly missed. It is not what shipped, but a
        // scan that only knows the shape of the bug it was written for stops working the
        // first time someone writes the same mistake differently - and the assignment
        // form is the natural way to write "give me all the rows".
        //
        // The wrapped form the fix uses reads `firstRow<T>(await db.execute(...))`, so
        // the `=` is followed by the helper, never by `await`. That is what makes the
        // assignment rule safe to state this bluntly.
        if (/(const|let)\s*\[[^\]]*\]\s*=\s*await\s+[\w.]*\bexecute\b/.test(code)
          || /await\s+[\w.]*\bexecute\b[^\n]*\)\s*\[\s*0\s*\]/.test(code)
          || /=\s*await\s+[\w.]*\bexecute\s*\(/.test(code)) {
          offenders.push(`${name}:${i + 1}: ${code}`)
        }
      })
    }
    expect(offenders, 'use firstRow()/rowsOf() - node-postgres returns {rows}, not an array').toEqual([])
  })
})
