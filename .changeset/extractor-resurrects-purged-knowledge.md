---
"@relayroom/db": patch
"@relayroom/server": patch
---

Fix: purged knowledge could come back.

The extractor's only record that a thread had already been distilled was the existence of a knowledge entry citing it. Purging that entry removed the record along with it, and the thread's messages were untouched - so the next time anything in the project was extracted, the entry was recreated. Retention's hard delete had the same effect. Nothing errored, and the recreated entry was indistinguishable from an original.

This mattered most for the case purge exists to handle: removing something sensitive that the redaction patterns did not catch.

A thread's extraction is now recorded separately from the entry it produced (`thread_extraction`, migration `0022`), so removing the entry no longer removes the record. Purging a thread marks it durably, whether or not it had produced an entry yet, and purge now writes an audit row - it previously left no trace of itself at all, which is why "did this happen to anyone?" had no answer.

Existing entries are backfilled by the migration. Two cohorts cannot be: a thread purged before this release, and a thread whose entry retention hard-deleted before this release, both of which already destroyed the only reference that a backfill could read.
