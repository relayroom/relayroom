import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * `up --use-herdr` / `--use-tmux` PERSIST the choice and then run it.
 *
 * The persistence is the requirement, not a convenience: the pager, reboot recovery and
 * every rr.sh verb read the same `multiplexer` field, so a flag that applied to one run
 * only would migrate a herdr part back to tmux the first time anyone typed a bare `up` -
 * silently, and onto a delivery path the worktree had deliberately left.
 *
 * These run the GENERATED script, because the thing under test is the generated script.
 * Both directions are asserted: a flag that writes the file but leaves this invocation on
 * the old branch, and one that switches the branch but does not write the file, are
 * different bugs and each would pass a test written for only the other.
 */
describe("rr.sh up --use-herdr / --use-tmux", () => {
  let dir: string
  let bin: string
  let socket: string
  let hub: Server
  let hubUrl: string
  let env: NodeJS.ProcessEnv

  /**
   * Output goes through a FILE, not a pipe. `up` starts a pager and a tmux server, and
   * both inherit the child's stdout - so a pipe stays open long after bash exits and the
   * call hangs until the test timeout kills it, which reads as "the script hung" when the
   * script finished immediately. Measured here: the first version of this harness timed
   * out at 30s on a run that had already printed its answer.
   */
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const outFile = join(bin, "run.out")
      writeFileSync(outFile, "")
      execFile(
        "bash",
        ["-c", `"${join(dir, "rr.sh")}" ${args.map((a) => `'${a}'`).join(" ")} > "${outFile}" 2>&1`],
        { cwd: dir, env, timeout: SUBPROCESS_TIMEOUT_MS, stdio: ["ignore", "ignore", "ignore"] } as never,
        (err) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0
          let out = ""
          try { out = readFileSync(outFile, "utf8") } catch { /* nothing was written */ }
          if (err && !out) out = `[no output; ${err.message}]`
          resolve({ code, out })
        },
      )
    })
  const calls = () => { try { return readFileSync(join(bin, "calls.log"), "utf8") } catch { return "" } }
  const config = () => JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8"))
  const tmuxSessions = () =>
    new Promise<string>((resolve) => {
      execFile("/usr/bin/tmux", ["-S", socket, "list-sessions", "-F", "#S"], { timeout: SUBPROCESS_TIMEOUT_MS }, (_e, out) => resolve(String(out)))
    })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-mux-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-muxbin-"))
    socket = join(bin, "tmux.sock")
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((resolve) => {
      hub.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    await init({ dir, code: "c1", part: "muxpart", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-mux-test" })

    // The real CLI is not on PATH in tests, so `relayroom` is a stub that records what it
    // was asked for AND genuinely writes the config for `multiplexer` - the assertion is
    // about the file, so that write has to be real. `herdr status` reports unusable, which
    // makes the herdr branch stop immediately instead of creating a workspace on the
    // developer's own herdr server.
    writeFileSync(join(bin, "relayroom"), `#!/usr/bin/env bash
echo "$@" >> "${join(bin, "calls.log")}"
case "$1" in
  multiplexer)
    node -e 'var fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));c.multiplexer=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2))' "${join(dir, ".relayroom", "config.json")}" "$2"
    echo "multiplexer=$2" ;;
  herdr) echo 'usable=false pane=none agent=no reason="stubbed unusable"'; exit 1 ;;
esac
exit 0
`, { mode: 0o755 })
    chmodSync(join(bin, "relayroom"), 0o755)
    // Private tmux server: the tmux branch must be observable without touching the
    // developer's sessions.
    writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash\nexec /usr/bin/tmux -S ${socket} "$@"\n`, { mode: 0o755 })
    chmodSync(join(bin, "tmux"), 0o755)
    // Anything that is NOT the agent launch must exit, or prepare_launch's `--channels`
    // probe hangs on the stub and the run produces no output at all - which reads as "the
    // script hung" when nothing had gone wrong with the script.
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
case "\${1:-}" in
  --channels) echo "error: unknown option" >&2; exit 1 ;;
  mcp|hooks|--version) exit 0 ;;
esac
sleep 120
`, { mode: 0o755 })
    chmodSync(join(bin, "claude"), 0o755)
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
    delete env.TMUX
  })

  afterEach(async () => {
    await new Promise<void>((r) => execFile("/usr/bin/tmux", ["-S", socket, "kill-server"], () => r()))
    await new Promise<void>((r) => hub.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  it("writes the intent AND runs this invocation on the new branch", async () => {
    expect(config().multiplexer).toBeUndefined()
    const res = await run(["up", "--use-herdr"])
    // Persisted: a later bare `up`, the pager, and reboot recovery all read this.
    expect(config().multiplexer).toBe("herdr")
    // And applied NOW - the stub reports herdr unusable, so the herdr branch is the only
    // thing that can produce this refusal. A flag that only wrote the file would have
    // gone on to build a tmux session instead.
    expect(res.out).toMatch(/herdr is not usable here/)
    expect(res.code).toBe(1)
    expect(await tmuxSessions()).not.toMatch(/RR-mux-test/)
  })

  it("--use-tmux is a real rollback: same invocation leaves the herdr path", async () => {
    await run(["up", "--use-herdr"])
    expect(config().multiplexer).toBe("herdr")

    const res = await run(["up", "--use-tmux"])
    expect(config().multiplexer).toBe("tmux")
    // The rollback has to take effect in THIS run, not the next one: it is typed by
    // someone whose part is not working.
    expect(res.out).not.toMatch(/herdr is not usable here/)
    expect(await tmuxSessions()).toMatch(/RR-mux-test/)
  })

  it("a bare up changes nothing about the multiplexer", async () => {
    await run(["up", "--use-herdr"])
    const before = calls().length
    const res = await run(["up"])
    // Still herdr, and still refused for the herdr reason. The silent migration this
    // design exists to prevent would show up here as a tmux session.
    expect(config().multiplexer).toBe("herdr")
    expect(res.out).toMatch(/herdr is not usable here/)
    expect(await tmuxSessions()).not.toMatch(/RR-mux-test/)
    expect(calls().slice(before)).not.toMatch(/multiplexer/)
  })

  it("refuses an option it does not know, before doing anything", async () => {
    // The rollout trap, from the other side. An rr.sh that predates a flag used to pick
    // out what it recognised and ignore the rest, so `up --use-herdr` on an old script
    // started a tmux session and said nothing - observed on a user's machine, who
    // believed they had switched multiplexer. This is the generation that stops.
    const res = await run(["up", "--use-herdr", "--typo-flag"])
    expect(res.code).toBe(2)
    expect(res.out).toMatch(/unknown option for 'up': --typo-flag/)
    // It names the likeliest cause, because "unknown option" on its own reads as a typo
    // when the usual cause is a script older than the flag.
    expect(res.out).toMatch(/update --self/)
    // And nothing happened first: the refusal has to come before the side effects, or a
    // rejected command still rewrites the config it was refused for.
    expect(config().multiplexer).toBeUndefined()
    expect(await tmuxSessions()).not.toMatch(/RR-mux-test/)
  })

  it("still accepts every flag it advertises", async () => {
    // The other direction of the same guard: a list that refuses everything would pass
    // the test above and break the tool.
    const res = await run(["up", "--bypass", "--new", "--restart", "--use-tmux", "--no-channel"])
    expect(res.out).not.toMatch(/unknown option/)
    expect(res.code).not.toBe(2)
  })

  it("herdr intent plus an unusable herdr is an error, never a tmux fallback", async () => {
    const res = await run(["up", "--use-herdr"])
    expect(res.code).toBe(1)
    // The negative control that matters: nothing quietly took over delivery.
    expect(await tmuxSessions()).not.toMatch(/RR-mux-test/)
    expect(config().multiplexer).toBe("herdr")
  })
})
