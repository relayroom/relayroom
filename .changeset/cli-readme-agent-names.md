---
"@relayroom/cli": patch
---

Correct the agent names in the CLI README. It told people to pass `--agent gemini`, which the CLI rejects - the accepted values are `claude`, `agy` and `codex`. That README is what npm shows on the package page, so the first document a new user reads was instructing them to run a command that fails. The `.gemini` paths stay: `agy` (Antigravity) reuses Gemini's config location, and only the agent name changed. Also documents the tmux requirement and the `rr.sh` console, neither of which had made it into the README.
