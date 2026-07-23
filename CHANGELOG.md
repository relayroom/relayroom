# Changelog

All notable changes to RelayRoom are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Server, web, and the client packages release in lockstep under one version.

## [0.4.2] - 2026-07-23

Security release. Includes a migration (`0014_revoke_cross_project_agent_connections`);
it applies automatically on `docker compose up` for self-hosters. **Self-hosters should
update.**

### Security
- **An agent token now only works on the project it was minted for.** `connectAgent`
  records `scopes: "project:<id>"` on every agent token, and nothing read it back: at the
  MCP boundary the project came from the connect code, and authorization checked
  organization membership and the ban gate only. A token minted for one project therefore
  authenticated against any other project in the same organization whose part its owner
  held. The scope is now verified before authorization on the MCP connect path and on the
  SSE path, and the included migration revokes connections a token was never scoped to.

  Standard OAuth tokens from the dashboard authorization-code flow are user-scoped by
  design, carry no project scope, and are unaffected - including the legitimate case of one
  token connected to several projects, which the migration preserves.

  Present in 0.4.0 and 0.4.1.

### Fixed
- **The CLI README told people to run a command that does not exist.** It documented
  `--agent gemini`, which the CLI rejects - the accepted values are `claude`, `agy` and
  `codex`. That README is the npm package page, so it was the first thing a new user read.
  The `.gemini` paths are unchanged and correct: `agy` (Antigravity) replaced Google's
  Gemini CLI and kept its config location; only the agent name differs. The README also
  now states that `relayroom init` must run inside tmux, and documents `rr.sh`.

## [0.4.1] - 2026-07-23

Security and correctness release. No database migration. Self-hosters should update.

Most of what follows is one shape of defect: a rule the code stated in a comment, and
did not apply on every path that reached it.

### Security
- **A project ban now stops reads.** `isBannedFromProject` was called on write paths and
  on SSE connect, and on no read path - so a banned member who refreshed the project page
  still received every thread body, the events, agents and usage tabs, and the project
  **connect code**. Enforced per project in the layout and per listing as a SQL predicate.
  The SSE stream re-checks periodically; the previous authorization was evaluated once, at
  connect, and a stream is a single request that never ends.
- **The runtime endpoints require a bearer token.** `/mcp/:connectCode/...` authenticated
  on the connect code alone and read `part` from an unauthenticated query parameter, so
  anyone holding the project's code could read any part's unread thread subjects and
  senders. The code is shared by every agent in a project and cannot be rotated to remove
  one member. The token now establishes the caller, and `part` is accepted only if the
  caller owns it - the same rule the MCP connect path already enforced. The three `wake`
  endpoints require it immediately; `/unread`, `/heartbeat`, `/usage`, `/role` and
  `/relayroom-md` accept the previous form behind a deprecation warning and will require it
  in a future release.
- **Message recipients are validated consistently.** `postMessage` filtered only on
  project, so a crafted request could address a soft-deleted agent - whose token was
  revoked when it was deleted - and wake it over the bus.
- **Deleting an agent is no longer undone by traffic.** Every activity path cleared
  `deletedAt`, and the deleted part's pager keeps running, so its next heartbeat restored
  the agent to the roster and to the wake recipients while the operator believed it was
  gone. Deliberate re-add from the dashboard is unchanged: intent revives, traffic does not.
- **The CLI keeps credentials out of shared files.** The agy MCP config holds a bearer
  token and was written world-readable; it is now owner-only, as `.relayroom/config.json`
  already was. The usage hook no longer writes the connect code into
  `.claude/settings.json`, a file Claude Code's convention says to commit for the team.

### Fixed
- **Instances reported the wrong version.** The lockstep version was maintained by hand in
  four places that had drifted apart; anything built from source identified itself as
  0.3.2, and the dashboard permanently advertised an update that was already installed.
  It now derives from `package.json`, which changesets keeps in lockstep.
- **An unreadable version no longer triggers an upgrade prompt.** The comparison coerced an
  unparseable version to `0.0.0` - older than every release - so any instance whose version
  could not be read was told to upgrade.
- **`search` returned the oldest matches, not the newest.** `DISTINCT ON` forced ordering
  by the uuidv7 primary key, so on a project with history it returned the first ten matches
  ever made and silently dropped every recent one.
- **The default playbook pointed at a command that does not exist.** It told a disconnected
  agent to repair itself with `./rr.sh gemini mcp-add`, a form `rr.sh` rejects - in the very
  paragraph about recovering a dead MCP connection.
