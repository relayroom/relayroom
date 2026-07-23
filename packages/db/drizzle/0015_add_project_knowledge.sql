CREATE TABLE "knowledge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"validation_state" text DEFAULT 'candidate' NOT NULL,
	"promoted_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"expires_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_kind_ck" CHECK ("knowledge"."kind" in ('fact','convention','pitfall','decision')),
	CONSTRAINT "knowledge_state_ck" CHECK ("knowledge"."validation_state" in ('candidate','trusted','contradicted','retired'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"knowledge_id" uuid,
	"from_state" text,
	"to_state" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_audit_actor_ck" CHECK ("knowledge_audit"."actor_kind" in ('human','ci','system'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_validation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"signal" text NOT NULL,
	"issuer" text NOT NULL,
	"issuer_id" text NOT NULL,
	"source_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counted" boolean DEFAULT true NOT NULL,
	"source_fingerprint" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_validation_signal_ck" CHECK ("knowledge_validation"."signal" in ('support','contradict')),
	CONSTRAINT "knowledge_validation_issuer_ck" CHECK ("knowledge_validation"."issuer" in ('ci_attest','human','error_event'))
);
--> statement-breakpoint
CREATE TABLE "recall_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid,
	"query_hash" text,
	"returned_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"used_knowledge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_created_by_user_id_better_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_audit" ADD CONSTRAINT "knowledge_audit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_audit" ADD CONSTRAINT "knowledge_audit_knowledge_id_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_audit" ADD CONSTRAINT "knowledge_audit_actor_user_id_better_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_validation" ADD CONSTRAINT "knowledge_validation_knowledge_id_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_log" ADD CONSTRAINT "recall_log_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_log" ADD CONSTRAINT "recall_log_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_project_state_idx" ON "knowledge" USING btree ("project_id","validation_state");--> statement-breakpoint
CREATE INDEX "knowledge_project_kind_idx" ON "knowledge" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_project_id_uq" ON "knowledge" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "knowledge_audit_project_created_idx" ON "knowledge_audit" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_audit_knowledge_idx" ON "knowledge_audit" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "knowledge_validation_knowledge_idx" ON "knowledge_validation" USING btree ("knowledge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_validation_dedup" ON "knowledge_validation" USING btree ("knowledge_id","signal","source_fingerprint");--> statement-breakpoint
CREATE INDEX "recall_log_project_created_idx" ON "recall_log" USING btree ("project_id","created_at");--> statement-breakpoint
-- Retrieval index. Recall matches a natural-language query against title+body, so
-- the index has to cover both as one document; a btree on either column cannot
-- serve a `%`-operator similarity search. pg_trgm has been a trusted extension
-- since PG13, so the database owner can create it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "knowledge_trgm_idx" ON "knowledge" USING gin ((title || ' ' || body) gin_trgm_ops);--> statement-breakpoint
-- Self-referential FKs, added here rather than in the table definition for the same
-- reason event.parent_event_id is: the table does not exist yet at CREATE time.
-- ON DELETE SET NULL, not CASCADE - superseding or citing a claim must not delete
-- the row that points at it.
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_superseded_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."knowledge"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_log" ADD CONSTRAINT "recall_log_used_knowledge_fk" FOREIGN KEY ("used_knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE set null ON UPDATE no action;
