---
"@relayroom/db": patch
---

Add `knowledge_metric_daily`: the storage for the Learning panel's four metrics, migration `0017`.

One row per project per UTC day, storing raw numerators and denominators rather than ratios so a metric can be recomputed and a definition change is detectable. Every metric column is nullable on purpose: a day where a metric was not computed is null, which has to stay distinct from a real zero, or the panel would render "not enough data" as 0%. `normalization_version` is the one non-null count column, so a change in how a metric is defined shows up in the series rather than silently shifting the line.

Storage only - the rollup that fills these columns lives in server, and the window logic each metric needs (a 7-day lookback for repeat errors, a 14-day lookahead for precision) is a computation concern, not encoded in the schema. A row holds that day's raw counts and nothing about how they were derived.
