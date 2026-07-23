---
"@relayroom/server": patch
---

Resolve an agent token to the part the caller says it is. The SSE auth path picked one of the token's connections arbitrarily - no ordering, first row wins - and then refused the request if the caller had named a different part. An agent whose token had more than one connection, which happens whenever a part is renamed and the token is reused, could therefore be locked out of its own event stream with `token is scoped to part '<other>'`, a message describing a scope that does not exist. The token now resolves against the requested part, falls back to the connect code when it has no connection for it, and only infers a part when exactly one connection exists.
