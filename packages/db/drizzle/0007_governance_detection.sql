ALTER TABLE "wake_event" ADD COLUMN "reason" text;--> statement-breakpoint
CREATE INDEX "wake_event_project_sender_created_idx" ON "wake_event" USING btree ("project_id","sender_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_alert_open_uniq" ON "governance_alert" USING btree ("project_id","subject_user_id","kind") WHERE "resolved_at" is null;
