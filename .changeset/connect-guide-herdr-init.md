---
"@relayroom/web": patch
---

The connect guide's herdr option now emits an `init` that can actually run, and the guide no longer offers the Antigravity CLI.

Picking herdr produced an `init` with no `--multiplexer herdr`. Since 0.8.1 `init` refuses to run outside a tmux session unless told the worktree is a herdr one, and a herdr machine has no tmux session - so it refused, wrote no config, and the two commands after it in the same block failed for want of the config it did not write. The guide was correct when it was written against 0.8.0; the guard gained its exemption afterwards and nothing here changed to match.

`--multiplexer herdr` is now appended when herdr is selected. Nothing is written for tmux: absence means tmux, and the rollback path reads "nobody chose" differently from "someone chose tmux", so spending that distinction on every default install would cost more than it says.

The herdr note also now mentions that herdr recognises Claude Code but not Codex, so a Codex part runs there and simply shows no name in herdr's sidebar.

Separately, the guide offers Claude Code and Codex only. The Antigravity CLI is no longer selectable and its command-generation branch is gone with it. This is a change to the guide, not to the product: the CLI still accepts `--agent agy`, and worktrees already set up that way keep working.
