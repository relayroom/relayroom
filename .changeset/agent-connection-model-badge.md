---
"@relayroom/web": patch
---

Remove the model badge from connection rows on the agent detail page.

A connection is an agent plus an access token and outlives any number of model switches, so there is no correct model to show against one. The badge read `agent_connection.model`, a column nothing writes, and it had therefore never rendered for anyone.

That made it worse than an ordinary unused field. Unlike the agent list, this badge had no fallback, so anyone who "fixed" the empty column by writing a model at connect time would have seen a badge appear where none had been - the change would have read as an improvement while quietly pinning every agent to the model it first connected with. Removing the badge removes the incentive.

Nothing is lost: the models an agent has actually run are already listed on the detail page from event data. Connection rows keep the fields that genuinely belong to a connection - machine, status, repo and branch, last seen.
