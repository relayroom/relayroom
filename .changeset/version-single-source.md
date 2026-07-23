---
"@relayroom/telemetry": patch
"@relayroom/server": patch
"@relayroom/web": patch
---

Report the real release version instead of stale hardcoded literals. The lockstep version was hand-maintained in four places that had drifted apart while the actual release was 0.4.0, so an instance built from source identified itself as 0.3.2 (and the dashboard permanently advertised an update that was already installed). `apps/web` and `@relayroom/telemetry` now read the version from their own `package.json`, which changesets keeps in lockstep, and the image `ARG RELAYROOM_VERSION` loses its hardcoded default so CI stays the only thing that bakes a version in.
