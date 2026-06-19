# Changelog

All notable changes to RelayRoom are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Server, web, and the client packages release in lockstep under one version.

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
