---
"@relayroom/cli": patch
---

Select channel wake delivery on whether the channel server will load, not on whether Claude Code has the flag.

`prepare_launch` probed `claude --channels` and treated "the flag exists" as "our channel server will load". Those are different questions, and when they diverged the result was the worst available shape rather than a visible failure: `delivery=channel` was written to config, the channel silently did not load (claude does not exit, error or warn - measured against an unapproved server, a nonexistent server, and no `.mcp.json` at all), and the pager returns before subscribing under `delivery=channel`. So nothing delivered wakes while the heartbeat kept painting a healthy status bar.

Channel mode now requires positive evidence that `relayroom-channel` is loadable, checked in layers that each fail toward pager: `claude mcp list` (an outcome, so it survives a future change to how approval is gated), then the approval keys `doctor` already reads, then - with no evidence either way - pager. The chosen mode now prints the reason and the layer that decided it, so a declined channel reads `wake delivery: pager (channel supported, but relayroom-channel is not approved here - run ./rr.sh setup; via observed)` rather than a bare mode name, and a silently broken first layer is visible instead of being covered for by the second.

`delivery` is rewritten on every launch that reaches `prepare_launch`, so no config repair is needed - each worktree corrects itself at its next launch from scratch. A session that is already running does not re-decide, so the fix reaches it when it is next relaunched.
