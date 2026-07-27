---
"@relayroom/web": patch
---

Raise the knowledge extractor marker only when a thread is closed, not when it is answered.

Answered does not mean finished. In the board vocabulary it means "I have replied to you", which is how autoclose already reads it: an answered thread stays live and is closed once it goes idle. Extraction now agrees, so marking a project dirty on answered would wake a sweep that has nothing to take.

It also protected the wrong transcript. A thread is claimed by the first extraction that succeeds, so allowing a mid-conversation state to qualify would let a partial thread be distilled and lock out the complete one that follows on close. Answered threads are still extracted, about half an hour later, with everything that was said.
