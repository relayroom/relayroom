import { afterAll, describe, expect, it } from 'vitest'
import { projects } from '@relayroom/db'
import { makeTestApp } from './helpers'

const { app, db, bus } = makeTestApp()
afterAll(async () => {
  await bus.close()
  await db.$client.end()
})

// SSE is tenant-safe: callers scope to a project via a connect code (globally
// unique) or an agent token — never a slug. Each test seeds its own project and
// subscribes with ?code, then emits events carrying that project's real id.
let seq = 0
async function seedProject(): Promise<{ id: string; slug: string; code: string }> {
  seq += 1
  const slug = `sse-proj-${Date.now()}-${seq}`
  const code = `cc-sse-${Date.now()}-${seq}`
  const [row] = await db.insert(projects).values({
    organizationId: `org-${Date.now()}-${seq}`,
    slug,
    name: slug,
    connectCode: code,
  }).returning({ id: projects.id })
  if (!row) throw new Error('project insert failed')
  return { id: row.id, slug, code }
}

describe('GET /api/sse', () => {
  it('code subscription receives messages for all parts of that project', async () => {
    const p = await seedProject()
    const res = await app.request(`/api/sse?code=${p.code}`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    setTimeout(() => {
      bus.emit('message', {
        kind: 'message', projectId: p.id, project: p.slug, part: 'android',
        threadId: 'ta1', messageId: 'ma1', subject: 'android-msg', fromPart: 'web',
      })
      bus.emit('message', {
        kind: 'message', projectId: p.id, project: p.slug, part: 'web',
        threadId: 'ta2', messageId: 'ma2', subject: 'web-msg', fromPart: 'android',
      })
      // a different project's event must NOT arrive
      bus.emit('message', {
        kind: 'message', projectId: 'p-other', project: 'other-project', part: 'android',
        threadId: 'ta3', messageId: 'ma3', subject: 'other-proj-msg', fromPart: 'web',
      })
    }, 50)

    const { value: v1 } = await reader.read()
    const text1 = new TextDecoder().decode(v1)
    expect(text1).toContain('android-msg')

    const { value: v2 } = await reader.read()
    const text2 = new TextDecoder().decode(v2)
    expect(text2).toContain('web-msg')

    expect(text1 + text2).not.toContain('other-proj-msg')
    await reader.cancel()
  })

  it('missing token and code returns 401', async () => {
    const res = await app.request('/api/sse')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBeDefined()
  })

  it('slug-only (no code/token) is rejected with 401 (no tenant-unsafe fallback)', async () => {
    const res = await app.request('/api/sse?project=any-slug')
    expect(res.status).toBe(401)
  })

  it('unknown connect code returns 404', async () => {
    const res = await app.request('/api/sse?code=does-not-exist')
    expect(res.status).toBe(404)
  })

  it('streams a message event matching project+part filter', async () => {
    const p = await seedProject()
    const res = await app.request(`/api/sse?code=${p.code}&part=android`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    setTimeout(() => {
      bus.emit('message', {
        kind: 'message', projectId: p.id, project: p.slug, part: 'android',
        threadId: 't1', messageId: 'm1', subject: 'hello', fromPart: 'web',
      })
      // different part must NOT arrive
      bus.emit('message', {
        kind: 'message', projectId: p.id, project: p.slug, part: 'web',
        threadId: 't2', messageId: 'm2', subject: 'ignore', fromPart: 'android',
      })
    }, 50)

    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('"subject":"hello"')
    expect(text).not.toContain('ignore')
    await reader.cancel()
  })

  it('cleans up bus listener on stream close', async () => {
    const p = await seedProject()
    const res = await app.request(`/api/sse?code=${p.code}&part=p1`)
    const reader = res.body!.getReader()

    setTimeout(() => {
      bus.emit('message', {
        kind: 'message', projectId: p.id, project: p.slug, part: 'p1',
        threadId: 't3', messageId: 'm3', subject: 'live', fromPart: 'hub',
      })
    }, 50)

    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('"subject":"live"')

    expect(bus.listenerCount('message')).toBe(1)

    await reader.cancel()
    await new Promise(r => setTimeout(r, 100))

    expect(bus.listenerCount('message')).toBe(0)
  })
})
