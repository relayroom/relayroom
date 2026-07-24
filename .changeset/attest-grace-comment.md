---
"@relayroom/web": patch
---

Mark the attestation rotation grace window as a chosen value, not a specified one.

The design says `attest_secret_prev_expires_at = now() + grace` without giving a number; the 24h in `ROTATION_GRACE_MS` is a judgement. The comment now says so, so a later reader does not treat it as derived - the same reason the L0 contradiction window carries its note. It also points at the open review item: rotation is single-mode and has no immediate-revocation path for a leaked secret.
