---
"@relayroom/web": minor
---

A part now shows which multiplexer it is actually delivering wakes through, and says when wakes are not getting through at all.

The value is measured by the part's own pager and reported on its heartbeat. It is never the choice made in the connect dialog: a worktree can ask for herdr, find no herdr running, and fall back to tmux, and it is exactly that disagreement the badge exists to show. Sourcing it from the request would hide the only case worth displaying.

A fallback reads as degraded rather than broken, because wakes still arrive - the pager falls back deliberately instead of going quiet.

The case that genuinely is broken has no badge of its own anywhere else: a part that fell back to tmux and has no tmux session either. Its pager keeps beating, because liveness and delivery are separate paths, so the row looked completely healthy while nothing reached the agent. It is now detected from a wake the pager leased and never reported delivering.

Nothing here renders as healthy. A part with no stuck wake may simply be one nothing has been sent to, and a part whose pager predates this measurement reports nothing at all - both are shown as what they are rather than resolved into a green light.
