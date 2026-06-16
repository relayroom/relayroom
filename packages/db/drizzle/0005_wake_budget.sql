CREATE TABLE "governance_alert" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_user_id" text,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owner_wake_budget" (
	"user_id" text PRIMARY KEY NOT NULL,
	"wakes_per_hour" integer DEFAULT 30 NOT NULL,
	"urgent_per_hour" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wake_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_user_id" text,
	"agent_id" uuid,
	"project_id" uuid,
	"wake_intent_id" uuid,
	"sender_part" text,
	"sender_user_id" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"phantom" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wake_intent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"epoch" integer NOT NULL,
	"wake_id" uuid DEFAULT uuidv7() NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"reason" text,
	"lease_holder" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "activation_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "wake_watermark_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "recipient_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_access" ADD COLUMN "banned_by_user_id" text;--> statement-breakpoint
ALTER TABLE "project_access" ADD COLUMN "wake_priority" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "max_broadcast_recipients" integer;--> statement-breakpoint
ALTER TABLE "governance_alert" ADD CONSTRAINT "governance_alert_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_alert" ADD CONSTRAINT "governance_alert_subject_user_id_better_auth_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_wake_budget" ADD CONSTRAINT "owner_wake_budget_user_id_better_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_event" ADD CONSTRAINT "wake_event_owner_user_id_better_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_event" ADD CONSTRAINT "wake_event_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_event" ADD CONSTRAINT "wake_event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_intent" ADD CONSTRAINT "wake_intent_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_intent" ADD CONSTRAINT "wake_intent_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_intent" ADD CONSTRAINT "wake_intent_owner_user_id_better_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_alert_project_created_idx" ON "governance_alert" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "wake_event_owner_created_idx" ON "wake_event" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "wake_event_sender_created_idx" ON "wake_event" USING btree ("sender_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wake_intent_agent_active" ON "wake_intent" USING btree ("agent_id") WHERE state in ('pending','delivered','activated');--> statement-breakpoint
CREATE INDEX "wake_intent_owner_reserved_idx" ON "wake_intent" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "wake_intent_state_expires_idx" ON "wake_intent" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_banned_by_user_id_better_auth_user_id_fk" FOREIGN KEY ("banned_by_user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE set null ON UPDATE no action;