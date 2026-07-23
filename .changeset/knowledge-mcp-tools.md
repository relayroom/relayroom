---
"@relayroom/server": patch
---

Add the `recall`, `learn`, and `recall_used` MCP tools.

`recall` is the retrieval-before-action surface: an agent asks what the project already knows before starting work. It returns only entries that have earned `trusted`, ranked by trigram similarity against the entry text weighted by confidence, and it logs what it returned so recall-hit-rate is measurable rather than assumed.

`learn` is the capture side, and it always writes `candidate` - never `trusted`, by any path. Nothing an agent says about the world becomes something other agents are told until a separate promotion step says so. `recall_used` closes the measurement loop by recording which returned entry was actually acted on.

Expired entries are filtered out of `recall` even before the retention sweep removes them: an `expiresAt` in the past is somebody's decision that the entry should stop being repeated, and honoring it only at sweep time would keep repeating it in the meantime. `recall_used` accepts only an entry that the given query actually returned, so the hit-rate metric cannot be inflated by an agent naming an arbitrary id.
