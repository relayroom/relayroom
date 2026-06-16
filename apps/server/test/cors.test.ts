import { afterAll, describe, expect, it } from 'vitest'
import { makeTestApp } from './helpers'

// Default allowed origin = getAuthBase() = http://localhost:48800 (the dashboard).
const ALLOWED = 'http://localhost:48800'
const DISALLOWED = 'http://evil.example'

const { app, db, bus } = makeTestApp()
afterAll(async () => {
  await bus.close()
  await db.$client.end()
})

describe('CORS whitelist on /api/*', () => {
  it('echoes the allowed dashboard origin', async () => {
    const res = await app.request('/api/sse', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  })

  it('does NOT echo a disallowed origin (no wildcard)', async () => {
    const res = await app.request('/api/sse', {
      method: 'OPTIONS',
      headers: { Origin: DISALLOWED, 'Access-Control-Request-Method': 'GET' },
    })
    const acao = res.headers.get('access-control-allow-origin')
    expect(acao).not.toBe(DISALLOWED)
    expect(acao).not.toBe('*')
  })
})

describe('SSE auth scoping', () => {
  it('rejects slug-only subscription (no token, no code) with 401', async () => {
    const res = await app.request('/api/sse?project=some-slug')
    expect(res.status).toBe(401)
  })

  it('rejects with neither project nor code (401)', async () => {
    const res = await app.request('/api/sse')
    expect(res.status).toBe(401)
  })
})
