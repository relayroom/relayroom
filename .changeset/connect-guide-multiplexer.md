---
"@relayroom/web": minor
---

The connect guide offers a tmux or herdr choice, and generates the right setup for whichever is picked.

Choosing herdr is not the tmux instructions with a flag appended. The tmux setup is two blocks because `tmux new` takes over the terminal, so nothing can follow it in one paste, and the second block ends by starting the agent in the pane the first block created. herdr creates its own workspace, so there is no session to make first and no pane the paste has to happen inside: the guide collapses to a single block that ends by asking herdr for this worktree's workspace.

Leaving the tmux block in place for herdr would have been worse than untidy. The reader would create a session nothing goes on to use, and then see the agent come up somewhere else while an empty tmux session sat behind it looking like the place to attach.

Both options carry a note on what follows from picking them, not just the unfamiliar one. That tmux is why setup takes two steps, and that herdr does not hold the terminal it was started from, are both things worth knowing before choosing rather than after.

The selector records what the reader is about to ask for. It is not the part's state and is never rendered as one - a worktree can ask for herdr and end up delivering through tmux, and what a part is actually running on is reported separately by its pager.
