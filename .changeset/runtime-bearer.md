---
"@relayroom/server": patch
"@relayroom/cli": patch
---

Require a bearer token on the runtime endpoints, so a project ban actually cuts access off. These authenticated on the project connect code alone - a secret shared by every agent in the project, which cannot be rotated to remove one member without disconnecting all of them - and `part` was an unauthenticated claim in the query string, so anyone holding the code could read any part's unread thread subjects and senders. The three `wake` endpoints now require a token and verify that the caller owns the part. `/unread`, `/heartbeat`, `/usage`, `/role` and `/relayroom-md` accept the old form for now behind a rate-limited deprecation warning, and the CLI sends the token from every one of those callers so the warning goes quiet on the normal upgrade path.
