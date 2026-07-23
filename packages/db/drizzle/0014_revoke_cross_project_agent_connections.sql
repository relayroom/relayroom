-- BUG-0007 backfill: revoke agent connections a token was never scoped to.
--
-- Agent tokens are minted for ONE project (scopes = 'project:<id>'), but until
-- 0.4.2 nothing checked it, so a token could open a connection against any project
-- in the same org. The server now refuses those at the boundary; this closes the
-- ones already sitting in the table.
--
-- Deliberately narrow. Two things must survive untouched:
--   * standard OAuth connections (any client_id other than the internal one).
--     Those tokens are user-scoped by design and carry no project scope, so the
--     scope test does not apply to them - INCLUDING the legitimate case of one
--     token connected to several projects, which access_token_id being nullable
--     and non-unique makes possible.
--   * internal connections whose project IS in the token's scope.
--
-- status = 'revoked', not DELETE: the row is audit history, and auth only accepts
-- status = 'connected', so revoking is sufficient to cut access.
--
-- The client id is written out rather than imported. A migration is a record of a
-- one-time operation against the database as it stood; it must keep meaning the
-- same thing if the constant is ever renamed.
UPDATE "agent_connection" AS ac
SET "status" = 'revoked'
FROM "better_auth_oauth_access_token" AS t, "agent" AS a
WHERE ac."access_token_id" = t."id"
  AND ac."agent_id" = a."id"
  AND ac."status" <> 'revoked'
  AND t."client_id" = 'relayroom-internal-agent-client'
  -- Exact element match against the space-delimited scope string, mirroring
  -- tokenScopeAllowsProject. A LIKE would accept a project whose id is a prefix of
  -- the scoped one. NULL and empty scopes coalesce to no elements and so are
  -- revoked: an absent scope cannot be evidence of permission.
  AND NOT (
    'project:' || a."project_id"::text
      = ANY(string_to_array(coalesce(t."scopes", ''), ' '))
  );
