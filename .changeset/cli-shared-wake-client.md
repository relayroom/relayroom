---
"@relayroom/cli": patch
---

Put the pager and the channel server on one shared wake client, and stop logging the connect code.

The two wake runtimes had grown independent copies of the same protocol: lease claim and fencing, the SSE subscription and its parsing, catch-up coalescing, auth headers, and the retry curve. Copies drift, and these had - the retry curves differed enough that an identical message woke an agent about 1.5 seconds later depending on which delivery mode was in use. The shared client removes roughly 320 lines of duplication and adds a parity guard that asserts neither runtime redefines the protocol locally, since that guard is the only layer that prevents the copies coming back.

Peer-controlled fields on the channel path are now sanitized the same way the pager already sanitized them, with the same clamps.

Separately, both runtimes logged the SSE URL on connect, and the connect code is in that URL. A connect code is a capability key, so writing it into a log file is a defect on its own terms; consolidating the runtimes made it a single line to fix.
