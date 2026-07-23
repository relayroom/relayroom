import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
// Import from non-barrel subpaths (not "@relayroom/db") so consumers - notably
// the web app's Turbopack build - never pull the db barrel, which transitively
// loads migrate.ts (a runtime-only, server/CLI migration path).
import { configurations } from "@relayroom/db/schema";
import type { Db, DbOrTx } from "@relayroom/db/client";

// Stable lock key for serializing first-creates of global telemetry config.
// pg_advisory_xact_lock keys are bigints; this is an arbitrary telemetry-namespace
// constant (not derived at runtime, so all processes agree).
const ADVISORY_LOCK_KEY = 728_413_001;
import { computeRollups, type Rollup } from "./aggregate";

/**
 * CE telemetry client (backlog F1). Sends anonymous, content-free beacons to the
 * RelayRoom HQ collector so we can see adoption (instance count, version) and
 * coarse usage buckets. Privacy rules:
 *  - CONTENT 0: never message bodies, prompts, responses, names, tokens-as-text.
 *  - ANONYMOUS by default: with no admin choice recorded, beacons are sent but
 *    carry no install id, so they cannot be linked across time. An admin can opt
 *    into `community` (adds a stable install id) or `off` (sends nothing).
 *  - FAILURE HARMLESS: every send is timeout-bounded and never throws; telemetry
 *    must never affect the running hub.
 *  - WATERMARK BACKFILL: per-day rollups are recomputed from the core DB, so a
 *    collector outage just means the next tick resends the missed days.
 */

const ENDPOINT =
  process.env.RELAYROOM_TELEMETRY_URL ?? "https://relayroom.dev/api/telemetry";
const CE_VERSION = process.env.RELAYROOM_VERSION ?? "0.3.2";
const EDITION = (process.env.RELAYROOM_EDITION ?? "ce") as "ce" | "ee";
const SEND_TIMEOUT_MS = 8_000;
const TICK_MS = 24 * 60 * 60 * 1000; // 24h

// Three states. `anonymous` is the DEFAULT (on, content-free, no install id);
// `community` adds a stable install id (dedup + longitudinal); `off` sends nothing.
export type TelemetryMode = "anonymous" | "community" | "off";

// ── config (configurations table, global scope) ────────────────────────────
const KEY_INSTANCE = "telemetry_instance_id";
const KEY_MODE = "telemetry_mode";
const KEY_WATERMARK = "telemetry_watermark";

async function getGlobal(db: DbOrTx, key: string): Promise<unknown> {
  // The unique index on (scope, scopeId, key) does NOT constrain global rows,
  // because scopeId is NULL there and Postgres treats NULLs as distinct. So a
  // duplicate global row is possible under a race; ORDER BY makes the read
  // deterministic (newest wins) instead of returning an arbitrary row.
  const [row] = await db
    .select({ value: configurations.value })
    .from(configurations)
    .where(and(eq(configurations.scope, "global"), isNull(configurations.scopeId), eq(configurations.key, key)))
    .orderBy(desc(configurations.updatedAt))
    .limit(1);
  return row?.value;
}

async function setGlobal(db: DbOrTx, key: string, value: unknown): Promise<void> {
  // Global rows are not covered by the (scope, scopeId, key) unique index (NULL
  // scopeId), so this is update-then-insert. Concurrent first-writes to the SAME
  // key are serialized by callers that need atomicity (getInstanceId); mode and
  // watermark are last-write-wins, where a rare duplicate is harmless.
  const updated = await db
    .update(configurations)
    .set({ value, updatedAt: new Date() })
    .where(and(eq(configurations.scope, "global"), isNull(configurations.scopeId), eq(configurations.key, key)))
    .returning({ id: configurations.id });
  if (updated.length === 0) {
    await db.insert(configurations).values({ scope: "global", scopeId: null, key, value });
  }
}

/** Stable per-install id (created once). Identifies an install across beacons so
 *  the collector can de-dupe; it is NOT a person/machine identifier. A duplicate
 *  id would inflate the instance count, so create-once is made atomic with a
 *  transaction-scoped advisory lock + recheck rather than a plain insert. */
