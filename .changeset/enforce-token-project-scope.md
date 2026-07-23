---
"@relayroom/server": patch
"@relayroom/web": patch
"@relayroom/shared": patch
"@relayroom/db": patch
---

Enforce the project scope recorded on an agent token. `connectAgent` mints tokens scoped `project:<id>`, but nothing read that scope at the MCP boundary - the project came from the connect code and authorization checked org membership and the ban gate only. A token minted for one project therefore authenticated against any other project in the same organization whose part its owner held. The scope is now checked before authorization on the MCP connect path, on the SSE path, and by a migration that revokes connections a token was never scoped to. Standard OAuth tokens are user-scoped by design and are unaffected.
