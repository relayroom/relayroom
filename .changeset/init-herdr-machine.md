---
"@relayroom/cli": patch
---

**`relayroom init` no longer demands tmux from a herdr user.** Pass `--multiplexer herdr` and it records the choice and skips the tmux check; a worktree that is already on herdr is not asked again.

A new user on macOS with herdr and no tmux installed followed the setup page and could not get past step one: `init` answered "error: not inside a tmux session" and exited, offering only `--no-tmux-check` - a flag that reads as switching a safety check off. The documented order made it worse rather than better, because the `multiplexer` field is written by `up --use-herdr`, which runs *after* the command that refuses to run. There was no way to say "this worktree will use herdr" at the moment it mattered.

What happened next is the part worth reading. The user worked around the refusal, and their second command ran against a `.relayroom/config.json` left by an earlier attempt - a different part, and `codex` as the agent. `up` launched codex, `herdr name` failed against a pane herdr does not recognise as an agent, and what they saw was "claude did not run". Nothing had failed; the tool had faithfully done what an old file said.

**So `init` now refuses to re-point a worktree that is registered as a different part or agent**, printing both values and `--force` if that is genuinely what you want. An omitted flag still means "reuse what is saved" - that is how a bare `relayroom init` re-pulls RELAYROOM.md, and it keeps working.

The refusal message also names the herdr path now instead of only the escape hatch.

One limitation, recorded rather than fixed: herdr detects `claude` panes natively and not `codex`, so `herdr name` (the part's row in herdr's sidebar) applies to claude parts only. A codex part in a herdr pane works; it just shows up unnamed.
