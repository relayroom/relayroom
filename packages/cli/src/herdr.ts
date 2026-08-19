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
import { herdrAgentName, herdrCall, handshake, herdrSocketPresent } from "../runtime/herdr-client.mjs"

export interface HerdrPane {
  pane_id: string
  workspace_id: string
  cwd?: string
  foreground_cwd?: string
  agent_status?: string
}

const norm = (p: string) => p.replace(/\/+$/, "")

/** The pane whose cwd is this worktree, or null. Same rule the pager's delivery uses -
 *  `foreground_cwd` first, because that is where keystrokes actually land. */
export async function findPane(worktreePath: string): Promise<HerdrPane | null> {
  const res = (await herdrCall("pane.list", {})) as { panes?: HerdrPane[] }
  const want = norm(worktreePath)
  const panes = res.panes ?? []
  return (
    panes.find((p) => norm(p.foreground_cwd ?? "") === want) ??
    panes.find((p) => norm(p.cwd ?? "") === want) ??
    null
  )
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

/** Shell names that mean "the agent is not running here". Shared with the pager's
 *  backend, which asks the same question of the same data. */
const SHELL_NAMES = new Set(["zsh", "bash", "sh", "fish", "tcsh", "dash", "ksh"])

export async function agentRunning(paneId: string): Promise<boolean> {
  const info = (await herdrCall("pane.process_info", { pane_id: paneId })) as {
    process_info?: { foreground_processes?: { name?: string }[] }
  }
  const procs = info.process_info?.foreground_processes ?? []
  return procs.some((p) => {
    const name = String(p.name ?? "").replace(/^-/, "").split("/").pop() ?? ""
    return name !== "" && !SHELL_NAMES.has(name)
  })
}

/**
 * Type a command into the pane's shell and CONFIRM that something started.
 *
 * MEASURED, and it is why there is no `pane.run`-and-trust here: a herdr pane runs the
 * user's shell, a foreground process exiting leaves that shell in place, and the SHELL
 * exiting takes the whole workspace with it. So launching is "type it and watch", and the
 * watch is what distinguishes it from hope. The response to `send_keys` says nothing.
 */
export async function launchInPane(paneId: string, command: string, timeoutMs = 20000): Promise<boolean> {
  await herdrCall("pane.send_text", { pane_id: paneId, text: command })
  await herdrCall("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (await agentRunning(paneId)) return true
  }
  return false
}

/** What `rr.sh` is allowed to assume about herdr before it changes anything. */
/**
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
