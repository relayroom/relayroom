---
"@relayroom/cli": patch
---

Document what the usage hook actually sends, and let it be turned off. Besides token counts, the hook sends an excerpt of each turn's content for Claude - the first 80 characters of the prompt and the last 500 of the answer - so a dashboard event shows the exchange rather than just "a turn happened". That was never stated in the README. It is now, alongside the fact that it goes to your own hub rather than to relayroom.dev, and `"usageContent": false` in `.relayroom/config.json` keeps the token counts flowing while dropping the excerpts.
