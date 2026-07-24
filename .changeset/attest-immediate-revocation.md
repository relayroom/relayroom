---
"@relayroom/web": patch
---

Let a leaked attestation secret be revoked immediately, instead of outliving its own replacement by a day.

Rotation kept the previous secret valid for a grace window so a CI run in flight would not break. That is right for routine rotation and wrong for the other reason a secret gets rotated: it leaked. There the window is not a courtesy, it is the exposure, and a compromised secret could keep promoting knowledge for another day. Every other credential in the system could already be cut immediately; the one guarding the CI promotion channel could not.

Rotation now has two modes, and revoking clears the previous secret in the same write that mints the new one. The audit entry records which mode was used, so the ledger distinguishes routine hygiene from an incident instead of leaving it to inference.

The interface states the limit plainly: revoking stops future misuse and does not undo promotions the leaked secret already made. Assuming otherwise is the dangerous reading.
