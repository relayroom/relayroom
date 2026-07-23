/**
 * The MCP tool contract, snapshotted.
 *
 * `tools/list` is what every agent reads to decide what it can do and how to call
 * it, so a change here changes behaviour for every connected agent at once - and
 * nothing was pinning it. Renaming an argument, dropping an enum value, or
 * loosening a description all shipped silently.
 *
 * The snapshot is taken from the NORMALIZED reply, after cleanJsonSchema has
 * stripped the draft-07 keywords strict clients reject. That is the shape clients
 * actually receive; snapshotting the raw SDK output would pin something no client
 * sees.
 *
 * Written before the 0.5.0 knowledge tools exist on purpose: it fixes the current
 * contract first, so adding recall/learn/recall_used shows up as a diff a reviewer
 * can read rather than arriving inside a baseline nobody had checked.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agents, projects } from '@relayroom/db'
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
const USER = `tc-user-${SFX}`
const ORG = `tc-org-${SFX}`
const CONNECT_CODE = `tc-cc-${SFX}`
const TOKEN = randomBytes(24).toString('hex')

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('tc-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'Contract User', ${USER + '@tc.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Contract Org', NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'tc-mem-' + SFX}, ${ORG}, ${USER}, 'member', NOW())`

  const [proj] = await db.insert(projects).values({
    organizationId: ORG, slug: `tc-${SFX}`, name: 'Contract Project', connectCode: CONNECT_CODE,
  }).returning({ id: projects.id })
  await db.insert(agents).values({ projectId: proj!.id, part: 'agent', ownerUserId: USER })

  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'tc-tok-' + SFX}, ${TOKEN}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${USER}, ${projectScope(proj!.id)}, NOW(), NOW())`
})

interface ToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

/** The advertised tool list, as a client receives it. */
async function listTools(): Promise<ToolDescriptor[]> {
  const res = await app.request(`/mcp/${CONNECT_CODE}?part=agent`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  expect(res.status).toBe(200)
  const raw = await res.text()
  // The streamable transport frames replies as SSE; the payload is the data: line.
  const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
  const parsed = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : raw)
  const tools = parsed.result?.tools as ToolDescriptor[]
  expect(Array.isArray(tools)).toBe(true)
  // Sorted so the snapshot does not churn when registration order changes - the
  // order tools are declared in is not part of the contract.
  return [...tools].sort((a, b) => a.name.localeCompare(b.name))
}

describe('MCP tool contract', () => {
  it('advertises a stable set of tool names', async () => {
    // Kept separate from the full snapshot: adding or removing a TOOL is a much
    // bigger deal than editing a description, and this line makes that obvious in
    // a diff even if the schema snapshot is long.
    expect((await listTools()).map(t => t.name)).toMatchInlineSnapshot(`
      [
        "ack",
        "close",
        "event",
        "inbox",
        "learn",
        "recall",
        "recall_used",
        "reply",
        "roster",
        "search",
        "send",
        "show",
        "threads",
        "whoami",
      ]
    `)
  })

  it('advertises stable descriptions and input schemas', async () => {
    expect(await listTools()).toMatchSnapshot()
  })

  it('advertises schemas free of the keywords strict clients reject', async () => {
    // cleanJsonSchema exists because Gemini CLI and others reject draft-07
    // keywords outright. A tool added without going through that normalization
    // would break those clients for everyone, so assert the property rather than
    // trusting the snapshot to be read carefully.
    const banned = ['$schema', 'propertyNames', 'additionalProperties', 'patternProperties',
      'exclusiveMinimum', 'exclusiveMaximum']
    const walk = (node: unknown, path: string): string[] => {
      if (Array.isArray(node)) return node.flatMap((v, i) => walk(v, `${path}[${i}]`))
      if (!node || typeof node !== 'object') return []
      const o = node as Record<string, unknown>
      return [
        ...banned.filter(k => k in o).map(k => `${path}.${k}`),
        ...Object.entries(o).flatMap(([k, v]) => walk(v, `${path}.${k}`)),
      ]
    }
    const offenders = (await listTools()).flatMap(t => walk(t.inputSchema, t.name))
    expect(offenders).toEqual([])
  })
})
