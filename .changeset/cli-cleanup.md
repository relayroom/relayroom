---
"@relayroom/cli": patch
---

Report the shipped version in the MCP handshake instead of a hardcoded `0.1.0`, and let a config field be removed. `writeConfig` skipped empty values, so no field could ever be cleared once written - `previousTarget` in particular outlived its purpose and kept `rr.sh up` trying to rename a session that had already been renamed. Also drops a `machineLabel` field nothing read and a comment describing a variable the pager no longer has.
