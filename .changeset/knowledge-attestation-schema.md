---
"@relayroom/db": patch
---

Add the CI attestation schema: `project` attest-secret columns, `knowledge_check_map`, `knowledge_nonce`, migration `0016`.

This is the storage for the non-agent promotion channel. The secret is two-slot (current and previous) so rotating it does not break CI signatures already in flight. `knowledge_check_map` records which CI check may attest which knowledge entry, and `knowledge_nonce` is per-project replay defense.

`knowledge_check_map` carries a composite foreign key `(project_id, knowledge_id)` referencing `knowledge(project_id, id)`, not a plain `knowledge_id` reference. A plain reference only proves the id exists; the composite one stops a project's mapping from pointing at another project's claim - the tenant boundary the whole attestation model rests on. It references the `knowledge_project_id_uq` index that L0 created for exactly this.
