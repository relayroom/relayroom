/**
 * The verbs `rr.sh` needs from herdr, and the reason they live here rather than in the
 * shell script: the shell cannot speak a unix socket. Every one of these is a thin,
 * measured wrapper over the socket API, printing one line the script can read.
 *
 * The join key is the WORKTREE PATH, everywhere. herdr's ids (`w2:p4`) are positional -
 * they move when workspaces are reordered or the server restarts - so nothing stores one.
 * `.relayroom/config.json` is unchanged: identity still comes from there, and the cwd is
 * what ties it to a pane.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { processesLookLikeAgent } from "../runtime/pager-herdr.mjs"
import { herdrAgentName, herdrCall, handshake, herdrSocketPresent } from "../runtime/herdr-client.mjs"

export interface HerdrPane {
  pane_id: string
  workspace_id: string
  cwd?: string
  foreground_cwd?: string
  agent_status?: string
}

const norm = (p: string) => p.replace(/\/+$/, "")

/**
 * The pane whose cwd is this worktree, or null. Same rule the pager's delivery uses -
 * `foreground_cwd` first, because that is where keystrokes actually land.
 *
 * WITH ONE CORRECTION THAT ONLY MATTERS WHEN THE CALLER IS ITSELF IN A HERDR PANE.
 * `rr.sh` cd's to the worktree root before doing anything, so the CLI process it starts
 * has that cwd - which means the pane the USER typed into reports `foreground_cwd` =
 * the worktree, and matches, even when the real target is a different pane entirely.
 * Whichever came first in the list won, and the agent check that followed then saw the
 * CLI itself and reported an agent. So "run it from another pane" was never a workaround
 * inside herdr; only a terminal outside herdr avoided it.
 *
 * The distinction is made on process identity, not on paths: a candidate holding this
 * process (or an ancestor of it) is the caller's pane. Another pane always wins over it.
 * The caller's own pane is still the right answer when its SHELL cwd is the worktree -
 * that is a user sitting in the target pane, which is the normal way to run this.
 */
export async function findPane(worktreePath: string): Promise<HerdrPane | null> {
  const res = (await herdrCall("pane.list", {})) as { panes?: HerdrPane[] }
  const want = norm(worktreePath)
  const panes = res.panes ?? []
  const candidates = [
    ...panes.filter((p) => norm(p.foreground_cwd ?? "") === want),
    ...panes.filter((p) => norm(p.cwd ?? "") === want),
  ].filter((p, i, all) => all.findIndex((q) => q.pane_id === p.pane_id) === i)

  let callerPane: HerdrPane | null = null
  for (const pane of candidates) {
    // Only candidates are inspected, so this is one extra call in the common case and
    // none at all when nothing matches.
    if (await paneHoldsCaller(pane.pane_id)) { callerPane ??= pane; continue }
    return pane
  }
  if (callerPane && norm(callerPane.cwd ?? "") === want) return callerPane
  return null
}

/** git's own answer, not a guess from the path shape: a linked worktree has a different
 *  common dir than its own .git. Returns null when this is not a git checkout at all. */
export function gitRepoRoot(cwd: string): { root: string; linked: boolean } | null {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim()
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
    const root = common.replace(/\/\.git\/?$/, "")
    return { root, linked: norm(root) !== norm(top) }
  } catch {
    return null
  }
}

/**
 * Make sure a herdr workspace exists for this worktree, and return its pane.
 *
 * `worktree.open` when the directory is a LINKED git worktree whose repo herdr can see:
 * measured, it produces a workspace carrying `worktree.repo_key`, which is what groups it
 * under the parent repo in the sidebar. That grouping is the free UI the plan wanted, and
 * it costs one different method call.
 *
 * Idempotent by cwd rather than by a stored id: calling this twice must not leave two
 * workspaces pointed at one worktree, and the only durable identifier is the path.
 */
export async function ensureWorkspace(
  worktreePath: string,
  label: string,
): Promise<{ pane: HerdrPane; created: boolean; grouped: boolean; why?: string }> {
  const existing = await findPane(worktreePath)
  if (existing) return { pane: existing, created: false, grouped: false, why: "already open" }

  const git = gitRepoRoot(worktreePath)
  let grouped = false
  let why: string | undefined
  if (!git?.linked) {
    why = "not a linked git worktree"
  } else {
    // MEASURED: `worktree.open` resolves the worktree through a workspace that already
    // has the repo open, not from the absolute path. Called with `path` alone it answers
    // `worktree_not_found` even for a path that plainly exists - herdr knows repos by way
    // of open workspaces, which `worktree.list`'s `source_workspace_id` says out loud.
    const host = await findPane(git.root)
    if (!host) {
      why = `the repo at ${git.root} is not open in herdr, so there is nothing to group under`
    } else {
      try {
        await herdrCall("worktree.open", { path: worktreePath, workspace_id: host.workspace_id, label, focus: false })
        grouped = true
      } catch (err) {
        // Reported, never swallowed. Grouping is a nicety and having a workspace at all is
        // not, so this degrades - but a degrade nobody can see is how a feature quietly
        // stops existing.
        why = `worktree.open failed (${(err as { code?: string }).code}): ${(err as Error).message}`
      }
    }
  }
  if (!grouped) await herdrCall("workspace.create", { cwd: worktreePath, label, focus: false })

  const pane = await findPane(worktreePath)
  if (!pane) throw new Error(`herdr accepted the workspace for ${worktreePath} but no pane reports that cwd`)
  return { pane, created: true, grouped, why }
}

