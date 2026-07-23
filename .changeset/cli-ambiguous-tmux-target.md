---
"@relayroom/cli": patch
---

Refuse a window or pane target where `rr.sh` needs a session name.

`config.target` was read two ways: `rr.sh` used it as a tmux session name, while the pager documents and uses it as a full tmux target including `session:window.pane`. tmux does not complain about the mismatch - it silently rewrites `:` and `.` to `_` when creating a session. A target of `rr-core:0.1` therefore started an agent in a session called `rr-core_0_1` while the pager kept sending keys to `rr-core:0.1`. Both sides exit 0, neither logs anything, and the agent simply never wakes.

Commands that create, attach to, or kill a session now refuse an ambiguous target and explain what would have happened, including the name tmux would have invented - without that, the symptom (nothing wakes) has no visible connection to the cause (two different session names). `doctor` reports the same thing instead of exiting, since doctor is what you run once it has already bitten.

This closes the trap rather than repairing the design. Splitting the field into a session name and a delivery target is the real fix, and it needs a config migration and a decision about what a fleet layout looks like. Window and pane targets stay unsupported, and now say so instead of half-working.
