UPDATE "agent" SET "role" = 'main' WHERE "role" = 'master';--> statement-breakpoint
DROP INDEX "agent_project_user_master";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_project_user_main" ON "agent" USING btree ("project_id","owner_user_id") WHERE role = 'main';