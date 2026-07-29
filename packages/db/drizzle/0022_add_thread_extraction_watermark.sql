CREATE TABLE "thread_extraction" (
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_extraction_project_id_thread_id_pk" PRIMARY KEY("project_id","thread_id"),
	CONSTRAINT "thread_extraction_reason_ck" CHECK ("thread_extraction"."reason" in ('extracted','purged'))
);
--> statement-breakpoint
ALTER TABLE "thread_extraction" ADD CONSTRAINT "thread_extraction_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_extraction" ADD CONSTRAINT "thread_extraction_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- BACKFILL (BUG-0010). Without this the fix does nothing for existing data: every
-- candidate written before 0022 records its thread only in knowledge.source_refs, so
-- an empty watermark table would leave purge removing the only suppression record
-- exactly as it does today. The whole pending migration set runs in one transaction
-- (drizzle-orm pg migrator), so there is no window where the table exists unpopulated.
--
-- Four guards, each for a way this aborts a migration or writes a wrong row:
--   source_kind = 'thread'  - only real extractor output means "this thread was
--     extracted". `learn` rows carry an identical {threadId} but are not extraction;
--     backfilling them would make an incidental suppression permanent.
--   jsonb_typeof(...) = 'array' - the column is plain jsonb with an array DEFAULT and
--     no CHECK, so one non-array value would make jsonb_array_elements abort the set.
--   the canonical uuid regex - a malformed value would abort the cast.
--   the join to thread on (id, project_id) - satisfies both FKs and stops a stale or
--     cross-project reference from becoming a row.
-- MATERIALIZED is load-bearing, not style: it forces each filter to run before the
-- step it guards. Inlined, the planner may reorder the expansion or the cast ahead of
-- the predicate that was supposed to protect it.
WITH arr AS MATERIALIZED (
  SELECT k.project_id, k.source_refs
    FROM knowledge k
   WHERE k.source_kind = 'thread'
     AND jsonb_typeof(k.source_refs) = 'array'
), refs AS MATERIALIZED (
  SELECT a.project_id, ref->>'threadId' AS tid
    FROM arr a
    CROSS JOIN LATERAL jsonb_array_elements(a.source_refs) AS ref
   WHERE ref ? 'threadId'
     AND ref->>'threadId' ~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
)
INSERT INTO thread_extraction (project_id, thread_id, reason)
SELECT DISTINCT r.project_id, r.tid::uuid, 'extracted'
  FROM refs r
  JOIN thread t ON t.id = r.tid::uuid AND t.project_id = r.project_id
ON CONFLICT DO NOTHING;
