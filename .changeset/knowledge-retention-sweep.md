---
"@relayroom/server": patch
---

Retire knowledge entries once they pass their expiry.

An `expiresAt` is somebody's decision that an entry should stop being repeated, so a sweep moves expired entries to `retired` and writes an audit row for each transition. `recall` already excludes them directly, so the sweep is what makes the state on disk match what agents are being told rather than what closes the gap.

Scope is deliberately the expiry sweep alone. Garbage-collecting old candidates needs a retention policy that has no default until a later slice, so implementing it now would ship a sweep that can never act.
