---
"@relayroom/server": patch
---

Add the daily knowledge-metrics rollup that fills the Learning panel.

For each project and UTC day it computes the four metrics as raw numerators and denominators - repeat-error rate (a 7-day signature lookback), recall-hit rate, precision (a 14-day contradiction lookahead), and candidate-to-trusted p50 - plus a snapshot of the current trusted and candidate totals. Every metric is agent-sourced telemetry, which the module states at the top: the rollup claims direction, not ground truth.

Precision is the subtle one. A contradiction is a late, negative signal, so a freshly promoted entry looks better than it is until its 14-day window closes. The rollup therefore recomputes a trailing 14 days on every run and backfills, and a comment says why so the recomputation is not later "optimized" away into an optimistic bias. The trusted/candidate counts are the opposite: a point-in-time snapshot, deliberately excluded from that recomputation window - the SET on a revisit touches only precision, so a past day's stock stays the past's, and a test pins that a later run does not re-snapshot it.

The error-signature definition lives in a shared module with an explicit version constant, so the L4 clusterer reuses the same definition rather than growing a second copy.
