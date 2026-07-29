---
"@relayroom/web": patch
---

Show which parts had wakes withheld, and why.

A withheld wake left no trace anywhere an operator looks. A part that was not nudged is indistinguishable from a part with nothing to do, so a fleet going quiet had no explanation short of reading the server's budget code. The audit panel did show that something had been suppressed, but only on a part's own page - which requires already knowing which part to open, and not knowing that is the symptom.

Project settings now lists the parts that had wakes withheld in the last day, grouped by reason, next to the budget control. The reason matters more than the count: budget exhaustion is the only one an owner can do anything about, a provider limit clears itself, and a cooldown withheld only the nudge because the message was delivered anyway. The per-part audit names the reason too, instead of just saying "suppressed".

The panel states what it does not cover. A wake merged into one already pending is not withheld and is not recorded, and provider limits are counted only for messages someone sent, so a part parked on a limit was unreachable for longer than the count shows. Leaving that unsaid would make an incomplete record read as a complete one, which is the failure this is meant to end.
