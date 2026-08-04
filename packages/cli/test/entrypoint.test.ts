// The CLI has to START. Nothing in this suite loaded the entry point before 0.6.2, so a
// duplicate `program.command("channel")` - commander throws on registration, at import,
// before any argument is parsed - shipped with 1004 tests green. Every one of them
// imported a module and checked what it returned; none of them ran the program. The
// suite was measuring something adjacent to "the thing works", which is the failure the
// 0.6.1 release notes were about.
//
// So these tests spawn the built CLI as a process. Importing `src/index.ts` would also
// catch the duplicate, but it would not catch a broken bin path, a bad shebang, an ESM
// resolution failure, or a dist that was never rebuilt - and "it runs" is the claim.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

const CLI = join(import.meta.dirname, "..", "dist", "index.js")

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT_MS,
  })
}

describe("the CLI starts", () => {
  it("has a built dist to run", () => {
    // Without this the failures below would read as "the CLI is broken" when the real
    // answer is "nobody built it", and the two want different fixes.
    expect(existsSync(CLI), `${CLI} missing - run \`pnpm --filter @relayroom/cli build\``).toBe(true)
  })

  it("registers its commands without throwing", () => {
    // `--help` reaches the end of registration and exits 0. A duplicate command name
    // throws before this point, so this is the assertion that 0.6.1 lacked.
    const out = run(["--help"])
    expect(out).toContain("Usage:")
  })

  it("lists every command exactly once", () => {
    // Commander throws on an exact duplicate, so the test above already covers that.
    // This one covers the near miss it cannot: two commands whose names differ but
    // whose PURPOSE has silently forked, which is how `channel` (run the server) and
    // `channel` (set the intent) came to collide. A name appearing twice in help means
    // registration succeeded and the ambiguity moved to the user.
    const out = run(["--help"])
    const names = out
      .split("\n")
      .map(l => /^\s{2}([a-z][a-z0-9-]*)[\s|]/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n))
    expect(names.length).toBeGreaterThan(5)
    expect(names).toEqual([...new Set(names)])
  })

  it("keeps the two channel commands separate and both present", () => {
    // The pair this regression came from, pinned by name: one runs the server, one
    // records the intent. If a later change merges them back into one name, the CLI
    // stops loading and every launcher invocation dies with it.
    const out = run(["--help"])
    expect(out).toMatch(/^\s{2}channel-server\b/m)
    expect(out).toMatch(/^\s{2}channel\b/m)
  })
})
