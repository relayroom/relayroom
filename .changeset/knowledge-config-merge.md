---
"@relayroom/web": patch
---

Groundwork for the redaction settings screen: write one knowledge-config key without disturbing the others, and ask the extractor to look again.

`knowledge_config` is a single JSONB column holding several unrelated settings, so writing it wholesale would delete the ones the caller did not mention. None of those has a way to be set yet, which is exactly why this is worth getting right now - a whole-column write would look correct until someone adds one, and then start clearing it silently on every save.

Saving also marks the project for re-distillation. That is what makes correcting an over-broad pattern actually recover a thread that was left empty by it; without it the correction waits for some unrelated thread to close. Recovery has a limit the screen will state: only distillations that stored nothing come back, since one that stored an entry holds a claim on the thread.
