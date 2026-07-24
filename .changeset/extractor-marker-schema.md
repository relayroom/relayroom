---
"@relayroom/db": patch
---

Add the durable extractor marker and a redaction-patterns config field, migration `0018`.

`project.knowledge_dirty_at` is the marker the extractor sweeps on - set when a thread closes, cleared only if it still holds the value the sweep snapshotted. If the thread re-closes mid-sweep the marker takes a new value and the old-keyed clear misses, so the second close survives to the next sweep; that miss is the whole point of a durable marker. `knowledgeConfig` gains `redactionPatterns` for the per-project denylist the extractor and `learn` apply before writing (`retentionDays` was already in the type).

One trap is documented at the schema and in the tests: the clear must compare the marker at full precision. A JS `Date` carries milliseconds, the column stores microseconds, so reading the marker into a `Date` and writing it back into the `WHERE` never matches - the clear misses and the project stays dirty forever. The sweep must snapshot the marker as text or reference the column within one transaction, never round-trip through `Date`.
