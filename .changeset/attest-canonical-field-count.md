---
"@relayroom/server": patch
---

Correct the field count in the attestation canonical-encoding comment.

The header described "the SEVEN fields" while `AttestClaim` and `CANONICAL_FIELDS` both list eight, and the related note about an extra field was off by the same one. Signing behaviour is unaffected - only the prose was wrong. It is worth fixing because this file declares itself the single source of truth for the bytes both sides sign, so a reader counting along with the comment would find it disagreeing with the list directly beneath it.

Found by the agent writing the public documentation, while checking each stated number against the code rather than against the brief.
