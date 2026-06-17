import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { renderCompose, renderEnv, type InstallConfig } from './templates'

declare const __INSTALL_VERSION__: string
const VERSION = typeof __INSTALL_VERSION__ === 'string' ? __INSTALL_VERSION__ : '0.0.0-dev'

const args = new Set(process.argv.slice(2))
const NON_INTERACTIVE = args.has('-y') || args.has('--yes')

function urlSafeSecret(bytes: number): string {
  // hex is URL-safe, so the password drops cleanly into a postgres:// URL.
  return randomBytes(bytes).toString('hex')
}
function authSecret(): string {
  return randomBytes(32).toString('base64')
}

function info(msg = '') {
  stdout.write(msg + '\n')
}

async function run() {
  info(`\n  RelayRoom installer v${VERSION}`)
  info('  Generates docker-compose.yml + .env to self-host RelayRoom from prebuilt images.\n')

  const rl = NON_INTERACTIVE ? null : createInterface({ input: stdin, output: stdout })
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def
    const a = (await rl.question(`  ${q} [${def}]: `)).trim()
    return a === '' ? def : a
  }
  const askYesNo = async (q: string, def: boolean): Promise<boolean> => {
    if (!rl) return def
    const a = (await rl.question(`  ${q} (${def ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase()
    if (a === '') return def
    return a === 'y' || a === 'yes'
  }

  try {
    const dirInput = await ask('Install directory', './relayroom')
    const dir = resolve(process.cwd(), dirInput)

    const version = await ask('Release version to pin', VERSION)
    const webUrl = await ask('Public dashboard URL (browsers)', 'http://localhost:48800')
    const serverBase = await ask('Public MCP server URL (agents)', 'http://localhost:48801')
    const webPort = await ask('Host port for the dashboard', '48800')
    const serverPort = await ask('Host port for the MCP server', '48801')

    let smtp: InstallConfig['smtp']
    if (await askYesNo('Configure SMTP for invitation emails now?', false)) {
      smtp = {
        host: await ask('SMTP host', ''),
        port: await ask('SMTP port', '587'),
        user: await ask('SMTP user', ''),
        pass: await ask('SMTP password', ''),
        from: await ask('From address', ''),
        secure: await ask('Use TLS (true/false)', 'false'),
      }
    }

    const config: InstallConfig = {
      version,
      webUrl,
      serverBase,
      webPort,
      serverPort,
      postgresPassword: urlSafeSecret(24),
      authSecret: authSecret(),
      smtp,
    }

    const envPath = join(dir, '.env')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'storage'), { recursive: true })
    writeFileSync(join(dir, 'docker-compose.yml'), renderCompose())

    // Write .env atomically with O_EXCL ('wx'): this fails rather than follow a
    // symlink or clobber an existing secrets file, closing the existsSync->write
    // TOCTOU window. On a real conflict, confirm before overwriting.
    const envBody = renderEnv(config)
    try {
      writeFileSync(envPath, envBody, { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const overwrite = await askYesNo(`\n  ${envPath} already exists. Overwrite (regenerates secrets)?`, false)
      if (!overwrite) {
        info('\n  Aborted - left your existing .env untouched.')
        rl?.close()
        process.exitCode = 1
        return
      }
      writeFileSync(envPath, envBody, { flag: 'w', mode: 0o600 })
    }
    chmodSync(envPath, 0o600) // enforce 600 even on the overwrite (existing-file) path

    info('\n  Wrote:')
    info(`    ${join(dir, 'docker-compose.yml')}`)
    info(`    ${envPath}  (chmod 600 - holds generated secrets)`)
    info(`    ${join(dir, 'storage')}/`)

    const startNow = await askYesNo('\n  Start the stack now with `docker compose up -d`?', false)
    rl?.close()

    if (startNow) {
      info('\n  Setting storage ownership (uid 1000) and starting...')
      // storage must be writable by the container's node user (uid 1000). If chown
      // fails (needs privileges), do NOT start - the web container would boot unable
      // to write uploads. Stop and hand the user the exact commands instead.
      const storageDir = join(dir, 'storage')
      const chownRes = spawnSync('chown', ['-R', '1000:1000', storageDir], { stdio: 'inherit' })
      if (chownRes.status !== 0) {
        info(`\n  Could not set ${storageDir} to uid 1000 (needs privileges). Run:`)
        info(`    sudo chown -R 1000:1000 ${storageDir}`)
        info('    docker compose up -d')
        process.exitCode = 1
        return
      }
      const up = spawnSync('docker', ['compose', 'up', '-d'], { cwd: dir, stdio: 'inherit' })
      if (up.status !== 0) {
        info('\n  `docker compose up -d` did not complete. Run it yourself from the install dir.')
        process.exitCode = up.status ?? 1
        return
      }
    }

    info('\n  Next steps:')
    if (!startNow) {
      info(`    cd ${dirInput}`)
      info('    sudo chown -R 1000:1000 storage   # container runs as uid 1000')
      info('    docker compose up -d')
    }
    info(`    Open ${webUrl} and create the first admin account.`)
    info('    Docs: https://relayroom.dev/docs\n')
  } finally {
    rl?.close()
  }
}

/**
 * Upgrade an existing install: regenerate docker-compose.yml (which carries no
 * secrets) so compose-level changes from a new version land, and pin
 * RELAYROOM_VERSION in .env to this installer's version - everything else in .env
 * (secrets, URLs, SMTP) is preserved. `docker compose pull` alone only updates
 * images, never the compose file, so this fills that gap.
 */
function upgrade() {
  const dirArg = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '.'
  const dir = resolve(process.cwd(), dirArg)
  const composePath = join(dir, 'docker-compose.yml')
  const envPath = join(dir, '.env')

  info(`\n  RelayRoom installer v${VERSION} - upgrade`)
  if (!existsSync(composePath) || !existsSync(envPath)) {
    info(`\n  No RelayRoom install found in ${dir} (expected docker-compose.yml + .env).`)
    info('  Run this from the install directory, or pass it: npx @relayroom/install upgrade <dir>')
    process.exitCode = 1
    return
  }

  // Regenerate the compose (no secrets in it) to pick up compose-level changes.
  writeFileSync(composePath, renderCompose())
  // Pin RELAYROOM_VERSION to this installer's version, preserving the rest of .env.
  const env = readFileSync(envPath, 'utf8')
  const line = `RELAYROOM_VERSION=${VERSION}`
  const updated = /^RELAYROOM_VERSION=.*$/m.test(env)
    ? env.replace(/^RELAYROOM_VERSION=.*$/m, line)
    : env.replace(/\n*$/, `\n${line}\n`)
  writeFileSync(envPath, updated)

  info('\n  Updated:')
  info(`    ${composePath}  (regenerated for v${VERSION})`)
  info(`    ${envPath}  (RELAYROOM_VERSION=${VERSION}, other values kept)`)
  info('\n  Now pull the new images and restart:')
  info(`    cd ${dirArg}`)
  info('    docker compose pull')
  info('    docker compose up -d')
  info('')
}

if (process.argv[2] === 'upgrade') {
  upgrade()
} else {
  run().catch((err) => {
    info(`\n  Installer failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
