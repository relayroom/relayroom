---
"@relayroom/web": patch
---

Add CI attestation management: secret rotation and the check-to-claim map, owner-only.

An owner mints an attestation secret, rotates it, and maps which CI check may attest which knowledge entry - all under `/knowledge/settings`, because turning CI into a promotion channel is part of the knowledge trust model, not general project config. The plaintext secret appears only in the mint response and has no re-read path: `getAttestStatus` returns the key id and grace state, never the secret, and a test asserts the plaintext never appears in any read. Rotation is two-slot per the design, so a running CI keeps working through the grace window, and it writes an audit row.

The disabled state is framed as a valid policy, not a missing setup: with no secret, only a human owner promotes - which is exactly how L0 shipped. The copy also states that CI alone cannot reach the promotion threshold, so an owner who enables a secret does not expect automatic promotion and file it as a bug. The check-map only offers claims from the same project, and the composite foreign key backs that up; a test pins the clean rejection rather than letting the constraint silently stand in for the application check.
