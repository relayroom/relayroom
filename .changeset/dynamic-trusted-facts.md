---
"@relayroom/server": patch
"@relayroom/cli": patch
"@relayroom/shared": patch
---

Serve a project's most-trusted facts in the playbook, and let a worktree tell whether it is on the current norms.

The served playbook can carry a short generated block of top trusted facts, kept visually separate from the human-authored body and marked as generated. It stays hidden until a project has accumulated a few trusted entries, so a new project sees no clutter, and it is identical across worktrees.

The playbook now also has a content hash, reported by `rr.sh update` and exposed as a response header. The hash deliberately covers the authored body and the facts block but not the "current main agent" line: that line is operational state, and a handoff is not a change in norms.

The default playbook and the provider instruction files gain a short note on when to `recall`, when to `learn`, and that a recalled fact which is not yet trusted is a lead to verify rather than an answer.
