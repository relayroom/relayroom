---
"@relayroom/web": patch
---

Translate the relative timestamps. `timeAgo()` returned Korean unconditionally ("방금 전", "3분 전"), and it is used on every list of threads, events, agents and projects - so an English dashboard showed Korean timestamps, and in one place a half-translated sentence ("Last activity 3분 전") where the value was interpolated into a translated string.
