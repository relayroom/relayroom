---
"@relayroom/server": patch
"@relayroom/web": patch
"@relayroom/db": patch
---

Enforce three access rules the code already declared but did not apply everywhere. A project ban now cuts off dashboard **reads** and re-checks live SSE streams, instead of only blocking writes - a banned member could previously still read every thread, and the project connect code, by refreshing the page. Message recipients are validated against the same set the UI offers, so a crafted request can no longer address a soft-deleted agent or the internal human pseudo-part. And activity no longer revives a removed agent: a deleted part's still-running pager used to bring it back on its next heartbeat, silently undoing the deletion. Deliberate re-add from the dashboard is unaffected.
