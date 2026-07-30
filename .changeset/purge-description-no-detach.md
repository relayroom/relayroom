---
"@relayroom/web": patch
---

Correct the purge description, which still promised the behaviour 0.5.3 removed.

The panel told owners that an entry citing this thread and others would be kept with just this thread's provenance stripped. Purge stopped doing that in 0.5.3 - such an entry is now reported rather than partly cleared, because its text cannot be separated by source, so removing this thread's share would mean deleting what the other threads contributed. The first half of the sentence was right and the second described the previous release.

It says what happens now, and why, since the reason is the part an owner needs in order to decide what to do next.
