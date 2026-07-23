---
"@relayroom/cli": patch
---

Stop writing credentials where they can leak. The agy MCP config holds a bearer token and was written with the default umask, leaving it world-readable on a multi-user machine; it is now owner-only, matching how `.relayroom/config.json` is already written. The usage hook no longer bakes the project connect code into `.claude/settings.json` or `.gemini/settings.json` - files Claude Code's convention says to commit for the team - and reads it from `.relayroom/config.json` at run time instead, which the hook script already supported.
