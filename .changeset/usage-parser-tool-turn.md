---
"@relayroom/cli": patch
---

Report token usage for turns that end in a tool call, which was most of them.

The transcript parser walked backwards and stopped at the first user-role row, treating it as the start of the turn. Tool results are recorded as user-role rows, so any turn that used tools ended on one: the parser stopped immediately, summed nothing, and the reporter skipped the upload as an empty turn. For agents doing real work, which is to say agents that call tools, the dashboard stayed empty.

A tool result is now recognised as mid-turn and skipped, and only a genuine prompt ends the walk. As a side effect the totals are also correct for the first time, since usage is summed across the whole turn rather than the fragment after the last tool call.
