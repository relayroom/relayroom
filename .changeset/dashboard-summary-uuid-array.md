---
"@relayroom/web": patch
---

Fix the dashboard failing to load for any organization with more than one project.

The agent-status lookup built its own `ANY(ARRAY[...]::text[])` filter against `agent.project_id`, which is a uuid column, so Postgres rejected the query with "operator does not exist: uuid = text". `getDashboardSummary` caught it and reported a failure, which took the projects, agents and organizations widgets down together.

It only appeared with two or more projects: the code branched on `projectIds.length === 1` and the single-project branch used a plain equality that worked fine, so the broken side went unnoticed until an organization had a second project. The filter is now `inArray`, which casts to the column's own type and removes the one/many split entirely - the split was the reason half the code path was never exercised. The same needless split has been collapsed in the organization queries. Regression tests now cover two and three projects, not just one.
