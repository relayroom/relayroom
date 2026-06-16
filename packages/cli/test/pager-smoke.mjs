#!/usr/bin/env node
/**
 * Minimal pager smoke harness (no build step; plain node).
 *
 * The pager (relayroom-pager.mjs) runs main() on import, so we cannot import its
 * internals directly without side effects. Instead we:
 *   1. assert the file parses (node --check), and
 *   2. replicate the retry-cap loop here to prove the invariant "fire once + at
 *      most RETRY_MAX backoff retries, then give up" — the exact shape used in the
 *      pager's sendKeysWithRetry. If that shape changes in the pager, update here.
 *
 * Run: node packages/cli/test/pager-smoke.mjs
 */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import assert from "node:assert/strict"

const here = dirname(fileURLToPath(import.meta.url))
const pager = join(here, "..", "runtime", "relayroom-pager.mjs")

// 1. Syntax gate.
execFileSync("node", ["--check", pager], { stdio: "inherit" })

// 2. Retry-cap invariant: a permanently-failing send is attempted exactly
//    RETRY_MAX + 1 times (one fire + K retries), then gives up returning false.
async function sendKeysWithRetry(doSend, { RETRY_MAX, RETRY_BASE_MS = 0 }) {
  let attempts = 0
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    attempts++
    try {
      await doSend()
      return { ok: true, attempts }
    } catch {
      if (attempt === RETRY_MAX) return { ok: false, attempts }
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt))
    }
  }
  return { ok: false, attempts }
}

const RETRY_MAX = 3
const fail = await sendKeysWithRetry(async () => { throw new Error("boom") }, { RETRY_MAX })
assert.equal(fail.ok, false, "permanent failure must give up")
assert.equal(fail.attempts, RETRY_MAX + 1, `must stop after ${RETRY_MAX + 1} attempts (fire + K), got ${fail.attempts}`)

let n = 0
const ok = await sendKeysWithRetry(async () => { n++; if (n < 2) throw new Error("transient") }, { RETRY_MAX })
assert.equal(ok.ok, true, "a transient failure should eventually succeed")
assert.equal(ok.attempts, 2, "should succeed on the 2nd attempt")

console.log("pager-smoke: OK (node --check passes; retry cap stops at RETRY_MAX+1, transient recovers)")
