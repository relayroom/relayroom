---
"@relayroom/web": patch
---

Read the agent list's model badge from usage only, never from the connection.

Both agent list queries resolved the badge as `connection.model ?? usage.model`. Nothing writes `agent_connection.model`, so that column is always null and the badge already came from usage - it updates every turn, which is the behavior we want. But the dead read sat first and looked authoritative, so anyone noticing the column was never populated would naturally "fix" it by writing the model at connect time, and every badge in the product would freeze at first connect: no error, no visible change until an agent switched model.

The connection is the wrong grain for this in the first place. A connection is long-lived while the model is a per-turn property, so there is no correct value to store there. The read now goes straight to usage and carries a comment saying why, since the unused column would otherwise make the code look like the mistake.

No visible change today.
