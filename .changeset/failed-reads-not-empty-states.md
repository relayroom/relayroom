---
"@relayroom/web": patch
---

Stop rendering failed reads as empty states.

A read that fails and a read that legitimately returns nothing are different facts, and several pages were collapsing them. An empty state is not a neutral placeholder: it is a claim about the account, and when the query behind it had died, the claim was false.

The inbox was the clearest case. Its attention section was guarded by a different query's result, so a failure in the attention query rendered "all caught up" - announcing an empty queue it had not managed to read. The project overview greeted a running project with the first-run "connect your first agent" banner, and the members page claimed both that there were no members and that everyone had already been added.

Failures now say so and offer a retry, and every empty state sits inside its own query's success branch, so the failure path can no longer reach a sentence that would be untrue. Elements that merely disappear on failure are left as they are: disappearing makes no claim, while an empty state makes a false one.
