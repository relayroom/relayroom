---
"@relayroom/web": patch
---

Report a purge by what it removed, and say plainly when an entry could not be removed.

The confirmation and the result used to read "N deleted, M detached", where detached meant an entry citing this thread and others kept its text and lost the reference. Purge no longer does that - an entry it cannot fully remove is now refused instead, because stripping the reference left text derived from the purged thread in place while reporting success, which is what the operator is purging to avoid.

So the second number is gone rather than renamed. Showing a count for an outcome that can no longer happen tells the reader it can. When entries are refused, the copy says how many and why: they were derived from other threads too, and this thread's contribution cannot be separated out.

Everything removable is still removed. Nothing about this is reachable today, since nothing produces an entry citing two threads.
