import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * Claude keys its LOCAL mcp scope to the git REPO ROOT, not to the worktree, so every
 * worktree of a repo reads ONE local entry. `claude mcp remove relayroom -s local` is
 * therefore a fleet-wide delete: the worktree that runs setup keeps working while every
 * sibling still on local scope loses the board with no message and nothing changed in
 * its own directory. These tests pin the three properties that stop that recurring -
 * the removal is conditional, a no-op is silent, and the state is reported before it
 * bites - by running the rr.sh that init actually generates against a stub `claude`.
 */

/** Run a command, resolving with its exit code and output (never rejects). */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

describe("generated rr.sh: local-scope migration is not a fleet-wide delete", () => {
  let base: string
  let repo: string
  let wt: string
  let home: string
  let bin: string
  let env: NodeJS.ProcessEnv
  let savedTmux: string | undefined
  let hub: Server
  let hubUrl: string

  const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, env })
  const calls = () => {
    try {
      return readFileSync(join(bin, "calls.log"), "utf8")
    } catch {
      return ""
    }
  }

  /**
   * A stub `claude` that records its argv and, for a project-scope add, writes the
   * .mcp.json entry the real one would. `addWrites: false` simulates the case the
   * conditional exists for: an add that reports success while writing nothing.
   */
  const stubClaude = (opts: { addWrites?: boolean } = {}) => {
    const addWrites = opts.addWrites !== false
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash
echo "$@" >> "${join(bin, "calls.log")}"
_url=""
for _a in "$@"; do case "$_a" in http://*|https://*) _url="$_a"; break ;; esac; done
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "add" ]; then
  ${addWrites ? `node -e '
    var fs=require("fs");var p=process.argv[1];var url=process.argv[2];
    var j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}
    j.mcpServers=j.mcpServers||{};j.mcpServers.relayroom={type:"http",url:url};
    fs.writeFileSync(p,JSON.stringify(j,null,2))
  ' "${"$WT"}/.mcp.json" "$_url"` : ":"}
  echo "Added MCP server relayroom"
elif [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "remove" ]; then
  echo "Removed MCP server relayroom from \${4:-} config"
