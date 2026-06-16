CREATE TABLE "governance_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid,
	"org_id" text,
	"action" text NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"subject_user_id" text,
	"actor_user_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governance_audit" ADD CONSTRAINT "governance_audit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_audit" ADD CONSTRAINT "governance_audit_subject_user_id_better_auth_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_audit" ADD CONSTRAINT "governance_audit_actor_user_id_better_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_audit_project_created_idx" ON "governance_audit" USING btree ("project_id","created_at");