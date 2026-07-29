---
"@relayroom/server": patch
"@relayroom/db": patch
---

Name `budget_exhausted` in the wake audit trail, and correct the reason vocabulary.

A suppressed wake caused by an exhausted budget stored no reason, so it was the one cause an audit view could not label - while rate-limit parks and loop-breaker trips arrived named. It is now recorded like the others.

Two type-level corrections behind it. `WakeSuppressReason` describes what the wake decision returns to its caller, not what is stored: most of its values leave no row at all, and `loop_breaker`, which is stored, was not among them. It is now split from `PersistedWakeReason`, which is the set an audit view can actually show. The dead value `not_idle` is removed - it was declared and never produced.

The column's own comment also listed three values nothing has ever written to it. A list of values that cannot occur is worse than no list, because it invites filters for states that never arrive.
