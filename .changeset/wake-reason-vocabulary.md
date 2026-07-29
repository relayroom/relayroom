---
"@relayroom/server": patch
"@relayroom/db": patch
---

Name every suppressed wake in the audit trail, and correct the reason vocabulary.

Two of the four causes that suppress a wake stored no reason at all, so they arrived in an audit view unlabelled while the other two arrived named. One was an exhausted budget - the cause an operator is most likely to want to act on. The other was a direct message inside its cooldown window, whose code comment claimed it recorded a reason while the write did not set one. Both are now recorded.

Behind them, two type-level corrections. `WakeSuppressReason` describes what the wake decision returns to its caller, not what is stored: most of its values leave no row at all, and the causes written by the message pipeline were not among them. It is now separate from `PersistedWakeReason`, which is the set an audit view can actually show, and which is enumerated from the writes rather than from a declaration. The dead value `not_idle` is removed - it was declared and never produced.

The column's own comment listed values nothing writes. Two of them genuinely never occur and were removed. The third turned out to be a real cause whose row existed with its name missing, which is why it looked like a value that never occurs - a cause stored as nothing is indistinguishable from a cause that never happens, so the first correction removed the evidence of the second defect rather than the defect. Both are fixed.
