-- Add optional display nickname to users (better-auth additionalField).
-- NOTE: drizzle-kit re-emitted the oidcProvider tables here because the
-- hand-authored 0001_agent_oauth.sql is not in drizzle's snapshot history; those
-- CREATE statements were removed so this migration only adds the new column. The
-- meta snapshot now reflects all tables, so future generates stay clean.
ALTER TABLE "better_auth_user" ADD COLUMN "nickname" text;
