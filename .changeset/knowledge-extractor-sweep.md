---
"@relayroom/server": patch
---

Distill closed threads into candidate knowledge, with redaction applied before anything is written.

A thread reaching `closed` or `answered` sets a durable marker; a leased sweep claims dirty projects under an advisory lock so exactly one worker extracts a project at a time. Correctness rests on the marker plus an idempotent sweep rather than on a notification, so a missed signal is a non-event: the next sweep still catches it.

The per-project redaction denylist runs before any write, and a matched span is dropped rather than masked, so a secret never reaches storage in any form. It covers manual `learn` as well as the extractor, since a human typing a secret into `learn` is otherwise an unredacted path into the same table.

Extractor output is always `candidate`. Automation widens intake, not trust.
