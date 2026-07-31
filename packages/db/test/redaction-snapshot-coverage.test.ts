/**
 * The snapshot expression must distinguish every configuration shape the resolver
 * distinguishes.
 *
 * `REDACTION_INPUT_SNAPSHOT` exists so a writer can prove it is storing text under the same
 * rules it resolved. That proof is only as good as the snapshot's coverage: if two
 * configurations resolve DIFFERENTLY but snapshot IDENTICALLY, a change between them slips
 * past every guard built on it. That is not hypothetical - review loop 12 found exactly one
 * such pair, and loop 13 found the file claiming a test like this one already pinned the
 * two together when none existed. So this is that test, and the claim now has something
 * behind it.
 *
 * It lives in `packages/db` because that is where a database is available to evaluate the
 * SQL; the expression and the resolver are both in `@relayroom/shared`.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { REDACTION_INPUT_SNAPSHOT, resolveRedactionRules } from '@relayroom/shared'
import { createDb } from '../src/client'
import { projects } from '../src/schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/** Every shape the resolver treats as its own case, as raw JSON for the column. */
const SHAPES: { name: string; json: string }[] = [
  { name: 'empty object', json: '{}' },
  { name: 'json null root', json: 'null' },
  { name: 'scalar root', json: '"nope"' },
  { name: 'array root', json: '[]' },
  { name: 'rules present and empty', json: '{"redactionRules":[]}' },
  { name: 'rules present and null', json: '{"redactionRules":null}' },
  { name: 'one literal', json: '{"redactionRules":[{"kind":"literal","value":"ACME-TOKEN"}]}' },
  { name: 'legacy key present', json: '{"redactionPatterns":["x"]}' },
  { name: 'legacy key present and null', json: '{"redactionPatterns":null}' },
]

async function snapshotOf(json: string): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `sn-org-${sfx}`, slug: `sn-${sfx}`, name: 'Snapshot', connectCode: `sn-cc-${sfx}`,
  }).returning({ id: projects.id })
  await db.execute(sql`update project set knowledge_config = ${json}::jsonb where id = ${p!.id}`)
  const [row] = await db.execute<{ s: string }>(sql`
    select ${sql.raw(REDACTION_INPUT_SNAPSHOT)} as s from project where id = ${p!.id}
  `)
  await db.delete(projects).where(eq(projects.id, p!.id))
  return row!.s
}

/** What the resolver decides, reduced to the part a guard has to preserve. */
function outcomeOf(json: string): string {
  const parsed: unknown = JSON.parse(json)
  const r = resolveRedactionRules(parsed as never)
  return JSON.stringify({ patterns: r.patterns, unresolved: r.unresolved.map(u => u.reason) })
}

describe('the snapshot covers what the resolver branches on', () => {
  it('gives different snapshots to every pair that resolves differently', async () => {
    const rows = await Promise.all(SHAPES.map(async s => ({
      ...s, snapshot: await snapshotOf(s.json), outcome: outcomeOf(s.json),
    })))

    const collisions: string[] = []
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!, b = rows[j]!
        if (a.outcome !== b.outcome && a.snapshot === b.snapshot) {
          collisions.push(`${a.name} vs ${b.name}: resolve differently, snapshot identically`)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  it('covers the pair loop 12 found, specifically', async () => {
    // Named on its own so a regression reports the case rather than a generic collision.
    // `{}` resolves clean; a JSON null root is unresolvable. Before the fix both produced
    // the same snapshot text.
    expect(await snapshotOf('{}')).not.toBe(await snapshotOf('null'))
    expect(outcomeOf('{}')).not.toBe(outcomeOf('null'))
  })
})
