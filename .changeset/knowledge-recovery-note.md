---
"@relayroom/web": patch
---

The redaction settings screen no longer promises that changing a rule brings a skipped thread back.

It did, and that stopped being true when the automatic extractor was removed: nothing revisits a project any more, so a thread that was skipped because redaction left nothing to keep stays skipped. The note now says so directly, because the fact that correcting a rule does not undo the past is itself something an owner needs to know before they change one.

`knowledge_dirty_at` is still written when settings are saved and when a thread is closed from the dashboard, and nothing reads it. Every write site now says that, along with why the column is kept: a cross-thread reflection pass needs exactly the question it answers, and dropping a column to add it back later is worse than writing one nobody reads yet. Without that note the writes themselves read as evidence that something still consumes them.