fi
exit 0
`.replace(/\$WT/g, wt),
      { mode: 0o755 },
    )
    chmodSync(join(bin, "claude"), 0o755)
  }

  /** Put a relayroom server in the repo-root LOCAL scope, registered as `part`. */
  const writeLocalEntry = (part: string) => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [repo]: { mcpServers: { relayroom: { type: "http", url: `http://127.0.0.1:1/mcp/c1?part=${part}` } } },
        },
      }),
    )
  }

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "relayroom-scope-"))
    repo = join(base, "repo")
    wt = join(base, "wt")
    home = join(base, "home")
    bin = join(base, "bin")
    mkdirSync(repo)
    mkdirSync(home)
    mkdirSync(bin)
    savedTmux = process.env.TMUX
    delete process.env.TMUX
    env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }
    delete env.TMUX
    // init refuses to write a worktree it cannot fetch the playbook for.
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((resolve) => {
      hub.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    // A real repo with a real worktree: local scope keys to the repo root, and the
    // whole point is that the worktree is not that root.
    await git(repo, "init", "-q")
    await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    await git(repo, "worktree", "add", "-q", wt, "-b", "wt")
    await init({ dir: wt, code: "c1", part: "core", server: hubUrl, token: "tok", tmuxCheck: false })
    stubClaude()
  })

  afterEach(() => {
    hub.close()
    if (savedTmux !== undefined) process.env.TMUX = savedTmux
    rmSync(base, { recursive: true, force: true })
  })

  it("removes the shared local entry only when it is this part's own", async () => {
    writeLocalEntry("core")
    const { code, stdout } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).toBe(0)
    expect(calls()).toMatch(/mcp remove relayroom -s local/)
    expect(stdout).toContain("part=core")
  })

  it("leaves a local entry belonging to another part alone, and says why", async () => {
    writeLocalEntry("sibling-part")
    const { code, stdout, stderr } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).toBe(0)
    // The whole defect in one assertion: another part's registration is not ours to delete.
    expect(calls()).not.toMatch(/mcp remove relayroom -s local/)
    expect(stderr).toContain("sibling-part")
    expect(stdout).toContain("registered relayroom MCP for claude")
  })

  it("stays silent about removal when there is no local entry at all", async () => {
    const { code, stdout, stderr } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).toBe(0)
    expect(calls()).not.toMatch(/mcp remove relayroom -s local/)
    // A no-op that announces a deletion alarms the one session that lost nothing.
    expect(stdout + stderr).not.toMatch(/Removed MCP server/)
    expect(stdout + stderr).not.toMatch(/removing the repo-root LOCAL/)
  })

  it("does not touch the shared entry when its own registration did not land", async () => {
    stubClaude({ addWrites: false })
    writeLocalEntry("core")
    const { code, stderr } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).not.toBe(0)
    expect(calls()).not.toMatch(/mcp remove relayroom -s local/)
    expect(stderr).toContain("did not land")
  })

  it("names the sibling worktrees that have no registration of their own", async () => {
    const sib = join(base, "sib")
    await git(repo, "worktree", "add", "-q", sib, "-b", "sib")
    mkdirSync(join(sib, ".relayroom"), { recursive: true })
    writeFileSync(join(sib, ".relayroom", "config.json"), JSON.stringify({ code: "c1", part: "sibling-part" }))
    const { code, stderr } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).toBe(0)
    expect(stderr).toContain(sib)
    expect(stderr).toContain("./rr.sh setup")
  })

  it("says nothing about siblings that already have their own registration", async () => {
    const sib = join(base, "sib")
    await git(repo, "worktree", "add", "-q", sib, "-b", "sib")
    mkdirSync(join(sib, ".relayroom"), { recursive: true })
    writeFileSync(join(sib, ".relayroom", "config.json"), JSON.stringify({ code: "c1", part: "sibling-part" }))
    writeFileSync(join(sib, ".mcp.json"), JSON.stringify({ mcpServers: { relayroom: { url: "http://x/mcp/c1?part=sibling-part" } } }))
    const { code, stderr } = await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    expect(code).toBe(0)
    expect(stderr).not.toContain(sib)
  })

  it("doctor reports a repo-root local entry even when this worktree is healthy", async () => {
    await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    writeLocalEntry("sibling-part")
    const { stdout } = await run("bash", [join(wt, "rr.sh"), "doctor"], { cwd: wt, env })
    // Healthy on its own terms, and still one setup away from taking a sibling down.
    expect(stdout).toContain("registered (this worktree's .mcp.json, part=core)")
    expect(stdout).toContain("repo-root LOCAL scope (part=sibling-part)")
  })

  /**
   * The state that produces a part which never comes back: registered, so doctor's
   * registration check is green, and unapproved, so the next relaunch has no board and
   * no wake channel. An all-ok doctor here is the check that stops anyone looking.
   */
  it("doctor calls a registered-but-unapproved worktree an error, not a warning", async () => {
    await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    const { stdout } = await run("bash", [join(wt, "rr.sh"), "doctor"], { cwd: wt, env })
    expect(stdout).toContain("registered (this worktree's .mcp.json, part=core)")
    expect(stdout).toMatch(/ERR .*registered but NOT approved:.*relayroom/)
    expect(stdout).toContain("no board and")
  })

  it("doctor is quiet once the approval setup writes is in place", async () => {
    await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    mkdirSync(join(wt, ".claude"), { recursive: true })
    writeFileSync(
      join(wt, ".claude", "settings.json"),
      JSON.stringify({ enabledMcpjsonServers: ["relayroom", "relayroom-channel"] }),
    )
    const { stdout } = await run("bash", [join(wt, "rr.sh"), "doctor"], { cwd: wt, env })
    expect(stdout).not.toContain("NOT approved")
  })

  it("doctor accepts the blanket flag a user may have set themselves", async () => {
    await run("bash", [join(wt, "rr.sh"), "claude", "mcp-add"], { cwd: wt, env })
    mkdirSync(join(wt, ".claude"), { recursive: true })
    writeFileSync(join(wt, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }))
    const { stdout } = await run("bash", [join(wt, "rr.sh"), "doctor"], { cwd: wt, env })
    expect(stdout).not.toContain("NOT approved")
  })

  it("doctor no longer prescribes the fleet-wide delete", async () => {
    const { stdout } = await run("bash", [join(wt, "rr.sh"), "doctor"], { cwd: wt, env })
    expect(stdout).toContain("not in this worktree's .mcp.json")
    // The old advice was the destructive command itself.
    expect(stdout).not.toMatch(/claude mcp remove relayroom -s local/)
    expect(stdout).toContain("./rr.sh setup")
  })
})
