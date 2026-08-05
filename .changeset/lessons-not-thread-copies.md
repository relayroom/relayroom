---
"@relayroom/server": minor
"@relayroom/db": minor
"@relayroom/shared": minor
---

Project knowledge is now written by agents, not assembled from threads. The automatic extractor is removed, and **migration 0023 deletes the rows it produced**.

The extractor took a closed thread, used its subject as the title and its last agent message as the body, cut to 2000 characters, and stored that as knowledge. There was no distillation step anywhere in it. What accumulated was a copy of the conversation, and enough of it to bury anything worth reading: across the two hubs this was measured on, 1128 entries carried the thread's subject verbatim and 3 had been written by an agent. The three read as instructions - one titled *"없는 경로 404 통합테스트는 반드시 permitAll 경로로 짠다"* against a thread called *"[01] 없는 경로 404/405 - 적대리뷰 재요청(bong)"*. Those three were written with no guidance at all, from the tool schema alone.

**`close` carrying a `lesson` is now the only automatic way knowledge is created**, and the playbook finally says so. That argument shipped in 0.6.0 and the playbook never mentioned it, which is why nearly nobody passed one and everybody saw the fallback. The new section says distil rather than summarise - the title is the query a future agent would search for, the body is why it is true and then what to do - and says plainly that closing *without* a lesson is correct when a thread taught nothing durable. Guidance that only pushes toward writing produces filler, and filler occupies the place a real lesson would.

Lessons are stored as `source_kind = 'lesson'`. They previously shared `'thread'` with extractor output, which made the two indistinguishable in the data - the deletion this release performs would have taken the replacement along with the trash.

**Migration 0023 identifies rows by reconstructing them, not by a label.** For each candidate it rebuilds what the extractor would have produced from the same thread and deletes only byte-exact matches; rows whose title is not the thread's subject are relabelled as lessons; anything it cannot attribute is left alone, including rows whose thread is gone and rows whose body was redacted at extraction time and so no longer matches the message. The asymmetry is deliberate: deleting an agent's lesson cannot be undone, while leftover clutter is visible and removable. Rows that were promoted or marked trusted are never touched - a human who read one and approved it made a later and more specific judgement than this migration can. The extraction watermarks go with the deleted rows, because leaving them would mean those threads could never receive the lesson meant to replace what was removed.

Knowledge entries have somewhere to lead now: each one opens on its own page and links back to the thread it came from, so an entry can be short without that being a loss. Where a source cannot be resolved, the page says the thread is gone and that the entry is what remains of it, rather than showing nothing - a missing link and a lost source are different facts.