/**
 * This process and every ancestor of it, so a question about a pane can exclude the asker.
 *
 * The whole chain, not just `process.pid`: `rr.sh` is a shell, the CLI is node underneath
 * it, and herdr reports the foreground process GROUP - so excluding only the leaf leaves
 * the parent looking like an agent. Linux answers from `/proc/<pid>/status`, `ps` is the
 * fallback. Either can fail, and a failure shortens the chain rather than corrupting it:
 * the worst case is the behaviour this replaces.
 */
/** A process's parent pid and process-group id, from /proc where it exists and `ps`
 *  where it does not. Zero for either means "could not tell", never a guess. */
function procParentAndGroup(pid: number): { parent: number; group: number } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    const parent = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0)
    // /proc/<pid>/stat, field 5 is the process group. The command name in field 2 can
    // contain spaces and brackets, so the split is anchored on the closing paren.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const group = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2] ?? 0)
    return { parent, group }
  } catch { /* not Linux, or the process is gone */ }
  try {
    const out = execFileSync("ps", ["-o", "ppid=,pgid=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/)
    return { parent: Number(out[0] ?? 0), group: Number(out[1] ?? 0) }
  } catch { return { parent: 0, group: 0 } }
}

/**
 * This process, its ancestors, and the process GROUPS they belong to.
 *
 * The groups are what make this work against a shell script, and that was measured the
 * hard way: `rr.sh` asks with `$CLI herdr status | sed`, so the foreground group holds
 * the CLI *and* a `sed` that is nobody's ancestor. Excluding only the ancestor chain left
 * `sed` looking like an agent, and the bug survived its own fix - the standalone command
 * answered `agent=no` while the same command inside rr.sh's pipeline still said yes.
 *
 * A pane whose foreground process GROUP is one of ours is running our own pipeline, whole.
 */
export function selfProcessIdentity(startPid = process.pid): { pids: Set<number>; groups: Set<number> } {
  const pids = new Set<number>()
  const groups = new Set<number>()
  let pid = startPid
  // Bounded so a corrupted parent chain cannot spin. Nothing real is 64 deep between a
  // shell and a CLI.
  for (let i = 0; i < 64 && pid > 1; i++) {
    pids.add(pid)
    const { parent, group } = procParentAndGroup(pid)
    if (group > 1) groups.add(group)
    if (!Number.isFinite(parent) || parent <= 1 || pids.has(parent)) break
    pid = parent
  }
  return { pids, groups }
}

/**
 * Is the caller itself running inside this pane? True when the pane's foreground process
 * group is one of ours, or when any listed process is this one or an ancestor.
 */
export async function paneHoldsCaller(paneId: string): Promise<boolean> {
  const info = (await herdrCall("pane.process_info", { pane_id: paneId })) as {
    process_info?: { foreground_processes?: { pid?: number }[]; foreground_process_group_id?: number }
  }
  const me = selfProcessIdentity()
  if (me.groups.has(Number(info.process_info?.foreground_process_group_id))) return true
  return (info.process_info?.foreground_processes ?? []).some((p) => me.pids.has(Number(p.pid)))
}

/**
 * Is an agent running in this pane - ASKED IN A WAY THAT DOES NOT COUNT THE ASKER.
 *
 * `up` typed inside the pane it is about used to answer yes about itself and skip the
 * launch, printing "an agent is already running" over a pane holding nothing but a shell,
 * and then failing to name an agent that was never started - two contradictory lines in
 * one run. Measured: a node process in a herdr pane is reported as `MainThread`, so no
 * name-based rule can tell the asker apart from an agent. Pids can.
 */
export async function agentRunning(paneId: string): Promise<boolean> {
  const info = (await herdrCall("pane.process_info", { pane_id: paneId })) as {
    process_info?: { foreground_processes?: { name?: string; pid?: number }[]; foreground_process_group_id?: number }
  }
  const me = selfProcessIdentity()
  // The pane is running OUR pipeline: every process in that group belongs to this
  // command, agent-shaped names included (`sed`, `tee`, node reported as `MainThread`).
  if (me.groups.has(Number(info.process_info?.foreground_process_group_id))) return false
  return processesLookLikeAgent(info.process_info?.foreground_processes ?? [], me.pids)
}

/**
 * Type a command into the pane's shell and CONFIRM that something started.
 *
 * MEASURED, and it is why there is no `pane.run`-and-trust here: a herdr pane runs the
 * user's shell, a foreground process exiting leaves that shell in place, and the SHELL
 * exiting takes the whole workspace with it. So launching is "type it and watch", and the
 * watch is what distinguishes it from hope. The response to `send_keys` says nothing.
 */
export async function launchInPane(
  paneId: string,
  command: string,
  timeoutMs = 20000,
): Promise<{ started: boolean; deferred: boolean }> {
  // THE CALLER'S OWN PANE CANNOT BE WATCHED, because the thing it is waiting for cannot
  // start until it stops waiting: the shell only reads the typed command once this
  // process exits. Measured, in a scratch pane: a process that types into the pane it is
  // running in does have its command run, right after it exits. So the text is sent and
  // the confirmation is honestly skipped rather than looped until it times out and
  // reports a failure that did not happen.
  const inPlace = await paneHoldsCaller(paneId)
  await herdrCall("pane.send_text", { pane_id: paneId, text: command })
  await herdrCall("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
  if (inPlace) return { started: false, deferred: true }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (await agentRunning(paneId)) return { started: true, deferred: false }
  }
  return { started: false, deferred: false }
}

/** What `rr.sh` is allowed to assume about herdr before it changes anything. */
/**
 * Close THIS WORKTREE'S PANE - not the workspace it happens to sit in.
 *
 * This closed the workspace when it was written, and that was correct then: every
 * worktree had its own. Under the grouped layout the whole fleet shares one workspace,
 * so `up --restart` in any worktree would have closed every part at once and rebuilt
 * only the one that asked. Nobody triggered it; the code kept doing what had always been
 * right while the thing it addressed changed underneath it.
 *
 * Measured, so the single-worktree case is not a guess: closing one pane of a workspace
 * leaves the workspace and its other panes alive, and closing the LAST pane takes the
 * workspace with it - which is exactly the old behaviour where a workspace held one
 * worktree.
 */
export async function closePane(worktreePath: string): Promise<{ closed: boolean; pane?: string; workspace?: string }> {
  const pane = await findPane(worktreePath)
  if (!pane) return { closed: false }
  await herdrCall("pane.close", { pane_id: pane.pane_id })
  return { closed: true, pane: pane.pane_id, workspace: pane.workspace_id }
}

/**
 * Give this worktree's agent a NAME in herdr's agent list./**
 * Give this worktree's agent a NAME in herdr's agent list.
 *
 * The sidebar had every part reading the same thing, because everything an agent row can
 * be identified by was shared: one grouped workspace (label "relayroom"), one repo behind
 * every worktree, and a terminal title Claude Code owns and rewrites on its own schedule
 * ("Claude Code", then whatever the conversation is about). The one field that is per
 * agent and NOT owned by the program in the pane is `name`, set through `agent.rename`.
 *
 * Measured, because the parameter is not what the neighbouring methods take: it is
 * `{ target, name }`. `pane_id` answers `missing field 'target'` - and the error names
 * the field it wants, unlike report_metadata's, which names one that was already there.
 *
 * HOW LONG IT LASTS, measured rather than assumed - and the first answer was wrong. The
 * agent record was assumed to belong to the claude process, so a relaunch would need a
 * fresh name. It does not: killing claude and starting it again in the same pane keeps
 * the SAME `terminal_id` and the name with it. What loses the name is the pane going
 * away, and under herdr a pane only goes away by closing the workspace - which is what
 * `--restart` does, and which comes back through `up`.
 *
 * A SERVER RESTART WIPES IT, and that half is now measured too (2026-08-19, the fleet's
 * own server, restarted deliberately): every `name` was gone and every `terminal_id` had
 * been regenerated, even though native session restore brought all six parts back on
 * their own conversations. `up` setting the name once is therefore NOT sufficient by
 * itself - something has to re-assert it after a restart, and the `[[startup]]` hook
 * fires with the world already rebuilt, which is where that belongs. Until that lands, a
 * part keeps its name only until the next server restart.
 *
 * Requires an agent to be RUNNING: a bare shell pane answers `agent_not_found`. This is
 * why the call sits after the launch confirmation and not beside the workspace creation.
 */
export { herdrAgentName }

export async function nameAgent(worktreePath: string, name: string): Promise<{ named: boolean; pane?: string; why?: string }> {
  const pane = await findPane(worktreePath)
  if (!pane) return { named: false, why: `no herdr pane has cwd ${worktreePath}` }
  try {
    await herdrCall("agent.rename", { target: pane.pane_id, name })
    return { named: true, pane: pane.pane_id }
  } catch (err) {
    // Naming is cosmetic; a part that is running with an unhelpful label is still a
    // running part, so this reports and never throws into the launch path.
    return { named: false, pane: pane.pane_id, why: (err as Error).message }
  }
}

export async function herdrStatus(worktreePath: string): Promise<{
  usable: boolean
  reason?: string
  version?: string
  pane?: HerdrPane | null
  agent?: boolean
}> {
  if (!herdrSocketPresent()) return { usable: false, reason: "no herdr socket" }
  const shake = (await handshake()) as { ok: boolean; reason?: string; version?: string }
  if (!shake.ok) return { usable: false, reason: shake.reason }
  const pane = await findPane(worktreePath)
  return {
    usable: true,
    version: shake.version,
    pane,
    agent: pane ? await agentRunning(pane.pane_id) : false,
  }
}
