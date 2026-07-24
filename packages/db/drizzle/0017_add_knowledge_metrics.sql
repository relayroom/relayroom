CREATE TABLE "knowledge_metric_daily" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"normalization_version" integer DEFAULT 1 NOT NULL,
	"repeat_error_num" integer,
	"repeat_error_den" integer,
	"recall_hit_num" integer,
	"recall_hit_den" integer,
	"precision_num" integer,
	"precision_den" integer,
	"candidate_to_trusted_p50_hours" real,
	"trusted_count" integer,
	"candidate_count" integer,
	CONSTRAINT "knowledge_metric_daily_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
ALTER TABLE "knowledge_metric_daily" ADD CONSTRAINT "knowledge_metric_daily_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;