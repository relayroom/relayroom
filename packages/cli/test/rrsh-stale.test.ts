import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * `rr.sh` is generated into a worktree and never updates itself, so a machine can carry a
 * current CLI and a script from three releases back. The symptom is not an error: a flag
 * the old script does not know is silently ignored, and `up --use-herdr` on a 0.7.0
 * script started tmux and said nothing.
 *
 * There WAS an update path and it could not cover this. It fires on `.relayroom/.update`,
 * written by the PAGER from the hub's heartbeat reply - so a worktree whose pager is dead
 * never gets the marker, and a dead pager is exactly the state after a reboot, a herdr
 * restart, or a month away. That path answers "is there a newer CLI on npm". This one
 * answers "is the installed CLI newer than this script", which needs neither hub nor pager.
 */
describe("rr.sh notices it is older than the CLI that is installed", () => {
  let dir: string
  let bin: string
  let hub: Server
  let hubUrl: string
  let env: NodeJS.ProcessEnv

  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const outFile = join(bin, "run.out")
      writeFileSync(outFile, "")
      execFile(
        "bash",
        ["-c", `"${join(dir, "rr.sh")}" ${args.map((a) => `'${a}'`).join(" ")} > "${outFile}" 2>&1`],
        { cwd: dir, env: { ...env, ...extra }, timeout: SUBPROCESS_TIMEOUT_MS },
        (err) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0
          let out = ""
          try { out = readFileSync(outFile, "utf8") } catch { /* nothing written */ }
          resolve({ code, out })
        },
      )
    })

  const initCalls = () => {
    try { return readFileSync(join(bin, "init.log"), "utf8").trim().split("\n").filter(Boolean) } catch { return [] }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-stale-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-stalebin-"))
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((r) => {
      hub.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    await init({ dir, code: "c1", part: "stalepart", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-stale" })

    // A stub CLI whose --version is whatever the test says, and whose `init` records that
    // it was asked to regenerate WITHOUT actually rewriting the script - so a re-exec loop
    // shows up as repeated entries instead of being hidden by a fresh stamp.
    writeFileSync(join(bin, "relayroom"), `#!/usr/bin/env bash
case "\${1:-}" in
  --version|-v) echo "\${FAKE_CLI_VERSION:-0.0.0}"; exit 0 ;;
  init) echo "init" >> "${join(bin, "init.log")}"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
    chmodSync(join(bin, "relayroom"), 0o755)
    // The agent launch must not hang the test; anything that is not the agent exits.
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
case "\${1:-}" in
  --channels) echo "error: unknown option" >&2; exit 1 ;;
esac
exit 0
`, { mode: 0o755 })
    chmodSync(join(bin, "claude"), 0o755)
    writeFileSync(join(bin, "tmux"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 })
    chmodSync(join(bin, "tmux"), 0o755)
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
    delete env.TMUX
  })

  afterEach(async () => {
    await new Promise<void>((r) => hub.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  const stamp = () => /^RR_GENERATED="([^"]*)"/m.exec(readFileSync(join(dir, "rr.sh"), "utf8"))?.[1]

  it("stamps the generating version into the script", () => {
    expect(stamp()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("regenerates when the installed CLI is newer", async () => {
    const res = await run(["launch"], { FAKE_CLI_VERSION: "9.9.9" })
    expect(res.out).toMatch(/rr\.sh was written by relayroom .* CLI is 9\.9\.9 - regenerating/)
    // Exactly once. The re-exec guard is the only thing between this and a loop, and the
    // stub deliberately does NOT rewrite the script, so a missing guard would show up
    // here as a second init rather than as a passing test.
    expect(initCalls().length).toBe(1)
  })

  it("does nothing when the versions match", async () => {
    const res = await run(["launch"], { FAKE_CLI_VERSION: stamp() })
    expect(res.out).not.toMatch(/- regenerating$/m)
    expect(initCalls().length).toBe(0)
  })

  it("treats a script with no stamp as stale", async () => {
    // Every script written before this check has no stamp, and they are precisely the
    // ones that need it. "Unknown, carry on" would leave them all behind.
    const path = join(dir, "rr.sh")
    writeFileSync(path, readFileSync(path, "utf8").replace(/^RR_GENERATED=.*$/m, ""))
    const res = await run(["launch"], { FAKE_CLI_VERSION: stamp() ?? "0.8.2" })
    expect(res.out).toMatch(/written by relayroom an older release/)
    expect(initCalls().length).toBe(1)
  })

  it("warns instead of downgrading when the installed CLI is older", async () => {
    const path = join(dir, "rr.sh")
    writeFileSync(path, readFileSync(path, "utf8").replace(/^RR_GENERATED=.*$/m, 'RR_GENERATED="9.9.9"'))
    const res = await run(["launch"], { FAKE_CLI_VERSION: "0.1.0" })
    expect(res.out).toMatch(/written by relayroom 9\.9\.9 but the installed CLI is 0\.1\.0/)
    // Anchored on the ACTION line, not the word: the warning itself says "regenerating
    // would downgrade it", so a bare /regenerating/ matches the very message that proves
    // it did not regenerate.
    expect(res.out).not.toMatch(/- regenerating$/m)
    // A person may be pinned to an older CLI on purpose; rewriting their script from it
    // would be a downgrade nobody asked for.
    expect(initCalls().length).toBe(0)
  })

  it("does not regenerate under a command that only reports", async () => {
    // `status` and `statusline` run constantly - the status bar polls - and a re-exec
    // underneath them would be a surprise with no benefit.
    await run(["status"], { FAKE_CLI_VERSION: "9.9.9" })
    expect(initCalls().length).toBe(0)
  })

  it("says nothing when the CLI cannot answer at all", async () => {
    // No version is not evidence of staleness. Regenerating on a guess would rewrite a
    // worktree because a binary was briefly missing.
    writeFileSync(join(bin, "relayroom"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 })
    chmodSync(join(bin, "relayroom"), 0o755)
    const res = await run(["launch"], {})
    expect(res.out).not.toMatch(/- regenerating$/m)
  })
})
