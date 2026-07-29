---
"@relayroom/web": patch
---

Ask for blocked sends with the column they are actually recorded under.

A send stopped by the loop breaker is recorded against the sender, and no longer against an owner - nothing was suppressed for anyone, so there is no owner to record. The audit read both axes through the owner column, which meant blocked sends matched nothing at all: the section never appeared, and its counts were always zero. That renders as "no send of yours has ever been blocked", which is not something this app was in a position to say.

Each axis is now its own query with its own gate - wakes for your parts by owner, blocked sends by sender - rather than one query widened to catch both. A single stated gate per query is a sentence that can be checked, and this table's history is one column being read as two things.

The test fixture built the old row shape by hand, so it kept passing while the real one returned nothing. It now matches what the server writes, and reverting the fix turns the tests red.
