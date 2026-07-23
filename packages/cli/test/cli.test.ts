import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectUrl } from "../src/connect"
import { mcpAddSpec, mcpAddCommand, AGY_MCP_MERGE_SCRIPT } from "../src/providers"
import { hookCommand, hookBlock, installHook } from "../src/hooks"

describe("connect", () => {
  it("builds the MCP URL from server/code/part", () => {
    expect(connectUrl({ code: "abc123", part: "backend", server: "http://localhost:48801" }))
      .toBe("http://localhost:48801/mcp/abc123?part=backend")
  })

  it("strips a trailing slash from the server", () => {
    expect(connectUrl({ code: "abc", part: "web", server: "https://hub.example.com/" }))
      .toBe("https://hub.example.com/mcp/abc?part=web")
  })
})

describe("mcpAddSpec", () => {
  const url = "http://h:1/mcp/abc?part=web"

  it("uses `mcp add --scope project --transport http` for Claude", () => {
    // Project scope => the server lands in the worktree's .mcp.json, so each git
    // worktree gets its own part identity (Claude's default `local` scope is keyed
    // to the repo root and shared across worktrees).
    expect(mcpAddSpec("claude", "rr", url))
      .toEqual({ bin: "claude", args: ["mcp", "add", "--scope", "project", "--transport", "http", "rr", url] })
  })

  it("merges into ~/.gemini/config/mcp_config.json via node for agy", () => {
    // agy (Antigravity) has no `mcp add` command; we merge the server into its JSON
    // config file. The bearer token is read from $RELAYROOM_TOKEN, not argv.
    expect(mcpAddSpec("agy", "rr", url))
      .toEqual({ bin: "node", args: ["-e", AGY_MCP_MERGE_SCRIPT, url, "rr"] })
  })

  it("uses `mcp add <name> --url` for Codex", () => {
    expect(mcpAddSpec("codex", "rr", url))
      .toEqual({ bin: "codex", args: ["mcp", "add", "rr", "--url", url] })
  })

  it("renders a quoted one-line command", () => {
    expect(mcpAddCommand("codex", "relayroom", url))
      .toBe(`codex mcp add relayroom --url "${url}"`)
  })
})

describe("hookCommand", () => {
  it("embeds agent/server, keeps identity out of the file, and never blocks the agent", () => {
    const cmd = hookCommand({ agent: "claude", code: "c1", part: "backend", server: "http://localhost:48801" })
    expect(cmd).toContain("usage-report.mjs")
    expect(cmd).toContain("--agent claude")
    expect(cmd).toContain(`--server "http://localhost:48801"`)
    // The connect code is a capability key and this command is written into a
    // settings file teams commit; the reporter reads identity from the worktree.
    expect(cmd).not.toContain("c1")
    expect(cmd).not.toContain("--part")
    expect(cmd.endsWith("|| true")).toBe(true)
  })
})

describe("hookBlock", () => {
  it("uses the Stop event for Claude/Codex and AfterAgent for agy", () => {
    expect(Object.keys(hookBlock({ agent: "claude", code: "c", part: "p" }).hooks)).toEqual(["Stop"])
    expect(Object.keys(hookBlock({ agent: "codex", code: "c", part: "p" }).hooks)).toEqual(["Stop"])
    expect(Object.keys(hookBlock({ agent: "agy", code: "c", part: "p" }).hooks)).toEqual(["AfterAgent"])
  })
})

describe("installHook", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-cli-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("creates a Claude settings file with the Stop hook", () => {
    const path = join(dir, ".claude/settings.json")
    installHook({ agent: "claude", code: "c1", part: "web", settings: path })
    const json = JSON.parse(readFileSync(path, "utf8"))
    expect(json.hooks.Stop).toHaveLength(1)
    expect(json.hooks.Stop[0].hooks[0].command).toContain("usage-report.mjs")
  })

  it("writes the AfterAgent event for agy", () => {
    const path = join(dir, ".gemini/settings.json")
    installHook({ agent: "agy", code: "c1", part: "web", settings: path })
    const json = JSON.parse(readFileSync(path, "utf8"))
    expect(json.hooks.AfterAgent).toHaveLength(1)
    expect(json.hooks.AfterAgent[0].hooks[0].command).toContain("--agent agy")
  })

  it("is idempotent - re-install replaces, not duplicates", () => {
    const path = join(dir, "settings.json")
    installHook({ agent: "claude", code: "c1", part: "web", settings: path })
    installHook({ agent: "claude", code: "c1", part: "web", settings: path })
    const json = JSON.parse(readFileSync(path, "utf8"))
    expect(json.hooks.Stop).toHaveLength(1)
  })

  it("preserves unrelated existing hooks and settings", () => {
    const path = join(dir, "settings.json")
    writeFileSync(
      path,
      JSON.stringify({
        model: "claude-opus-4-8",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
      }),
    )
    installHook({ agent: "claude", code: "c1", part: "web", settings: path })
    const json = JSON.parse(readFileSync(path, "utf8"))
    expect(json.model).toBe("claude-opus-4-8")
    expect(json.hooks.Stop).toHaveLength(2)
    expect(JSON.stringify(json)).toContain("echo keep")
  })
})
