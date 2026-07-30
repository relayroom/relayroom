---
"@relayroom/cli": patch
---

Launch channel mode with `--channels` instead of `--dangerously-load-development-channels`, which stops on a prompt no unattended agent can answer.

Measured: the dangerous form shows a confirmation prompt on **every** launch. It is not suppressed by `--dangerously-skip-permissions`, and accepting it stores no consent anywhere, so the next launch asks again. An unattended relaunch has nobody to press Enter, so the session exists, the process is alive, the pane reads `zsh`, and the agent sits on that prompt indefinitely - which every health check reads as fine. `--channels` starts with no prompt and reports the channel active, and is what the warning itself tells you to use.

The capability probe already tested for `--channels`; the launch then used the other flag. So this was detecting one flag and launching with another.

This mattered most for `rr.sh reconnect`, added in 0.5.3, whose whole job is to relaunch a session with nobody watching - it would have reported a successful respawn while parking the agent. It also removes a prompt a human had to answer on every `rr.sh up` in channel mode.
