---
"@relayroom/web": patch
---

Add the Learning panel: the four compounding metrics, honestly gated.

The panel sits above the knowledge list and shows repeat-error rate, recall-hit rate, knowledge precision, and candidate-to-trusted p50 - each as a headline over a 30-day window with a daily sparkline beneath it. Below the sample threshold it renders "not enough data" rather than a percentage, because a ratio from a handful of points is the dishonesty this whole slice exists to prevent; a gate that only hides is as useless as no gate, so a matching test asserts the number does appear once the threshold is met. Every metric is labelled agent-reported, there is no cross-customer comparison anywhere, and the normalization version is shown so a definition change is visible in the series.

The gating and aggregation logic is a pure function with the thresholds and window as constants in one place, unit-tested directly since it is the honest core of the feature. Precision gets special handling: a contradiction is a late signal, so the most recent 14 days are still accumulating and would read optimistically. The sparkline marks that tail provisional and the headline is computed from the settled days only - verified by mutation, since a rollup that stores honest data can still be drawn as if it were final.
