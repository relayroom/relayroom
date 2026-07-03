---
"@relayroom/web": patch
---

Gate project mutations and agent actions by `project_access` level, not just org membership (Wave 1 access-control backlog, AC-1 through AC-4). `requireProjectAccess(userId, projectId, minLevel)` now authorizes updateProject/updateRelayroomMd (`write`+) and archiveProject/regenerateConnectCode (`owner`); connectAgent requires `write`+ project_access directly instead of merely being an org member; agent edit/set-main/disconnect/delete are now restricted to the agent's own owner or a project owner/org manager (`requireAgentManage`); and the project layout + `resolveActiveOrgId` re-confirm the caller is still an org member before serving project reads, so a member removed from an org (or a stale `activeOrganizationId`) can no longer read a project via a forged/stale session value.
