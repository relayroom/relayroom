---
"@relayroom/server": patch
---

Add the CI attestation endpoint and the agent demotion path.

`POST /api/knowledge/attest` is the non-agent channel that can promote knowledge to trusted. It is a plain HTTP route, not an MCP tool, so an agent holding a connect code cannot reach it. It verifies an HMAC over a canonical body, selects the signing key by `keyId` (current or previous within its grace window), bounds clock skew, checks that the claim belongs to the signing project, and spends a per-project nonce - in that order, so a forged request is rejected before it can burn a nonce it never earned. Promotion itself is left to the shared ledger function, which counts the entire CI system as one issuer.

Agents get the safe direction only. An `error` event carrying `detail.contradicts` records a contradiction against the named entry, demoting it; no event payload can promote, because the signal is fixed to `contradict`. A contradiction that cannot be applied (unknown entry, or another project's) is reported in the response rather than swallowed, and the path is rate-limited so a demotion loop cannot quietly retire an entry.
