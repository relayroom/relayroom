---
"@relayroom/web": patch
---

Add the project Knowledge tab.

The four claim states with counts, filtering, pagination, and per-entry kind, title, body, provenance, and timestamps. Each row also shows how many independent issuers support it: a state label alone says "trust this" without saying why, and the point of the substrate is that a claim earns trust because something independent confirmed it. A candidate sitting at zero should read as "nothing has confirmed this yet" rather than as an unexplained label.

That count is computed the same way the promotion transaction computes it, because the number on screen has to be the number promotion acts on - a count that merely looks plausible invites someone to promote on evidence that is not the evidence.
