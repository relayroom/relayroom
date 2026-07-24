CREATE TABLE "knowledge_proposal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hypothesis" text NOT NULL,
	"disconfirming" text,
	"change" jsonb NOT NULL,
	"trigger_signature" text,
	"created_by_job" text DEFAULT 'proposer' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"audit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_proposal_status_ck" CHECK ("knowledge_proposal"."status" in ('pending','approved','rejected','superseded')),
	CONSTRAINT "knowledge_proposal_target_ck" CHECK ("knowledge_proposal"."target" in ('knowledge','playbook'))
);
--> statement-breakpoint
CREATE TABLE "playbook_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"note" text,
	"proposal_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_proposal" ADD CONSTRAINT "knowledge_proposal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposal" ADD CONSTRAINT "knowledge_proposal_decided_by_user_id_better_auth_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposal" ADD CONSTRAINT "knowledge_proposal_audit_id_knowledge_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."knowledge_audit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_version" ADD CONSTRAINT "playbook_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_version" ADD CONSTRAINT "playbook_version_proposal_id_knowledge_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."knowledge_proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_version" ADD CONSTRAINT "playbook_version_created_by_user_id_better_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_proposal_project_status_idx" ON "knowledge_proposal" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_proposal_open_signature_idx" ON "knowledge_proposal" USING btree ("project_id","trigger_signature") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_version_project_version_idx" ON "playbook_version" USING btree ("project_id","version");