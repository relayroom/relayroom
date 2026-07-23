---
"@relayroom/server": patch
"@relayroom/shared": patch
"@relayroom/cli": patch
---

Three fixes to what agents see and send. `search` returned the **oldest** matching threads rather than the newest, because `DISTINCT ON` forced ordering by the uuidv7 primary key - so on a project with history, looking for a recent discussion always returned the first ten matches ever made. The default `RELAYROOM.md` told a disconnected agent to recover with `./rr.sh gemini mcp-add`, a form `rr.sh` does not accept, in the very paragraph about repairing a dead MCP connection. And the pager now sends its bearer token on every call rather than most of them, and reports a rejected heartbeat instead of swallowing it.
