---
"@relayroom/web": patch
---

Let an owner find any thread when purging knowledge, not only threads that still have knowledge citing them.

The purge picker was built by expanding the source references of existing knowledge entries, so it could only ever offer threads that had knowledge left. A thread whose knowledge was already purged had nothing to expand and never appeared - which excluded exactly the thread an owner needs when purged knowledge turns out to have come back.

There is now a search beside the list that starts from threads instead, so a thread with no knowledge at all is a result rather than an absence. It searches by title because that is what the owner in this situation knows; purge does not delete threads, so the title is still there afterwards. Results are capped, and the cap is stated rather than silently truncating.

Searching is owner-gated like the purge it feeds. This changes which threads an owner can reach, not who can reach them.

Purging such a thread now also runs for real instead of stopping at the preview. A purge with nothing to delete was previously treated as a no-op, which was right while purge only removed rows; now that it also records that a thread must not be distilled again, stopping short skipped the only thing the operator came for. The confirmation and the result say what that record does, so "0 entries" no longer reads as "nothing happened".
