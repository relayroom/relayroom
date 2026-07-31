---
"@relayroom/shared": minor
"@relayroom/db": minor
---

The redaction denylist runs. Until now it was configured nowhere and applied to nothing, which 0.5.3 disclosed rather than fixed - this is the fix.

Rules are stored as structured values the server resolves, not as raw patterns: an exact literal is escaped server-side, and a built-in detector is named by id and version so the catalogue stays the server's to define. A rule the resolver cannot make sense of does not fall back to storing the text unredacted - every writer refuses instead, because a rule that cannot be evaluated cannot be honoured, and a project believing it configured protection is worse served by a quiet write than by a loud refusal.

Every path that stores knowledge now applies them. There are six, and the number is worth stating because the comment that used to describe this named two and the hole it warned about was the one it created: the extractor sweep, `learn`, `close` carrying a lesson, proposal creation, proposal approval, and the playbook branch of approval, which copied proposal text into the file every agent in the project reads. Each of them also compares the rules it read against the rules in force at the moment it writes, and refuses if an owner changed them in between, so text can no longer be stored under a rule that was replaced while the write was in flight.

Owners on a project still holding the old `redactionPatterns` key are told to re-save from the settings screen, and that save now clears the key it tells you it replaces. It clears only that key, so settings written since - `distillOnClose`, in this release - survive it.
