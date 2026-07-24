---
"@relayroom/db": patch
---

Complete the demotion path in the promotion ledger, and return the validation id and stored counted.

Demotion already worked - `recordKnowledgeSignal` was written whole in L0, so a `contradict` signal already moved an entry to `contradicted` and left `promoted_at` in place, while an agent-authored `error_event` could demote but never promote. What this adds is the tests L1 requires: an error event demoting a `candidate` (not only a `trusted`), a second contradiction on an already-contradicted entry recording evidence without a second audit row, and a repeated error signature deduplicating to one - the mirror of a rerun green check counting as one support.

The attest response contract is `{ validationId, counted }`, so both are now on the result. The subtlety is dedup: `onConflictDoNothing` returns nothing on a replay, but attestation is idempotent and a replay must return the original validation. So a no-op reads the conflicting row back inside the same lock and returns its stored `counted` - the stored value, not the caller's input, since the original write is what stands.
