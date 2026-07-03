---
"@relayroom/server": minor
"@relayroom/db": minor
"@relayroom/shared": minor
"@relayroom/web": minor
---

Limit-aware wake (park & resume): an agent that hits its provider's rate limit reports `event type:"limited"` with `detail.resetAt`; RelayRoom parks its wakes (messages still queue) and the eligibility sweep automatically re-wakes it right after the reset. Dashboard shows a live "limited until" badge.
