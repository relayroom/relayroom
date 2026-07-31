---
"@relayroom/server": patch
---

The extraction watermark is now the whole record of whether a thread's knowledge was decided, and extraction happens only on threads that were closed.

The sweep used to skip any thread that some knowledge row cited. That is a different question from the one it meant to ask: a citation records that somebody mentioned the thread, and `learn` writes one without deciding anything about it. The two were conflated because there was no other way to say "decided" until `close` gained a lesson. Migration 0022 had already settled the same point in the other direction, deliberately excluding `learn` rows from its backfill so an incidental suppression would not become permanent.

One consequence is visible on upgrade: a thread that was only ever cited by a `learn` row was silently exempt from extraction, and now is not, so it gets distilled once. Threads already extracted are unaffected, and it does not repeat - the watermark records it. On the hub this was written against, eight threads were in that state; your own count depends on how often your agents called `learn` with a thread reference.

The sweep also processes threads in a defined order now. A tick can stop early when it detects a rules change, so the order decides which threads are written before it stops - that is a property of the sweep, not tidiness, and it was previously whatever the heap returned.
