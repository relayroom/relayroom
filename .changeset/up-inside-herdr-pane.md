---
"@relayroom/cli": patch
---

**`./rr.sh up` run from inside the worktree's own herdr pane now launches the agent instead of detecting itself.**

From a shell in the pane herdr had given him, a user ran `./rr.sh up --bypass --use-herdr` and got two lines that cannot both be true:

```
rr: an agent is already running in this worktree's pane - launch flags were NOT applied
rr: could not name this part's agent row in herdr (agent target w3:p1 not found)
```

The pane held nothing but `zsh`. Nothing was launched, and the command reported success at doing nothing.

The agent check asked "is there a foreground process here that is not a shell", and when `up` runs inside the pane, the process it finds is the CLI asking the question. Names cannot separate those: a node process in a herdr pane is reported as `MainThread`. Nor was "run it from another pane" a workaround, because `rr.sh` cd's to the worktree root, so the CLI's cwd is the worktree and the *caller's* pane matches the worktree-path search too.

Both checks are now made on process identity: a pane whose foreground process group is the caller's own - or that holds the caller or one of its ancestors - is not evidence of an agent, and never wins the pane search against a real one. The caller's own pane is still the right answer when its shell sits in the worktree, which is the normal way to run this.

**A launch into the pane you are typing in is reported as `deferred`, not as started.** It cannot be watched, because the shell only reads the queued command once `up` exits - so `up` says the command is queued and will start when it finishes, and leaves the sidebar naming to the pager rather than reporting a failure to name an agent that has not started yet. Measured before it was relied on: a process that types into its own pane does have its command run, right after it exits.

If you hit the old behaviour, nothing is stuck: the pane is unchanged and re-running `up` after upgrading launches normally.
