---
"@relayroom/db": patch
---

Drop the unused `agent_connection.model` column.

Nothing has ever written it. Its only readers were the agent list badge, which took `conn?.model ?? usage?.model` and so always fell through to usage, and the connection row on the agent detail page, which rendered `{conn.model && <Badge/>}` with no fallback and therefore never rendered at all. Both now read from usage, leaving the column with no readers either.

Keeping it would have been worse than dead weight: an authoritative-looking column that is NULL everywhere reads as a missing write, and adding that write would freeze the list badge at whatever model was current when the connection opened and make a never-before-seen badge appear on the detail page. A connection is (agent, access token) and outlives model switches, so there is no correct value to store. The models an agent has actually run are already derived from events on the agent detail page.

Migration `0021_drop_agent_connection_model`. The column is NULL in every deployment by construction, so the drop discards nothing.
