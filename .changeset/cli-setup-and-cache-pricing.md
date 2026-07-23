---
"@relayroom/cli": patch
---

Warn before taking over a shared MCP registration, keep the worktree's agent when `rr.sh` regenerates itself, and stop overstating turn cost.

codex and agy keep one MCP registration per machine, so `./rr.sh setup` in a second worktree silently repointed every other codex/agy worktree at this part - the agent that lost its identity kept running and started posting as someone else, with nothing printed at the moment it happened. `doctor` could already detect it, but only if you suspected something and went looking. Setup now reads the part currently registered and says so before taking it over. claude is unaffected, since it registers per-worktree in project scope.

`rr.sh up` and `rr.sh update --self` re-ran `relayroom init` without `--agent`, which defaults to claude - so updating a shell script in a codex or agy worktree left behind a `CLAUDE.md` for a CLI that is not in use. The saved identity was never at risk, which is why this stayed invisible.

Turn cost was overstated twice over. It summed cache creation and cache reads and charged both at the base input rate - neither bills that way, a cache read being about a tenth of the input rate and a write about 1.25x it - and since cache reads dominate an agent's token mix, a cache-heavy turn was reported at several times its actual cost. Writes and reads are now tracked and priced separately; the payload still carries one `cache_tokens` total, so nothing downstream changes.

Separately, the rate table matched on the family name, so every Opus generation was priced at the 4.1 rate of $15/$75 while the current tier is $5/$25 - a 3x overstatement on the model these agents actually run. Rates are now matched by model id prefix against verified entries only, and an unlisted model reports its token counts with no `cost_usd` rather than a guess. A visible gap prompts someone to add a rate; a wrong number is indistinguishable from a right one.
