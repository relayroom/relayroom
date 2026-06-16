import { sql } from "drizzle-orm";
// Subpath import (not the "@relayroom/db" barrel) so web's Turbopack build never
// transitively pulls migrate.ts.
import type { Db } from "@relayroom/db/client";

/** Per-day usage rollup. Matches the HQ collector's BeaconSchema rollup shape.
 *  All sizes are coarse BUCKETS/counts, never raw content. */
export interface Rollup {
  day: string; // UTC calendar day, YYYY-MM-DD
  projectsBucket?: string;
  agentsBucket?: string;
  activeAgentsBucket?: string;
  msgsBucket?: string;
  channelsUsed?: boolean;
  pagerUsed?: boolean;
  wakeLoops?: number;
  tokenInBucket?: string;
  tokenOutBucket?: string;
  modelFamilies?: Record<string, number>;
}

function sizeBucket(n: number): string {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  return "100+";
}

function tokenBucket(n: number): string {
  if (n <= 0) return "0";
  if (n < 10_000) return "<10K";
  if (n < 100_000) return "10K-100K";
  if (n < 1_000_000) return "100K-1M";
  return "1M+";
}

/** Map a specific model id to its provider FAMILY (no specific ids leave here). */
function modelFamily(model: string): "claude" | "codex" | "gemini" | "other" {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gpt") || m.includes("codex") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "codex";
  if (m.includes("gemini")) return "gemini";
  return "other";
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the daily rollups to send, given the last successfully-sent day
 * (watermark, or null for a first send). Returns the rollups and the newest day
 * they cover (`upTo`) so the caller advances the watermark only on a successful
 * send. Derived from the core DB, so resending is idempotent.
 *
 * Only COMPLETED UTC days (up to yesterday) are emitted. Per-day activity
 * (messages, wake-loop trips, tokens, model families) is exact; the instance-size
 * snapshot (projects/agents/active/pager) is the current value applied to each
 * day in the window - coarse on purpose, since these change slowly.
 */
export async function computeRollups(
  db: Db,
  watermark: string | null,
): Promise<{ rollups: Rollup[]; upTo: string | null }> {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayUTC = utcDay(yesterday);
  const todayUTC = utcDay(now);

  let start = new Date(now);
  if (watermark) {
    start = new Date(`${watermark}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
  } else {
    start.setUTCDate(start.getUTCDate() - 30); // first send: last 30 days
  }
  const startUTC = utcDay(start);
  if (startUTC > yesterdayUTC) return { rollups: [], upTo: null };

  const since = `${startUTC}T00:00:00.000Z`;
  const until = `${todayUTC}T00:00:00.000Z`; // exclusive: completed days only

  type Row = Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0);

  const msgRows = (await db.execute(sql`
    SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
    FROM message WHERE created_at >= ${since} AND created_at < ${until} GROUP BY 1`)) as unknown as Row[];
  const wakeRows = (await db.execute(sql`
    SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
    FROM wake_event WHERE reason = 'loop_breaker' AND created_at >= ${since} AND created_at < ${until} GROUP BY 1`)) as unknown as Row[];
  const tokRows = (await db.execute(sql`
    SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
           coalesce(sum((usage->>'input_tokens')::bigint), 0)::bigint AS tin,
           coalesce(sum((usage->>'output_tokens')::bigint), 0)::bigint AS tout
    FROM event WHERE usage IS NOT NULL AND created_at >= ${since} AND created_at < ${until} GROUP BY 1`)) as unknown as Row[];
  const modelRows = (await db.execute(sql`
    SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, usage->>'model' AS model, count(*)::int AS n
    FROM event WHERE usage->>'model' IS NOT NULL AND created_at >= ${since} AND created_at < ${until} GROUP BY 1, 2`)) as unknown as Row[];

  const snapRows = (await db.execute(sql`
    SELECT (SELECT count(*) FROM project WHERE archived_at IS NULL)::int AS projects,
           (SELECT count(*) FROM agent WHERE deleted_at IS NULL)::int AS agents,
           (SELECT count(*) FROM agent WHERE deleted_at IS NULL AND last_seen_at >= now() - interval '7 days')::int AS active,
           (SELECT count(*) FROM agent_connection WHERE machine_label IS NOT NULL)::int AS pager`)) as unknown as Row[];
  const snap = snapRows[0] ?? {};
  const projects = num(snap.projects);
  const agents = num(snap.agents);
  const active = num(snap.active);
  const pagerUsed = num(snap.pager) > 0;

  const msgs = new Map<string, number>();
  for (const r of msgRows) msgs.set(String(r.day), num(r.n));
  const wakes = new Map<string, number>();
  for (const r of wakeRows) wakes.set(String(r.day), num(r.n));
  const tokens = new Map<string, { tin: number; tout: number }>();
  for (const r of tokRows) tokens.set(String(r.day), { tin: num(r.tin), tout: num(r.tout) });
  const families = new Map<string, Record<string, number>>();
  for (const r of modelRows) {
    const day = String(r.day);
    const fam = modelFamily(String(r.model ?? ""));
    const acc = families.get(day) ?? {};
    acc[fam] = (acc[fam] ?? 0) + num(r.n);
    families.set(day, acc);
  }

  // Emit only days that had activity (avoid a wall of zero-rows on idle installs);
  // the instance beacon still covers active-instance/version even with no rollups.
  const rollups: Rollup[] = [];
  const cursor = new Date(`${startUTC}T00:00:00Z`);
  const endTime = new Date(`${yesterdayUTC}T00:00:00Z`).getTime();
  while (cursor.getTime() <= endTime) {
    const day = utcDay(cursor);
    const m = msgs.get(day) ?? 0;
    const tok = tokens.get(day);
    const w = wakes.get(day) ?? 0;
    const fam = families.get(day);
    const hasActivity = m > 0 || w > 0 || (tok && (tok.tin > 0 || tok.tout > 0)) || fam;
    if (hasActivity) {
      rollups.push({
        day,
        projectsBucket: sizeBucket(projects),
        agentsBucket: sizeBucket(agents),
        activeAgentsBucket: sizeBucket(active),
        msgsBucket: sizeBucket(m),
        pagerUsed,
        wakeLoops: w,
        tokenInBucket: tokenBucket(tok?.tin ?? 0),
        tokenOutBucket: tokenBucket(tok?.tout ?? 0),
        ...(fam ? { modelFamilies: fam } : {}),
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { rollups, upTo: yesterdayUTC };
}
