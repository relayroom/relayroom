---
"@relayroom/web": patch
---

Say that a wake budget belongs to the owner, not to the project it is displayed in.

The budget card sits inside a project, and its description said only "counted across all parts you own, project-wide", which reads as a limit for that project. It is not: one allowance is shared by every part the owner runs, in every project they are in, so parts working somewhere else spend the same hour. Reading it the other way is what led to a fleet going quiet with no visible cause.

The same sentence now appears when registering a new part, since that is when someone is deciding how many parts to run. It is a hint at the point of the decision rather than an alert afterwards - part count does not predict wake pressure, because an idle part costs nothing while a few busy ones can exhaust the hour on their own.

Neither line quotes a number. The limits are server-side constants that this app cannot observe changing, so a figure printed here would go stale silently.
