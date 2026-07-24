CREATE TABLE "knowledge_check_map" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"check_name" text NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_nonce" (
	"project_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_nonce_project_id_nonce_pk" PRIMARY KEY("project_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "attest_secret" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "attest_key_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "attest_secret_prev" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "attest_key_id_prev" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "attest_secret_prev_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "knowledge_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_check_map" ADD CONSTRAINT "knowledge_check_map_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_check_map" ADD CONSTRAINT "knowledge_check_map_created_by_user_id_better_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nonce" ADD CONSTRAINT "knowledge_nonce_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_check_map_uq" ON "knowledge_check_map" USING btree ("project_id","check_name","knowledge_id");--> statement-breakpoint
-- Tenant boundary (added by hand; drizzle does not model a composite FK from the
-- schema). A map row's knowledge_id must belong to the SAME project as the row,
-- so a project can never map its CI check onto another project's claim. This
-- references knowledge_project_id_uq, the unique index L0 created for exactly this.
ALTER TABLE "knowledge_check_map" ADD CONSTRAINT "knowledge_check_map_tenant_fk" FOREIGN KEY ("project_id","knowledge_id") REFERENCES "public"."knowledge"("project_id","id") ON DELETE cascade ON UPDATE no action;