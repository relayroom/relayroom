---
"@relayroom/cli": patch
---

**`./rr.sh up` now notices that the script itself is older than the installed CLI, and regenerates before doing anything.**

`rr.sh` is written into each worktree and never updates itself, so a machine can carry a current CLI and a script from three releases back. That drift does not announce itself: a flag the old script does not know is silently dropped, so `./rr.sh up --bypass --use-herdr` on a 0.7.0-generation script started tmux and said nothing about it. Observed on worktrees last set up on 2026-08-05, with 0.8.2 installed the whole time.

There was already an update path and it could not cover this. It fires on `.relayroom/.update`, which the **pager** writes from the hub's heartbeat reply - so a worktree whose pager is dead never gets the marker, and a dead pager is exactly the state after a reboot, a herdr restart, or a month away. It answers "is there a newer CLI on npm". The new check answers "is the installed CLI newer than this script", which needs neither the hub nor a running pager. Both stay.

`init` now stamps `RR_GENERATED` into the script, and `up` and `launch` compare it with `relayroom --version` before anything else runs:

- installed newer → `rr: rr.sh was written by relayroom 0.7.0, CLI is 0.8.3 - regenerating`, then it re-execs the fresh script once
- versions equal → nothing happens
- **no stamp → stale**, because every script written before this release has none, and those are precisely the ones that need it. This is what makes the fix reach the scripts already on disk: the next `up` after upgrading regenerates once
- installed *older* than the stamp → a warning and nothing else. Someone pinned to an older CLI has not asked for a downgrade
- the CLI cannot answer at all → nothing happens, because no version is not evidence of staleness

`status` and `statusline` are exempt: the status bar polls them constantly and a re-exec underneath a status line would be a surprise with no benefit.
