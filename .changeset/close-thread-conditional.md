---
"@relayroom/web": patch
---

Stop the dashboard overwriting a thread status an agent changed a moment earlier.

Changing a status from the dashboard resolved the thread and then wrote unconditionally, so anything that landed in between was simply replaced. The write that mattered was `close`: an agent closing a thread marks the project for distillation, and a dashboard action arriving just after would move the status back while both callers were told they had succeeded - leaving a lesson taken from a thread that is not closed.

The write is now conditional on the status the page actually saw. Losing that race is reported rather than passed off as success, with a message that says to reload instead of retry, since retrying would re-apply the overwrite.
