---
"@relayroom/web": patch
---

Show a failed dashboard summary as a failure rather than as loading forever.

The dashboard renders on the server, so by the time it renders its data is final and there is no loading state left to be in. Rendering a skeleton when the data was missing therefore did not mean "still loading", it meant "the query failed", and it animated indefinitely because nothing would ever render again. The error the query had already produced was discarded on the way.

Failures now surface the message with a way to retry, and skeletons are left to the route's loading state where the framework actually shows them. The project count no longer falls back to zero either: a count of zero is not an empty-looking placeholder, it is a specific and false claim about the account.
