import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeConfig, RELAYROOM_DIR } from "../src/config"

/**
 * SEC-10: .relayroom/config.json holds the agent's bearer token, so it must not be
 * world-readable on a shared host. Verify writeConfig pins the dir to 0700 and the
 * file to 0600 (POSIX only; mode bits are meaningless on Windows).
 */
describe("writeConfig file permissions", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rr-config-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.skipIf(process.platform === "win32")(
    "writes config.json 0600 and .relayroom 0700",
    () => {
      const path = writeConfig(dir, { code: "abc", part: "web", token: "secret-bearer-xyz" })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, RELAYROOM_DIR)).mode & 0o777).toBe(0o700)
    },
  )

  it.skipIf(process.platform === "win32")(
    "re-tightens a config left world-readable by an older CLI",
    () => {
      const path = writeConfig(dir, { code: "abc" })
      chmodSync(path, 0o644) // simulate a pre-fix / hand-edited loose file
      chmodSync(join(dir, RELAYROOM_DIR), 0o755)
      writeConfig(dir, { part: "web", token: "t" }) // next write must re-tighten
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, RELAYROOM_DIR)).mode & 0o777).toBe(0o700)
    },
  )
})
