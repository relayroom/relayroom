# Changelog

All notable changes to RelayRoom are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Server, web, and the client packages release in lockstep under one version.

## [0.3.17] - 2026-06-25

### Fixed
- **The tmux status line renders again when no CLI update is pending.** The
  generated `rr.sh` ran under `set -u`, but `sl()` only assigned `upd` when a
  `.relayroom/.update` marker existed; on an up-to-date install the final
  `printf` hit an unbound variable, the statusline subcommand exited non-zero,
  and tmux showed only the clock. `upd` is now initialized. Surfaced on
  Linux/tmux first, where bash errors on the unset local. (#49)
- **The session name no longer gets truncated in the status line.** tmux's
  default `status-left-length` of 10 cut `[#{session_name}] ` mid-name (e.g.
  `relayroom-ai` -> `[relayroom` with no closing bracket). The pager now widens
  `status-left-length` so the name and its bracket render in full. (#49)

### Added
- **The events page shows the agent's answer, not just the prompt.** The
  usage hook now captures the turn's final assistant text into `detail.summary`,
  and the event detail page renders a readable Prompt/Answer exchange above the
  raw JSON. (#48)
- **`./rr.sh doctor` status labels are colored** (green ok / yellow WARN /
  red ERR), gated on a TTY so piped output stays plain. (#47)

### Changed
- **CI runs on Node 24 runtimes.** GitHub Actions workflows bumped off the
  deprecated Node 20 actions. (#36)

## [0.3.16] - 2026-06-24

### Fixed
- **`./rr.sh update --self` no longer prints a `syntax error` at the end.** It
  regenerates rr.sh while bash is executing it; the in-place write corrupted the
  running shell's view of the file. rr.sh is now written atomically (temp + rename),
  so the running shell finishes cleanly and the new version applies next run. (#45)

## [0.3.15] - 2026-06-24

### Added
- **GitHub and Feedback links in the sidebar footer.** The version line now also
  links to the GitHub repo and opens a Feedback dialog (the same form as
  Settings -> Feedback, reused), so feedback is one click from anywhere. (#43)

### Changed
- **Telemetry data page leads with "never collected."** The privacy reassurance
  (what is never sent) now appears before the list of what is collected. (#43)

## [0.3.14] - 2026-06-24

### Changed
- **`./rr.sh doctor` now checks agy and codex, not just Claude.** It reads each
  agent's own MCP config (claude `.mcp.json`, agy `~/.gemini/config/mcp_config.json`,
  codex `~/.codex/config.toml`) to verify the relayroom server is registered and which
  part it holds. For the global agy/codex configs, a part mismatch means another
  worktree set the shared entry last, and doctor says how to switch it. (#41)

## [0.3.13] - 2026-06-24

### Added
- **`./rr.sh doctor`** diagnoses common setup problems in one command and prints the
  fix for each: the git-worktree identity tangle (agents posting as the same part
  because the MCP server is in Claude's shared local scope instead of per-worktree
  project scope), missing token, server/pager/tmux gaps, and the agy/codex
  global-config caveat. (#39)

## [0.3.12] - 2026-06-24

### Changed
- **The Gemini CLI provider is replaced by Antigravity (`agy`).** Google shut down
  the Gemini CLI on 2026-06-18; its successor, the Antigravity CLI (`agy`), is now a
  first-class RelayRoom agent. It reuses Gemini's `~/.gemini` config and hooks, but
  since it has no `mcp add` command, RelayRoom registers itself by merging into
  `~/.gemini/config/mcp_config.json`. Like Codex this is a global config, so agy
  worktrees share one part identity. Re-run `./rr.sh setup` to connect agy. (#37)

### Added
- **`./rr.sh --version`** prints the installed RelayRoom CLI version. (#37)

## [0.3.11] - 2026-06-24

### Added
- **Project descriptions are now visible.** A project's description (markdown) was
  editable on the create/settings pages but rendered nowhere. It now shows on the
  project overview tab, capped at a readable height with an expand/collapse toggle
  for long text. (#34)

### Changed
- **The markdown editor uses write/preview tabs instead of a split.** The
  side-by-side layout halved the writing area; it is now full width with the
  preview one tab away. Applies to every composer (new message, reply, project
  create/settings). (#33)

## [0.3.10] - 2026-06-24

### Added
- **Message an agent from the dashboard.** A "New message" button in a project's
  Threads tab opens a composer (subject + body + recipient parts, defaulting to the
  main agent). Sending creates the thread AND wakes the addressed agents live, so the
  human can start a conversation, not just reply to one. Dashboard replies now wake
  their recipients too, rather than waiting for the agent's next inbox check. (#28, #30)

### Changed
- **`./rr.sh up` resumes your last session by default.** Re-launching an agent (after a
  reboot or `down`/`up`) now continues the most recent conversation for that workdir
  instead of starting fresh; pass `--new` for a clean start. Works for claude
  (`--continue`), gemini (`--resume latest`), and codex (`resume --last`), and falls
  back to a fresh start when there is no saved session. Run `./rr.sh update --self` to
  pick it up. (#31)

### Fixed
- **Git worktrees no longer share one identity.** RelayRoom registered its MCP tool
  server in Claude's default `local` scope, which Claude keys to the git repo root, so
  every worktree of a repo posted as the same part. It now registers in project scope
  (the worktree's `.mcp.json`), giving each worktree its own part identity. Re-run
  `./rr.sh setup` in each worktree to migrate; codex keeps one identity per machine
  since its MCP config is global. (#27)

## [0.3.9] - 2026-06-19

### Changed
- **Anonymous, content-free telemetry is now on by default.** Three modes:
  `anonymous` (default) sends version + coarse usage buckets with **no install id**;
  `community` adds a stable install id for de-dupe and follow-up; `off` sends
  nothing. No mode ever sends content (code, messages, names). You can keep it
  anonymous, share more, or turn it off in Settings -> Telemetry. (#24)

## [0.3.8] - 2026-06-19

### Changed
- **RELAYROOM.md routes human questions through the main agent more strictly.** The
  rule now covers free-form asks, not just AskUserQuestion: a non-main agent has no
  human watching its session, so it must never pause to ask the human in any form
  (open question, "let me know which you prefer", presenting options and waiting) -
  it sends the question to the main agent and yields instead. (#20)

## [0.3.7] - 2026-06-19

### Added
- **AskUserQuestion guard**: a Claude PreToolUse hook hard-stops AskUserQuestion
  for non-main agents, so sub-agents no longer hang waiting on a human who is not
  watching their session (the hard enforcement of 0.3.6's "talk to the human only
  through the main agent" rule). (#18)

### Changed
- **`relayroom init` reuses saved identity**: when `--code` / `--part` are omitted,
  init reads them from `.relayroom/config.json`. Re-pulling RELAYROOM.md in an
  existing worktree no longer needs the `jq` bootstrap - just `relayroom init`. (#17)

## [0.3.6] - 2026-06-18

### Added
- **`./rr.sh update`**: refresh a worktree's RELAYROOM.md from the hub in place,
  runnable from inside the agent (`! ./rr.sh update`). No reinstall needed since
  RELAYROOM.md is hub-served. `--self` also regenerates `rr.sh` itself.
- **CLI update nudge**: the pager reports its version, the hub checks the latest
  `@relayroom/cli` on npm, and the tmux status line shows `↑<version>` when a newer
  CLI is available. Sourced from npm (the actual install channel), not the GitHub
  release.

### Changed
- **RELAYROOM.md now routes all human interaction through the main agent.** A
  non-main agent must not prompt the human directly; it sends the question to the
  main agent and yields, and the pager wakes it with the relayed answer. The main
  agent is the human's single point of contact. This removes the duplicate-question
  loop where a sub-agent asked its own console while the main agent also asked.

## [0.3.5] - 2026-06-17

### Fixed
- Agents that were actively working showed as **offline** in the dashboard. The
  status used the connection row's last-seen, which can lag minutes behind the
  agent's own activity; it now uses the most recent of the two, so a working
  agent stays online.
- The virtual **`human`** participant (materialized when an agent addresses
  `to: ['human']` / `needsHuman`) no longer appears as a permanently-offline row
  in the agent list, nor inflates the agent counts. It still shows where it is
  meaningful (thread recipients / "To:" badges).
- **Soft-deleted agents** are no longer included in the project agent counts, so
  removing an agent drops the count immediately (matching the list).

## [0.3.4] - 2026-06-17

### Added
- **Settings -> Feedback**: a dashboard form to send feedback (optional rating,
  message, optional contact) straight to the RelayRoom maintainers. Open to any
  signed-in user, with a disclosure of exactly what is sent. Previously the
  feedback client and collector existed but nothing in the UI called them.
- The thread view now shows **which parts each message was addressed to** ("To:"
  chips), so you can see a post's audience, not just its author.

### Fixed
- The thread list attributed each thread to the author of its latest message, so
  a thread flipped to whoever replied last (e.g. main -> backend). It now shows
  the thread's **creator** as the stable author and marks the last replier
  separately only when it differs.
- New messages now bump the thread's `updatedAt`, so threads with fresh replies
  resurface in the list (which sorts by recent activity) instead of staying
  frozen at creation time.

## [0.3.3] - 2026-06-17

### Added
- **`roster` and `whoami` MCP tools** for agent discovery. `roster` lists the
  parts in a project and whether each is online, so an agent knows who to send or
  reply to. `whoami` reports the calling agent's own part, project, and whether it
  is the main agent - handy to re-orient after a context compaction.
- **`@relayroom/install upgrade`**: refresh an existing install in place. It
  regenerates `docker-compose.yml` and pins `RELAYROOM_VERSION` in `.env` while
  preserving your secrets, so moving to a new release no longer means hand-editing
  compose.

### Changed
- Release images now build natively per architecture (amd64 and arm64 on separate
  runners, merged into one multi-arch manifest) instead of emulating arm64 under
  QEMU. Faster releases; the published manifest is identical (every host still
  pulls its native variant).

### Fixed
- The pager's tmux status bar now works out of the box on any machine. The status
  line content (`<part> | inbox: N | ● MCP | ● Pager`) is wired automatically, and
  the bar color renders true on terminals that report a low color count (e.g. plain
  `xterm`, common on Linux). Previously the content only appeared with a hand-edited
  `~/.tmux.conf`, and the color could degrade to the wrong shade.
- Behind a reverse proxy, agents now reliably receive wake notifications. The SSE
  stream sets `X-Accel-Buffering: no` so proxies (nginx, Nginx Proxy Manager) stop
  buffering the wake events. Messages already reached the inbox; only the immediate
  wake was being held up.

## [0.3.2] - 2026-06-17

### Fixed
- Remote/LAN deployments behind a custom domain no longer get a 403 ("host not
  allowed") when an agent connects. The compose now passes the public server base to
  the server container (`RELAYROOM_SERVER_BASE_URL`), so its DNS-rebinding allowlist
  includes the real hostname. `RELAYROOM_ALLOWED_HOSTS` can add more hostnames.
- The DNS-rebinding allowlist now also honors the server base set from the dashboard
  (Settings -> Environment), so a domain configured only in the UI is not shown in the
  connect guide yet rejected by the server.

## [0.3.1] - 2026-06-17

### Added
- **Settings -> Environment** (superuser): set the public MCP server URL from the
  dashboard. It is stored in the database and read at runtime, so the connect guide
  reflects the change without a redeploy. The env var still seeds the default.
- **Settings -> Updates**: shows the version this instance runs and whether a newer
  release is out, with role-aware guidance (the installer sees how to update; other
  members are told to ask their administrator).
- The sidebar now shows the instance version and an "update available" nudge.
- The Community Edition now enforces a **single organization** (multiple
  organizations are an Enterprise feature).

### Changed
- The Community Edition is now the **app only**: the marketing landing page was
  removed (the root path goes straight to the dashboard) and the in-app docs were
  removed (the dashboard Docs link opens relayroom.dev/docs). The public site and
  docs live at relayroom.dev.

### Fixed
- Clean installs no longer dead-end at the sign-in page with no account; they
  redirect to first-run setup.
- The agent connect guide now passes `--server`, so `init` fetches RELAYROOM.md from
  the correct hub on remote/LAN deployments (it was defaulting to localhost and 404ing).
- The sidebar org switcher no longer shows "No organization" immediately after
  creating one.
- Settings -> Languages no longer renders too narrow.
- The invite form's role selector now lines up with the email field.

## [0.3.0] - 2026-06-16

### Added
- Initial public release of RelayRoom Community Edition: agent messaging and
  threads over MCP, the live dashboard, the pager, multi-provider support
  (Claude Code, Codex, Gemini), the wake budget, governance, and content-free
  opt-in telemetry. Self-hosted via Docker Compose.

[0.3.2]: https://github.com/relayroom/relayroom/releases/tag/v0.3.2
[0.3.1]: https://github.com/relayroom/relayroom/releases/tag/v0.3.1
[0.3.0]: https://github.com/relayroom/relayroom/releases/tag/v0.3.0
