---
"@relayroom/web": patch
---

Widen the knowledge Proposals and CI attestation pages to match every other page.

Both were laid out at `max-w-3xl` while the knowledge tab they sit under, the other project tabs, and the dashboard all use `max-w-6xl`, so moving between tabs made the content jump narrower for no reason. They now use the same width as their siblings.
