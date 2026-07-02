---
"@relayroom/cli": patch
---

Add headless wake delivery for codex/agy parts (`delivery: "headless"`). Instead of tmux send-keys, the pager spawns the part's CLI once per wake (`codex exec --profile relayroom` / `agy -p`) to process the inbox via the RelayRoom MCP tools - subscription-covered, no interactive session, no paste-burst fragility. Opt in per part with `rr.sh headless` (codex/agy only); `claude` keeps Channels/pager and the send-keys path is unchanged (the default and rollback target). Includes a per-wakeId spawn de-dup and detached process-group cleanup so a re-issued or interrupted wake never leaks or loops.
