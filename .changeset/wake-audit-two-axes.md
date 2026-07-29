---
"@relayroom/web": patch
---

Stop listing your own blocked sends among the wakes aimed at your parts.

The wake audit reads `wake_event` by owner, but that column carries two different subjects. Most rows mean "a wake was aimed at a part you own". A loop-breaker row means "you sent something and it was stopped" - it is recorded against the sender and names no part at all. Shown in one list, the second read as the first: a suppression appeared among a part's wakes with nothing to attribute it to, inviting the reader to blame a part that was never involved.

They are now separate sections with their own wording and their own counts, and the counts are computed per axis in SQL rather than from the capped row list, so neither summary includes the other's rows. The blocked-sends section appears only when there is something in it, and says what it does not cover: the loop breaker is the only thing that lands there.

The split keys on whether a row names a part, not on its reason string, so it holds while the reason vocabulary is being reworked.
