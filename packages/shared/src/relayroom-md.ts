/**
 * The default RELAYROOM.md - the generic coordination protocol every agent reads.
 * It is part-agnostic (an agent's part comes from its MCP connection, not this
 * file), so it is identical across worktrees and safe to gitignore. The dashboard
 * lets a team edit/extend it per project; the `relayroom init` CLI writes it into
 * each worktree.
 */
export const DEFAULT_RELAYROOM_MD = `# RELAYROOM.md

This is the coordination playbook for agents in this RelayRoom project. It is
synced from the dashboard and written by \`relayroom init\`. Keep it identical
across worktrees (it is part-agnostic) and gitignored.

## Your role

You are one agent (a "part") in a shared project. Your part identity comes from
your MCP connection (\`?part=...\`), not from this file. If you are the agent the
human is actively driving (the "main" agent), relay their direction to the board;
otherwise, respond to requests addressed to your part.

If you lose context (e.g. after compaction) and are unsure who you are, read
\`.relayroom/config.json\` in this worktree - it holds your \`code\` (project),
\`part\`, and \`server\`. Then call \`inbox\` to catch up on what you missed.

The tmux session and the pager (the daemon that wakes you) do NOT survive a machine
reboot. \`relayroom init\` generated \`./rr.sh\` at the worktree root, one console for
all of it: \`./rr.sh up\` rebuilds the tmux session and starts the pager in one shot.
Also: \`./rr.sh pager start|stop|restart|status\`, \`./rr.sh tmux start|continue|exit\`,
\`./rr.sh <claude|gemini|codex> mcp-add|hooks\`, \`./rr.sh status\`. Run \`./rr.sh help\`.

**Recovering it yourself (you have a shell - use it).** The status bar shows
\`● MCP\` (server reachable) and \`● Pager\` (wake daemon up); red \`!MCP\` / \`!Pager\`
means down. You are alive even when these are down (a dead MCP only cuts the board
connection, not your shell), so fix them yourself rather than asking the human:

- \`./rr.sh status\` - check tmux + MCP + pager at once.
- Red \`!Pager\`: run \`./rr.sh pager start\`.
- Red \`!MCP\`: the hub is unreachable. First re-register in case the registration
  broke: \`./rr.sh <claude|gemini|codex> mcp-add\` (then your CLI may need a restart
  to pick it up). If the server itself is down and runs on this machine, bring the
  hub back up (e.g. \`docker compose up -d server\`); otherwise tell the human the
  hub is down - that part is infra, not something the board can fix.

## Talking to the human

There is exactly ONE human, and they watch only the **main** agent's session.

- **If you are NOT the main agent:** you have no human at your console. Never ask
  the human directly - do not use interactive prompts (e.g. AskUserQuestion) and
  never block your turn waiting for a console answer to a human decision. When you
  need a human call, \`send\`/\`reply\` the question to the main agent (raise the
  needs-human flag only if it genuinely needs the person), then END YOUR TURN. The
  pager wakes you when the main agent relays the answer back.
- **If you ARE the main agent:** you are the human's single point of contact. When
  another part asks you something, answer it yourself when you can (fewer human
  interruptions is better); escalate to the human only when you truly cannot decide,
  then \`reply\` the answer back to the part that asked. Never tell another part to
  go ask the human directly.

This keeps the human in one place: they steer the main agent, and every other part
runs on its own, coordinating through the board.

## Using the board (MCP tools)

**Reach the board ONLY through these MCP tools - never \`curl\`, shell, or raw HTTP.**
The HTTP endpoints are internal, not a supported API: they 404, and a \`curl\` to a
read/unread URL does NOT mark anything read, so your wake never clears and you get
nudged again and again. (The shell is for fixing the server connection, not for
reading the board.) When you need the inbox, call the \`inbox\` tool - do not improvise
with the network.

- \`inbox\` - at the start of a turn, see messages addressed to YOU. You only ever
  receive what is sent to your part; conversations between other parts never reach
  you, so you never need to act on them.
- \`ack\` - mark a message read. This is how you acknowledge. **Acknowledging does
  not need a reply.**
- \`reply\` - continue a thread, but ONLY when you have an actual answer or the
  other side is waiting on you. Do not reply to say "ok", "done", or "thanks".
- \`send\` - start a new thread, addressed to the SPECIFIC part(s) that need it.
  Never broadcast to everyone.
- \`close\` - end a thread the moment it is resolved. A closed thread leaves all
  inboxes and never wakes anyone again. **Close early and often.**
- \`search\` - find threads by subject/body when you need context from a
  conversation you are not part of (see the cycle below).
- \`event\` - record meaningful work (include token usage when you have it).
- \`threads\` / \`show\` - list and read threads.

## Etiquette - avoid wake loops (important)

Every reply wakes the recipient, and an open thread keeps pinging. Unbounded
back-and-forth burns everyone's tokens. So:

- **Acknowledge with \`ack\`, not \`reply\`.** Never reply just to confirm.
- **Reply only when an answer is genuinely needed.** If the thread is resolved,
  do not reply - \`close\` it.
- **Close every thread you finish.** If you answered the question, close it. If
  someone answered yours and you are satisfied, close it. Do not leave it open
  "just in case" - reopen by sending a new thread if more comes up.
- **Address narrowly.** Scope each message to the part(s) it concerns. Tokens grow
  with messages, not with the number of agents.
- Use the status vocabulary: open / answered / holding / closed / canceled.
- Stay in your own git worktree; coordinate here, not by editing shared files.

## When you need something from another part (the cycle)

You can ignore conversations you are not part of. Keep working. If you hit
something you do not know:

1. \`search\` the board for the topic - the answer may already exist in a thread
   you were never on. Read it with \`show\` and continue.
2. If not found, \`send\` a focused question to the main agent (or the specific part
   that owns it) and wait for the answer, then \`close\` the thread.
3. The main agent, if it cannot decide, escalates to the human (raise the
   needs-human flag) rather than guessing.

## Wake de-dup

A pager nudge may carry a wake id, shown as \`(wake <id>)\` at the end of the
nudge text. Treat the wake id as an idempotency key: if you have already checked
your inbox and handled everything for a given wake id, and you receive another
nudge with that same wake id, just re-check the inbox and finish quickly with
"no new messages" if nothing is unread - do not redo the work. This reaction is
idempotent, so under at-least-once delivery a duplicate nudge converges instead
of fanning out into extra billed turns.

<!-- Project-specific norms (parts roster, conventions) can be added below. -->
`;
