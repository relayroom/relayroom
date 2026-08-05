-- Retire what the automatic thread extractor wrote, and rescue what it was confused with.
--
-- The extractor (removed in 0.7.0) turned every closed thread into a knowledge row titled
-- with the thread's SUBJECT and bodied with its last agent message, truncated to 2000
-- characters. On the production hub 288 of 289 such rows were that; the one exception was
-- a lesson an agent wrote through `close`, which until 0.7.0 stored the SAME
-- `source_kind = 'thread'`, with the same NULL created_by_user_id, the same `candidate`
-- state and the same source_refs shape. The two are not distinguishable by any column.
--
-- So this migration does not use `source_kind = 'thread'` as the predicate. It
-- RECONSTRUCTS what the extractor would have written and deletes only what matches,
-- which means three outcomes rather than two:
--
--   1. delete   - title and body are byte-for-byte what the extractor produces
--   2. relabel  - the title is not the thread's subject, so an agent wrote it -> 'lesson'
--   3. leave    - anything we cannot attribute stays exactly as it is
--
-- The asymmetry is deliberate. Deleting an agent's lesson is irreversible; leaving a
-- junk row is visible and can be purged by hand. Every uncertain case therefore lands in
-- (3): a row whose thread has since been deleted, or whose body was redacted at
-- extraction time and no longer matches the message it came from, keeps `source_kind =
-- 'thread'` and is left alone. `thread` therefore survives as a historical value with no
-- writer - which is what the schema comment on source_kind now says.

-- (1) Delete the provable extractor output, and the watermark that recorded it.
--
-- `kind = 'decision'` is part of the signature: the extractor hard-coded it (KIND_HEURISTIC)
-- while `close` takes the agent's choice. It is not sufficient alone and is not used alone.
--
-- The body reconstruction mirrors extract.ts exactly - the last message with an agent
-- author, trimmed, first 2000 characters. A project with redaction rules configured will
-- not match (the stored text had spans removed); that row falls to (3) rather than being
-- deleted on a partial match.
--
-- trusted / promoted rows are EXCLUDED. On the hub measured before this migration that
-- branch selects nothing - no auto-extracted row was ever promoted - but a deployment
-- where a human looked at one of these and promoted it is a deployment where a person's
-- judgement is more specific than ours, and later than it.
CREATE TEMP TABLE auto_extracted AS
SELECT k.id, k.project_id, (k.source_refs->0->>'threadId')::uuid AS thread_id
  FROM knowledge k
  JOIN thread t ON t.id = (k.source_refs->0->>'threadId')::uuid
                AND t.project_id = k.project_id
 WHERE k.source_kind = 'thread'
   AND k.kind = 'decision'
   AND k.validation_state <> 'trusted'
   AND k.promoted_at IS NULL
   AND jsonb_typeof(k.source_refs) = 'array'
   AND k.source_refs->0 ? 'threadId'
   AND (k.source_refs->0->>'threadId') ~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND k.title = CASE WHEN btrim(t.subject) = '' THEN '(redacted)' ELSE btrim(t.subject) END
   AND k.body = left(btrim((
         SELECT m.body FROM message m
          WHERE m.thread_id = t.id AND m.from_agent_id IS NOT NULL
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
       )), 2000);
--> statement-breakpoint
DELETE FROM knowledge k USING auto_extracted a WHERE k.id = a.id;
--> statement-breakpoint
-- The watermark goes with it. Left behind, it would mean "this thread's knowledge is
-- decided" for a thread whose row we just deleted - and `close` reads exactly that to
-- refuse a lesson, so every one of these threads would be unable to receive the lesson
-- that replaces what we removed. Only `extracted` is cleared: a `purged` mark is an
-- operator's decision and is not ours to undo.
DELETE FROM thread_extraction te
 USING auto_extracted a
 WHERE te.project_id = a.project_id AND te.thread_id = a.thread_id AND te.reason = 'extracted';
--> statement-breakpoint
-- (2) Rescue the lessons. A row still labelled 'thread' whose title is NOT the thread's
-- subject was written by an agent through `close` - the extractor had no other title to
-- give. Positively identified rather than "whatever is left": rows whose thread is gone
-- cannot be attributed either way and are not touched.
UPDATE knowledge k
   SET source_kind = 'lesson'
  FROM thread t
 WHERE k.source_kind = 'thread'
   AND jsonb_typeof(k.source_refs) = 'array'
   AND k.source_refs->0 ? 'threadId'
   AND (k.source_refs->0->>'threadId') ~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND t.id = (k.source_refs->0->>'threadId')::uuid
   AND t.project_id = k.project_id
   AND k.title <> CASE WHEN btrim(t.subject) = '' THEN '(redacted)' ELSE btrim(t.subject) END;
--> statement-breakpoint
DROP TABLE auto_extracted;
