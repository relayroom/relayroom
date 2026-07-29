---
"@relayroom/server": patch
---

Correct the record: the redaction denylist announced in 0.5.0 has never been configurable, and therefore has never run.

0.5.0's notes described "a per-project redaction denylist that drops matched spans before anything is written". The mechanism is real and it is wired into both knowledge write paths - the extractor and the `learn` tool. What does not exist is any way to fill it. `project.knowledge_config` is created empty and **no path in the product writes it**: no settings field, no API, no CLI, no seed. Every read of it falls through to the empty default, and an empty denylist redacts nothing, by design and by its own documented contract.

So in every deployment since 0.5.0, including ours, knowledge has been stored exactly as written. The sentence in those notes is not false - the denylist is per-project by design - but a reader takes "per-project" to mean configurable and concludes they hold a control they have never had. That conclusion is the thing worth correcting, and it should not wait for the fix.

**What this means concretely.** Distillation copies up to 2000 characters of a closed thread's last agent message verbatim, and redaction was the only filter standing between that copy and the knowledge table. The same applies to anything recorded through `learn`. Nothing in RelayRoom puts credentials into a thread; the exposure is that whatever an agent did write - a pasted log, a debugging session, a connection string - was carried across unchanged.

**What we checked on our own hub.** We scanned all 199 knowledge rows for credential shapes and found none: the only high-confidence match was a placeholder test database URL. We report counts rather than contents deliberately. That result says nothing about your deployment, and it is weaker evidence than it looks even for ours: a shape scan finds the shapes its author thought of, which is precisely the limitation of the denylist it was measuring. Our fleet is clean because it discusses code rather than credentials, not because anything stopped it.

**What you can do now.** Nothing configures redaction until 0.6.0 ships it. What is available today is the other half: purging everything derived from a given thread, an owner action on the knowledge settings page - which, as of 0.5.2, stays purged.

One more thing worth stating plainly. That single sentence in the 0.5.0 notes advertised two safety nets, the denylist and thread purge, and neither had ever worked. Purge was fixed in 0.5.2. This is the other half, disclosed here and fixed in 0.6.0.
