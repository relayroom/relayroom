CREATE TABLE "direct_cooldown" (
	"project_id" uuid NOT NULL,
	"sender_agent_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_cooldown_sender_agent_id_recipient_agent_id_pk" PRIMARY KEY("sender_agent_id","recipient_agent_id")
);
--> statement-breakpoint
ALTER TABLE "project_access" ADD COLUMN "capabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_cooldown" ADD CONSTRAINT "direct_cooldown_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_cooldown" ADD CONSTRAINT "direct_cooldown_sender_agent_id_agent_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_cooldown" ADD CONSTRAINT "direct_cooldown_recipient_agent_id_agent_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_cooldown_last_idx" ON "direct_cooldown" USING btree ("last_at");