export async function getInstanceId(db: Db): Promise<string> {
  const existing = await getGlobal(db, KEY_INSTANCE);
  if (typeof existing === "string") return existing;
  return db.transaction(async (tx) => {
    // Serialize concurrent first-creates; the lock releases at txn end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
    const again = await getGlobal(tx, KEY_INSTANCE);
    if (typeof again === "string") return again;
    const id = randomUUID();
    await tx.insert(configurations).values({ scope: "global", scopeId: null, key: KEY_INSTANCE, value: id });
    return id;
  });
}

export async function getMode(db: Db): Promise<TelemetryMode> {
  const v = await getGlobal(db, KEY_MODE);
  // Default ON in `anonymous` when no explicit choice has been made: content-free
  // and with no install id. An admin can opt into `community` or turn it `off`.
  return v === "community" ? "community" : v === "off" ? "off" : "anonymous";
}

export async function setMode(db: Db, mode: TelemetryMode): Promise<void> {
  await setGlobal(db, KEY_MODE, mode);
}

/** True once an admin has explicitly chosen a mode. Until then the consent banner
 *  should prompt; the default in the meantime is `anonymous` (content-free, no id),
 *  so the prompt is an upgrade/opt-out, not a precondition for any data. */
export async function isModeChosen(db: Db): Promise<boolean> {
  return (await getGlobal(db, KEY_MODE)) !== undefined;
}

async function getWatermark(db: Db): Promise<string | null> {
  const v = await getGlobal(db, KEY_WATERMARK);
  return typeof v === "string" ? v : null;
}

// ── send (HTTP, timeout-bounded, never throws) ──────────────────────────────
async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function uptimeBucket(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return "<1h";
  if (h < 24) return "1-24h";
  if (h < 24 * 7) return "1-7d";
  return "7d+";
}

export interface FeedbackPayload {
  rating?: number;
  message: string;
  contact?: string;
}

/** Dashboard feedback. Unlike the passive beacon, this is an explicit user action
 *  with a per-submission disclosure in the UI, so it sends regardless of telemetry
 *  mode (even when `off`, a user can still choose to report a bug). The install id is
 *  attached only in `community` mode so the maintainer can follow up; in
 *  anonymous/off the feedback stays unlinkable. The UI discloses what is sent. */
export async function sendFeedback(db: Db, payload: FeedbackPayload): Promise<boolean> {
  const instanceId = (await getMode(db)) === "community" ? await getInstanceId(db) : undefined;
  return post("/feedback", { ...(instanceId ? { instanceId } : {}), version: CE_VERSION, ...payload });
}

// ── tick + scheduler ────────────────────────────────────────────────────────

/** One telemetry cycle: if opted in, send a beacon (instance meta + the days
 *  missed since the watermark) and advance the watermark only on success. */
export async function runTelemetryTick(db: Db): Promise<void> {
  try {
    const mode = await getMode(db);
    if (mode === "off") return;
    // `community` attaches a stable install id (dedup + longitudinal); `anonymous`
    // omits it so beacons cannot be linked across time. Both are content-free.
    const instanceId = mode === "community" ? await getInstanceId(db) : undefined;
    const watermark = await getWatermark(db);
    let rollups: Rollup[] = [];
    let upTo: string | null = null;
    try {
      const out = await computeRollups(db, watermark);
      rollups = out.rollups;
      upTo = out.upTo;
    } catch {
      rollups = []; // a rollup failure must not block the instance beacon
    }
    const ok = await post("/beacon", {
      ...(instanceId ? { instanceId } : {}),
      anonymous: mode === "anonymous",
      version: CE_VERSION,
      edition: EDITION,
      os: process.platform,
      uptimeBucket: uptimeBucket(process.uptime()),
      ...(rollups.length ? { rollups } : {}),
    });
    // Advance the watermark only when the collector accepted the rollups.
    if (ok && upTo) await setGlobal(db, KEY_WATERMARK, upTo);
  } catch {
    // never throw out of telemetry
  }
}

/** Start the periodic telemetry loop. Always schedules (cheap) so toggling the
 *  mode on later takes effect without a restart; the tick itself no-ops when off.
 *  Returns a stop function. */
export function startTelemetry(db: Db): { stop: () => void } {
  // Kick once shortly after boot, then every 24h.
  const kick = setTimeout(() => void runTelemetryTick(db), 60_000);
  const timer = setInterval(() => void runTelemetryTick(db), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  if (typeof kick.unref === "function") kick.unref();
  return {
    stop: () => {
      clearTimeout(kick);
      clearInterval(timer);
    },
  };
}
