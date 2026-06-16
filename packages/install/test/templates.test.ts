import { describe, expect, it } from 'vitest'
import { renderCompose, renderEnv, type InstallConfig } from '../src/templates'

const base: InstallConfig = {
  version: '0.3.0',
  webUrl: 'https://hub.example.com',
  serverBase: 'https://hub.example.com',
  webPort: '48800',
  serverPort: '48801',
  postgresPassword: 'deadbeef0123',
  authSecret: 'c2VjcmV0+/=',
}

describe('renderCompose', () => {
  it('pins the GHCR images and carries no secrets', () => {
    const c = renderCompose()
    expect(c).toContain('ghcr.io/relayroom/relayroom-server:${RELAYROOM_VERSION:-latest}')
    expect(c).toContain('ghcr.io/relayroom/relayroom-web:${RELAYROOM_VERSION:-latest}')
    // Secrets live in .env, never in the compose file.
    expect(c).not.toContain('deadbeef')
    expect(c).toContain('pgdata:/var/lib/postgresql')
  })
})

describe('renderEnv', () => {
  it('writes the generated secrets and public addresses', () => {
    const env = renderEnv(base)
    expect(env).toContain('POSTGRES_PASSWORD=deadbeef0123')
    expect(env).toContain('RELAYROOM_PUBLIC_WEB_URL=https://hub.example.com')
    expect(env).toContain('RELAYROOM_VERSION=0.3.0')
  })

  it('quotes values with shell-unsafe characters but leaves base64 secrets bare', () => {
    const env = renderEnv({ ...base, smtp: { host: 'mail srv', port: '587', user: 'u', pass: 'p#1', from: 'a@b', secure: 'true' } })
    // base64 secret has +/= which are allowed bare
    expect(env).toContain('BETTER_AUTH_SECRET=c2VjcmV0+/=')
    // a space forces quoting
    expect(env).toContain('SMTP_HOST="mail srv"')
    // a # would otherwise start a comment -> quoted
    expect(env).toContain('SMTP_PASS="p#1"')
  })

  it('emits empty SMTP lines when not configured', () => {
    const env = renderEnv(base)
    expect(env).toContain('SMTP_HOST=\n')
  })
})
