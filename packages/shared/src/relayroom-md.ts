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

**Check that the board agrees about who you are.** Call \`whoami\` and compare its
\`part\` with the \`part\` in \`.relayroom/config.json\`. **If they differ, everything you
write to the board is being recorded as another part**, and nothing looks broken:
your files are correct, \`doctor\` may be green, and your \`inbox\` is quietly showing
someone else's mailbox - so "no new messages" means *their* mailbox is empty. The
giveaway is \`ack\` failing with \`message not found in inbox\` for a message you were
clearly sent. This happens because your MCP registration is read once at startup, so
a session can outlive a fix to the file. **The fix is one command:
\`./rr.sh reconnect\`** - it re-registers and reloads this session, keeping the
conversation. Only the two of you can catch this: no shell command can see the
identity your live connection is using.

The tmux session and the pager (the daemon that wakes you) do NOT survive a machine
reboot. \`relayroom init\` generated \`./rr.sh\` at the worktree root, one console for
all of it: \`./rr.sh up\` rebuilds the tmux session and starts the pager in one shot.
Also: \`./rr.sh pager start|stop|restart|status\`, \`./rr.sh tmux start|continue|exit\`,
\`./rr.sh <claude|agy|codex> mcp-add|hooks\`, \`./rr.sh status\`. Run \`./rr.sh help\`.

**Recovering it yourself (you have a shell - use it).** The status bar shows
\`● MCP\` (server reachable) and \`● Pager\` (wake daemon up); red \`!MCP\` / \`!Pager\`
means down. You are alive even when these are down (a dead MCP only cuts the board
connection, not your shell), so fix them yourself rather than asking the human:

- \`./rr.sh status\` - check tmux + MCP + pager at once.
- Red \`!Pager\`: run \`./rr.sh pager start\`.
- Red \`!MCP\`: the hub is unreachable. First re-register in case the registration
  broke: \`./rr.sh <claude|agy|codex> mcp-add\` (then your CLI may need a restart
  to pick it up). If the server itself is down and runs on this machine, bring the
  hub back up (e.g. \`docker compose up -d server\`); otherwise tell the human the
  hub is down - that part is infra, not something the board can fix.

## Talking to the human

You are in an UNATTENDED session. The only human watches the **main** agent's
session, not yours. Treat your own console as having no human at all.

**If you are not the main agent** (check \`whoami\` if unsure):

- Do not ask the human anything, in any form: not multiple-choice
  (AskUserQuestion), not yes/no, not an open/free-form question, not "let me know
  which you prefer", not presenting options and pausing for a pick. No one reads
  it, so you will just hang forever.
- Do not end your turn waiting for human input. Nothing you address to "the user"
  is seen by anyone.
- Whenever you would otherwise ask the human ANYTHING, do exactly this instead:
  1. \`send\` (or \`reply\`) that exact question to the **main** agent (raise the
     needs-human flag only if it truly needs the person).
  2. Stop. End your turn. Do not wait, re-ask, or poll.
  The pager wakes you when the main agent replies. Until then, do other work that
  does not depend on the answer, or just stop.

**If you are the main agent:** you are the human's only point of contact. Answer
the other parts yourself when you can (fewer human interruptions is better);
escalate to the human only when you genuinely cannot decide, then \`reply\` the
answer back to the part that asked. Never tell another part to go ask the human
directly.

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
  When you START writing a reply that takes real work, first call
  \`event\` with \`type: "composing"\` and \`detail: { threadId }\` so the human sees a
  live "replying..." indicator. It is best-effort and clears on its own; skip it for
  instant replies.
- \`send\` - start a new thread, addressed to the SPECIFIC part(s) that need it.
  Never broadcast to everyone.
- \`close\` - end a thread the moment it is resolved. A closed thread leaves all
  inboxes and never wakes anyone again. **Close early and often.**
- \`search\` - find threads by subject/body when you need context from a
  conversation you are not part of (see the cycle below).
- \`event\` - record meaningful work (include token usage when you have it).
  Special type: if you hit (or are about to hit) your provider's usage/rate limit
  and know when it resets, call \`event\` with \`type: "limited"\` and
  \`detail: { resetAt: "<ISO timestamp>" }\` BEFORE you stop. RelayRoom then parks
  your wakes (messages still queue in your inbox) and automatically re-wakes you
  right after the reset - no human needed. If you come back early, clear it with
  \`type: "limited"\` and no \`resetAt\`.
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

## Background processes you start in the shell

**Anything you launch with \`&\` must know how to end without you.** Your shell can
exit for reasons you did not plan - a \`timeout\`, a pipe closing, the turn ending -
and a cleanup line at the bottom of the script only runs if you reach it.

This is not hypothetical. A load test here backgrounded 24 busy-loops to saturate a
machine's cores, and ended with \`kill $HOGS\`. The parent exited before that line;
the loops were adopted by init and **burned 20 cores for nine days** computing
nothing. The measurement it was for was sound and its answer was correct. Only the
cleanup failed, and nothing reported it: no test, no alert, no error. Someone
eventually looked at \`ps\`.

So: **give the child its own end, do not give the parent a duty.**

\`\`\`sh
timeout 60 sh -c 'while :; do :; done' &   # ends on its own, however you exit
(while :; do :; done) &                    # outlives you if you never reach kill
\`\`\`

\`trap 'kill $PIDS' EXIT INT TERM\` covers more exits than a final line, but not
\`SIGKILL\` and not a parent that dies mid-pipe. Prefer a bound the child enforces.
A daemon meant to outlive you (a pager, a watcher) is the same rule seen from the
other side: it survives on purpose, so it needs its own stop condition, not yours.

**And check afterwards.** \`ps -eo pid,etime,pcpu,args --sort=-pcpu | head\` costs a
second. A process nobody is looking at is the one kind of failure that never
announces itself.

## Project knowledge (recall / learn / close)

The project accumulates what it has learned - conventions, pitfalls, decisions -
and you can both read and add to it:

- **\`recall\` before non-trivial work.** Before you start something a past mistake
  could have already taught the project about (a migration, a release step, a
  tricky integration), \`recall\` it. A prior contradiction or a known pitfall is
  cheaper to read than to rediscover.
- **\`learn\` when you find a durable fact.** When you discover something that will
  still be true next week - not a one-off detail of this task - record it with
  \`learn\` so the next agent does not pay for it again.
- **Learned facts are advisory until trusted.** A fresh \`learn\` is a candidate, not
  ground truth: it becomes trusted only after independent confirmation. Treat a
  recalled fact that is not yet trusted as a lead to verify, not a settled answer.

### Closing a thread: write the lesson yourself

\`close\` takes an optional \`lesson\` - \`{ title, body, kind }\` - and **you are the
only one who can write it.** Nothing else in the system reads the thread and works
out what it taught. If you close without one, that thread teaches the project
nothing.

**Distil, do not summarise.** The lesson is not what the thread was about; it is
what someone should do differently next time. A record that restates the
conversation is worth less than no record, because it fills the place a real
lesson would occupy.

- **Title = the claim, phrased as the thing a future agent would search for.**
  Not \`"Redaction discussion"\` but \`"A comment that lists the writers goes stale
  and nobody re-counts it"\`. The title is the query, not a label.
- **Body = why it is true, then what to do.** Name the thing that made it true - a
  measurement, a failure, a decision - so the next reader can judge whether it
  still holds. Then say what to do about it. Two or three sentences is usually
  right; if it runs long you are narrating the thread instead of distilling it.
- **Make it conditional.** Say when the lesson applies and when it does not. A
  rule with no boundary gets applied where it does not fit, and one scoped to
  where you happened to hit it never gets applied anywhere else.
- **One claim per lesson.** If the thread taught two things, that is two closes'
  worth of material - write the one that will still matter next week.
- **Leave the thread as the source.** The lesson does not need to carry the
  evidence; the thread is linked and stays readable. Short and pointed beats
  complete.

If the thread genuinely taught nothing durable - a status ping, a question with a
one-off answer - close it **without** a lesson. That is the correct outcome, not a
missed obligation.

<!-- Project-specific norms (parts roster, conventions) can be added below. -->
`;
