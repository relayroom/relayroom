---
"@relayroom/db": patch
---

Purging a thread now refuses an entry it cannot fully clear, instead of quietly unlinking it.

An entry distilled from more than one thread used to be *detached*: the purged thread's reference was stripped and the entry kept. The reference went and the text derived from that thread stayed - a success report over surviving content, in the tool whose purpose is removing something sensitive.

Purge cannot keep both of its promises for such an entry. It contains text derived from the purged thread, and nothing records which sentence came from where, so that text cannot be removed without deleting the entry. Detaching resolved that conflict silently and in the direction that loses. It is now resolved out loud: everything removable is still removed, and any entry that cannot be fully cleared is named in the result and in the audit trail so an operator can decide what to do about it.

No deployment can reach this today - nothing produces an entry citing two threads - which is why the change is behaviour-neutral, and why the refusal exists now rather than later: it fires on the day that stops being true, in front of the operator who would otherwise have been told the purge succeeded.
