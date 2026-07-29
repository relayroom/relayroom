---
"@relayroom/server": patch
"@relayroom/db": patch
---

A blocked send no longer appears in the audit list of wakes suppressed for your agents.

The wake audit table records, per row, the owner of the agent that was going to be woken. A row written when the send loop-breaker blocked a message has no such agent - nothing was suppressed *for* anyone, a send was blocked *by* someone - but it was borrowing that column for the sender anyway. So a screen filtering on it returned two different kinds of event in one list, with nothing to tell them apart, and the agent audit panel was doing exactly that.

The sender is still recorded, in the columns meant for it, which is also where governance detection already read it from. Blocked sends are still visible; they belong to a different question, and now they can be asked separately.