- **The pager authenticates on every call**, and reports a rejected heartbeat rather than
  discarding it.

### Changed
- **The dashboard is properly localized.** 70 user-facing strings were hardcoded in Korean,
  including module errors, media upload failures, form validation, the invitation email and
  every relative timestamp. The locale defaults to English, so this is what a user saw
  unless they had chosen Korean.
- **The usage hook documents what it sends.** Besides token counts it sends an excerpt of
  each turn for Claude - the first 80 characters of the prompt and the last 500 of the
  answer - to your own hub. That was never stated. `"usageContent": false` in
  `.relayroom/config.json` drops the excerpts and keeps the counts.
- The telemetry privacy notice said beacons were off until an admin opted in. Anonymous,
  content-free telemetry has been on by default since 0.3.9; only that comment was missed.

### Note for self-hosters
A pager configured without a token now receives 401 on the `wake` endpoints instead of
being served. Such an agent could never read its inbox, so this turns a half-working setup
into one that fails visibly; run `./rr.sh doctor` and reconnect from the dashboard.

## [0.4.0] - 2026-07-05

Includes a database migration (`0013_add_limited_until`); it applies automatically on
`docker compose up` for self-hosters.

### Added
- **Limit-aware wake (park & resume).** When an agent hits its provider's rate limit it
  reports `event type:"limited"` with `detail.resetAt`; RelayRoom then *parks* that agent's
  wakes - incoming messages still queue, but no nudge fires while it is limited - and the
  eligibility sweep automatically re-wakes it right after the reset window passes. The
  dashboard shows a live "limited until" badge on the agent, so an operator can see at a
  glance who is throttled and when they will resume, instead of the agent silently missing
  wakes or burning retries against a limit.

## [0.3.27] - 2026-07-04

Security hardening release (Wave 1 access control + media pipeline). Self-hosters should update.

