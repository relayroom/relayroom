---
"@relayroom/db": patch
"@relayroom/web": patch
---

Purge the knowledge derived from a thread, and say honestly what that will do.

Knowledge is a distilled copy, so deleting a thread cascades nothing. An owner can now purge everything derived from a given thread explicitly. An entry whose only source is that thread is deleted; an entry that also came from elsewhere keeps its content and loses only that one provenance reference.

Because those are two different outcomes, the confirmation reports both counts rather than one total. The preview runs the same code path as the delete with a dry-run flag, so the number shown and the number acted on cannot diverge.
