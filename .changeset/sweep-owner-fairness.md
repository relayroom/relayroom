---
"@relayroom/server": patch
---

Stop one owner from holding the whole eligibility sweep batch.

The wake budget is isolated per owner, but the sweep batch that decides who gets *considered* was instance-wide: the 50 lowest agent ids, oldest first. A budget-suppressed agent stays idle with unread messages, so it stays a candidate - which meant one owner with 50 or more exhausted agents held every slot on every tick, indefinitely, and a second owner with an untouched budget was never evaluated at all. Measured at 5 ticks: 0 of 5 agents woken for the healthy owner.

That is a tenant-isolation failure rather than a delay. Budgets are per owner precisely so one account cannot affect another, and this was a route around that.

The batch now bounds how many slots any one owner can take, and orders by how long an agent has actually been waiting rather than by how old its row is. A single-owner instance still gets the whole batch.

This trades starvation for throughput, deliberately: slots taken by a suppressed owner are still spent on agents that get suppressed again. A slow queue beats a queue nobody can join. The root fix - keeping agents whose owner has no budget out of the candidate set entirely - is not done here because the budget is a rolling-window aggregate and folding it into a query that runs every 30 seconds costs more than the wasted slots.