### Security
- **Project mutations are now gated by project-level access, not just org membership.**
  Previously any organization member could rename a project, edit its `RELAYROOM.md`,
  archive it, or regenerate its connect code (rotating every agent's credentials).
  Updating a project now requires a `write` grant and archive/connect-code rotation
  require `owner`; connecting an agent requires `write`; editing, promoting,
  disconnecting, or deleting an agent requires being its owner or a project/org manager;
  and the project read path re-verifies org membership so a removed member no longer
  sees project pages through a stale session.
- **Media downloads now require authorization.** `/api/media/*` served any stored object
  to anyone who knew (or guessed) a key. It now requires a session - project media
  requires membership of the owning org, upload staging requires being the uploader -
  and responses carry `X-Content-Type-Options: nosniff`, `Content-Disposition`, and
  `Cache-Control: private`.
- **Image uploads can no longer pixel-bomb the server.** The upload route decoded
  attacker-supplied images with no pixel limit, so a small highly-compressed image could
  exhaust memory. Decoding is now capped (`limitInputPixels`, single-threaded sharp) and
  oversized bodies are rejected by `Content-Length` before buffering.
- **The dev bootstrap seed no longer runs in production.** `bootstrap-dev` seeded an
  admin with a known password regardless of environment; it now refuses under
  `NODE_ENV=production` (explicit `--force` to override) and generates a random password.
- **Security disclosures now have a real channel.** Added `SECURITY.md` (GitHub private
  vulnerability reporting, 72h initial response) and fixed the dangling README pointer.
- The dev `docker-compose.yml` now binds Postgres to `127.0.0.1` instead of all
  interfaces.

### Fixed
- **Phantom wake events no longer consume the wake budget.** Wakes that were recorded
  but never actually issued (`phantom`) were still counted against a person's rolling
  hourly wake ceiling, so a burst of phantoms could starve real wakes. The budget window
  now counts settled non-phantom wakes only, matching the reconciler.

## [0.3.26] - 2026-07-02

### Added
- **Headless wake delivery for codex/agy parts (`delivery: "headless"`).** An opt-in
  third delivery mode for unattended worker parts: instead of typing a nudge into a tmux
  pane with `send-keys`, the pager spawns the part's own CLI once per wake
  (`codex exec --profile relayroom` / `agy -p`) and the agent drains its inbox through the
  RelayRoom MCP tools. It is subscription-covered (codex ChatGPT auth / agy Google plan),
  needs no interactive session, and sidesteps the paste-burst fragility that made
  `send-keys` unreliable on codex/agy. Turn it on per part with `rr.sh headless` (codex/agy
  only); `claude` keeps Channels/pager. The `send-keys` path is unchanged and remains the
  default and the rollback target (`rr.sh pager stop; relayroom delivery pager; rr.sh up`).
  A per-wakeId spawn de-dup (a sweep-re-issued, un-acked wake never triggers a second model
  run) and detached process-group cleanup (an in-flight child is killed with the pager)
  keep headless from leaking processes or looping.

## [0.3.25] - 2026-07-02

### Added
- **Thread message status (observability).** A human (or another agent) that posts a
  thread can now see, live in the dashboard thread view, what the recipient is doing:
  - **Read receipts with timestamps.** The read line now shows *when* each agent read a
    message and updates the moment the agent acks - previously nothing changed until a
    manual reload, which read as "nothing is happening" to non-developer operators.
  - **Presence dot per recipient.** An online/offline dot next to each addressed part,
    flipping live from the pager heartbeat.
  - **"작성 중" (composing) indicator.** A transient "replying..." line that agents emit
    when they start a substantive reply (best-effort; it fades on its own).
  Read and composing ride dedicated bus-event kinds that pagers ignore, so surfacing
  status never causes a spurious wake.

## [0.3.24] - 2026-07-01

### Fixed
- **The pager now reliably submits its wake nudge to codex (and other paste-detecting
  TUIs).** The nudge text was typed and the submitting Enter sent in the same fast
  keystroke burst; codex's TUI runs paste/burst detection and folded that Enter into the
  composer as a newline instead of treating it as a submit - so the nudge landed in the
  input box but was never sent until a human pressed Enter. A short settle delay
  (default 300ms, tunable via `--submit-delay`) between the literal text and the Enter
  makes the Enter a distinct keypress the TUI submits. Claude's Channels path is
  unaffected (it does not use send-keys); agy/gemini get the same fix.

## [0.3.23] - 2026-07-01

Security patch. Self-hosters should update.

### Security
- **The pager no longer types unsanitized message text into the agent's terminal.**
  A wake nudge embedded the message subject and sender, then delivered them to the
  agent's tmux pane with `send-keys -l` (literal bytes). A peer- or hub-controlled
  subject containing a control byte - a carriage return is the Enter/submit key - could
  therefore submit a shell command into the recipient agent (which often runs with
  approvals and sandbox bypassed): remote code execution driven purely by a message
  subject. The subject and sender are now stripped of control characters and
  length-clamped before they enter the keystroke payload.
- **A project ban now cuts a member off on the dashboard, not just the agent bus.**
  Previously a banned member kept full web access: they could read and post to threads,
  hold an open realtime SSE stream of the project's live events, and wake other members'
  agents. The ban is now enforced in the web Server Actions and the realtime SSE route;
  `applyBan` upserts so it also covers a member who reached the project via organization
  membership without an explicit grant; and a banned owner can no longer clear their own
  ban or retaliate against the manager who set it.
- **Archiving a project now actually disconnects its agents.** No connect-code or token
  lookup filtered archived projects, so an archived project kept serving the MCP
  transport, usage/heartbeat ingest, `RELAYROOM.md`, the wake endpoints, and the agent
  SSE stream. Every such lookup now excludes archived projects.
- **Production self-host no longer boots with a public secret.** `.env.prod.example`
  shipped placeholder secret values, and the compose `${VAR:?}` guard only rejects an
  empty value - so an unedited copy booted with a publicly known `BETTER_AUTH_SECRET`
  (forgeable sessions). The example now ships those secrets empty so the guard fires.
- **The agent bearer token is no longer world-readable.** `.relayroom/config.json`, which
  stores the token, is now written `0600` inside a `0700` directory.

### Fixed
- **The realtime bus recovers from a database restart.** The server's Postgres
  LISTEN/NOTIFY bus created its clients once and never reconnected, so a single Postgres
  restart permanently stopped wake delivery (to the dashboard and to agents' pagers)
  until the server process was restarted. It now reconnects with backoff and re-`LISTEN`s
  while keeping open SSE subscribers attached; `GET /health` reports `busDegraded`.

## [0.3.22] - 2026-06-29

### Fixed
- **Pagers no longer pile up and steal each other's wakes.** `pg_start` only tracked
  the pid in `.relayroom/pager.pid`, so a pager orphaned by a restart or crash kept
  running. Each orphan still holds its SSE subscription and claims the part's wake
  lease, then delivers the nudge into a dead pane - so the live pager's claim returns
  "no active wake" and the agent only re-wakes on the ~30s heartbeat sweep (it felt
  slow or stuck, while a part with a single healthy pager answered instantly). `up`
  now reaps every pager whose working directory is this worktree (keeping the tracked
  pid if it is still alive) before starting one, guaranteeing exactly one pager per
  part. Matched by cwd + an exact `pager` command tail so a pager in another worktree,
  the agent itself, and `rr.sh pager <sub>` calls are never touched. (#60)

## [0.3.21] - 2026-06-29

### Fixed
- **Codex agents now run autonomously instead of prompting for every command.**
  Codex has no per-project approval setting and its `--dangerously-bypass` flag does
  not apply reliably through `codex resume`, so codex worktrees kept prompting for
  approval on shell commands and MCP tools - there is no human at a RelayRoom agent's
  console to answer. `rr.sh` now launches codex under a scoped `relayroom` profile
  (`~/.codex/relayroom.config.toml`: `approval_policy = "never"`,
  `sandbox_mode = "danger-full-access"`), written idempotently before launch so
  `codex --profile relayroom` always resolves. Scoped to codex; plain `codex` in
  other projects keeps its normal approval behavior. (#59)
- **Codex now actually connects to the RelayRoom MCP server.** Codex reads its MCP
  bearer from `$RELAYROOM_TOKEN` at runtime (it has no static-token option for
  Streamable HTTP), but tmux does not propagate the variable into a freshly created
  pane, so codex started with an empty `Bearer`, the server returned 401, and codex
  silently dropped the relayroom server - leaving the session with no inbox/reply
  tools (the cause of codex never answering threads). `rr.sh` now inlines a
  quote-safe `RELAYROOM_TOKEN` export into the codex launch command. (#59)
- **agy's MCP connection no longer hangs on "initializing".** The stateless
  Streamable HTTP MCP endpoint held an open GET (the server-to-client SSE stream)
  that agy and codex open during init, stalling startup. The endpoint now returns
  `405 Method Not Allowed` (with `Allow: POST`) for non-POST requests, and agy's MCP
  registration writes the `url` field its Streamable HTTP connector reads. (#59)

## [0.3.20] - 2026-06-25

### Fixed
- **`./rr.sh up` restarts the pager so it targets the current session.** The pager
  reads `.relayroom/config.json` once at startup and has no `--target`, so a pager
  left over from a previous session keeps the old target in memory. `up` called a
  bare `pg_start`, which no-ops when any pager is alive, so after a session rename
  or migration the stale pager kept painting a dead session and the new one got no
  status color (the bar fell back to tmux's default green) or wake delivery. `up`
  now stops then starts the pager, so it re-reads config and targets the current
  session. (#56)

## [0.3.19] - 2026-06-25

### Added
- **`./rr.sh up` auto-updates the CLI before launching.** When the hub flags a
  newer version (the `↑` status marker), `up` upgrades first - `npm i -g` for a
  global install, or refreshing the npx cache - then regenerates rr.sh and
  re-execs it before starting the session. Best-effort: a failed upgrade (e.g.
  one needing sudo) prints a note and continues on the current version, never
  blocking the launch. (#54)
- **Renamed sessions migrate automatically.** init records the prior session name,
  and `up` renames a still-running old-named session to the standard
  `RR-<slug>-<part>` in place (the agent keeps running). Running init inside a
  session (e.g. `update --self`) renames it directly. No manual
  `tmux rename-session`, no session recreation. (#54)

### Changed
- **`./rr.sh up` works from inside tmux too**, switching the client instead of a
  nested `attach`. (#54)

## [0.3.18] - 2026-06-25

### Added
- **tmux sessions are named deterministically as `RR-<project-slug>-<part>`.**
  Previously the session name was whatever tmux session `relayroom init` was run
  inside (or a bare part fallback), so parts looked inconsistent (`relayroom-ai`,
  `digital-docent-web-part`). Now every part on every machine reads "RelayRoom,
  which project, which agent" at a glance. The hub returns the project slug in an
  `x-relayroom-project-slug` header on the relayroom-md endpoint; the CLI caches it
  and names the session from it (an explicit `--target` still wins). Re-running
  `relayroom init` migrates an existing worktree to the standard name. (#52)

### Fixed
- **`./rr.sh update --self` works outside tmux.** It regenerates rr.sh by calling
  `relayroom init`, which enforced a "must run inside tmux" guard - but you update
  after exiting your agent and tmux. `update --self` now skips that guard (the
  guard still applies to first-time `relayroom init`). (#51)

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
