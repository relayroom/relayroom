import { sql } from "drizzle-orm"
import type { ApiResultWithItem } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsageDay {
  /** YYYY-MM-DD (UTC day bucket). */
  day: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  costUsd: number
}

export interface UsageByModel {
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  costUsd: number
}

export interface UsageSeries {
  days: UsageDay[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalTokens: number
  totalCostUsd: number
  windowDays: number
  byModel: UsageByModel[]
}

interface UsageRow {
  day: string
  input_tokens: string | number
  output_tokens: string | number
  cache_tokens: string | number
  cost_usd: string | number
}

interface UsageByModelRow {
  model: string
  input_tokens: string | number
  output_tokens: string | number
  cache_tokens: string | number
  cost_usd: string | number
}

/** Map zero-filled aggregate rows into a UsageSeries with totals. */
function toSeries(rows: UsageRow[], windowDays: number, modelRows: UsageByModelRow[]): UsageSeries {
  const days: UsageDay[] = rows.map((r) => ({
    day: r.day,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheTokens: Number(r.cache_tokens),
    costUsd: Number(r.cost_usd),
  }))
  const totalInputTokens = days.reduce((s, d) => s + d.inputTokens, 0)
  const totalOutputTokens = days.reduce((s, d) => s + d.outputTokens, 0)
  const totalCacheTokens = days.reduce((s, d) => s + d.cacheTokens, 0)
  const totalCostUsd = days.reduce((s, d) => s + d.costUsd, 0)
  const byModel: UsageByModel[] = modelRows.map((r) => {
    const inputTokens = Number(r.input_tokens)
    const outputTokens = Number(r.output_tokens)
    const cacheTokens = Number(r.cache_tokens)
    return {
      model: r.model,
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: inputTokens + outputTokens + cacheTokens,
      costUsd: Number(r.cost_usd),
    }
  })
  return {
    days,
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens,
    totalTokens: totalInputTokens + totalOutputTokens + totalCacheTokens,
    totalCostUsd,
    windowDays,
    byModel,
  }
}

// ── getUsageSeries ──────────────────────────────────────────────────────────────

/**
 * Daily token/cost usage for an org over the last `windowDays` days.
 *
 * Aggregates event.usage (jsonb) across the org's projects, bucketed by UTC day.
 * A generate_series spine zero-fills days with no activity, so the result always
 * has exactly `windowDays` rows in chronological order (oldest first) — the chart
 * never has to reason about gaps.
 */
export async function getUsageSeries(
  orgId: string,
  windowDays = 14,
): Promise<ApiResultWithItem<UsageSeries>> {
  try {
    const [result, modelResult] = await Promise.all([
      db.execute(sql`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM generate_series(
          date_trunc('day', now()) - make_interval(days => ${windowDays - 1}),
          date_trunc('day', now()),
          interval '1 day'
        ) AS d(day)
        LEFT JOIN event e
          ON date_trunc('day', e.created_at) = d.day
         AND e.usage IS NOT NULL
         AND e.project_id IN (
           SELECT id FROM project WHERE organization_id = ${orgId}
         )
        GROUP BY d.day
        ORDER BY d.day
      `),
      db.execute(sql`
        SELECT
          COALESCE(NULLIF(e.usage->>'model', ''), 'unknown') AS model,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM event e
        WHERE e.usage IS NOT NULL
          AND e.created_at >= now() - make_interval(days => ${windowDays})
          AND e.project_id IN (
            SELECT id FROM project WHERE organization_id = ${orgId}
          )
        GROUP BY 1
        ORDER BY (SUM((e.usage->>'input_tokens')::numeric) + SUM((e.usage->>'output_tokens')::numeric)) DESC
      `),
    ])

    const rows = (result.rows ?? []) as unknown as UsageRow[]
    const modelRows = (modelResult.rows ?? []) as unknown as UsageByModelRow[]
    return { result: true, item: toSeries(rows, windowDays, modelRows) }
  } catch (err) {
    console.error("[getUsageSeries]", err)
    return { result: false, message: "사용량 정보를 불러오는 데 실패했습니다." }
  }
}

/**
 * Daily token/cost usage for a single project over the last `windowDays` days.
 * Same zero-filled shape as getUsageSeries, scoped to one project.
 */
export async function getUsageSeriesForProject(
  projectId: string,
  windowDays = 14,
): Promise<ApiResultWithItem<UsageSeries>> {
  try {
    const [result, modelResult] = await Promise.all([
      db.execute(sql`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM generate_series(
          date_trunc('day', now()) - make_interval(days => ${windowDays - 1}),
          date_trunc('day', now()),
          interval '1 day'
        ) AS d(day)
        LEFT JOIN event e
          ON date_trunc('day', e.created_at) = d.day
         AND e.usage IS NOT NULL
         AND e.project_id = ${projectId}
        GROUP BY d.day
        ORDER BY d.day
      `),
      db.execute(sql`
        SELECT
          COALESCE(NULLIF(e.usage->>'model', ''), 'unknown') AS model,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM event e
        WHERE e.usage IS NOT NULL
          AND e.created_at >= now() - make_interval(days => ${windowDays})
          AND e.project_id = ${projectId}
        GROUP BY 1
        ORDER BY (SUM((e.usage->>'input_tokens')::numeric) + SUM((e.usage->>'output_tokens')::numeric)) DESC
      `),
    ])

    const rows = (result.rows ?? []) as unknown as UsageRow[]
    const modelRows = (modelResult.rows ?? []) as unknown as UsageByModelRow[]
    return { result: true, item: toSeries(rows, windowDays, modelRows) }
  } catch (err) {
    console.error("[getUsageSeriesForProject]", err)
    return { result: false, message: "사용량 정보를 불러오는 데 실패했습니다." }
  }
}

// ── Detailed project usage (date range + per-agent overlay) ──────────────────

export interface UsageAgentTotal {
  part: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  costUsd: number
}

/** Per-day token totals broken out by agent part (for the stacked overlay). */
export interface UsageDayAgents {
  day: string
  /** agent part -> total tokens that day */
  perAgent: Record<string, number>
}

export interface ProjectUsageDetail {
  from: string
  to: string
  /** Earliest day with recorded usage (for the "All" preset); null if none. */
  firstDay: string | null
  days: UsageDay[]
  dayAgents: UsageDayAgents[]
  agents: UsageAgentTotal[]
  byModel: UsageByModel[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalTokens: number
  totalCostUsd: number
}

/**
 * Full usage detail for one project over an explicit [from, to] day range
 * (inclusive, YYYY-MM-DD). Daily totals are zero-filled across the range; usage
 * is also broken out per model and per agent, plus a per-day-per-agent matrix
 * for the overlaid chart. Backs the project Usage tab.
 */
export async function getProjectUsageDetail(
  projectId: string,
  from: string,
  to: string,
): Promise<ApiResultWithItem<ProjectUsageDetail>> {
  try {
    const [dayRes, modelRes, agentRes, dayAgentRes, boundsRes] = await Promise.all([
      db.execute(sql`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d(day)
        LEFT JOIN event e
          ON date_trunc('day', e.created_at) = d.day
         AND e.usage IS NOT NULL
         AND e.project_id = ${projectId}
        GROUP BY d.day
        ORDER BY d.day
      `),
      db.execute(sql`
        SELECT
          COALESCE(NULLIF(e.usage->>'model', ''), 'unknown') AS model,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM event e
        WHERE e.usage IS NOT NULL
          AND e.project_id = ${projectId}
          AND e.created_at >= ${from}::date
          AND e.created_at < (${to}::date + 1)
        GROUP BY 1
        ORDER BY (SUM((e.usage->>'input_tokens')::numeric) + SUM((e.usage->>'output_tokens')::numeric)) DESC
      `),
      db.execute(sql`
        SELECT
          a.part AS part,
          COALESCE(SUM((e.usage->>'input_tokens')::numeric), 0) AS input_tokens,
          COALESCE(SUM((e.usage->>'output_tokens')::numeric), 0) AS output_tokens,
          COALESCE(SUM((e.usage->>'cache_tokens')::numeric), 0) AS cache_tokens,
          COALESCE(SUM((e.usage->>'cost_usd')::numeric), 0) AS cost_usd
        FROM event e
        JOIN agent a ON a.id = e.agent_id
        WHERE e.usage IS NOT NULL
          AND e.project_id = ${projectId}
          AND e.created_at >= ${from}::date
          AND e.created_at < (${to}::date + 1)
        GROUP BY a.part
        ORDER BY (SUM((e.usage->>'input_tokens')::numeric) + SUM((e.usage->>'output_tokens')::numeric) + SUM((e.usage->>'cache_tokens')::numeric)) DESC
      `),
      db.execute(sql`
        SELECT
          to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') AS day,
          a.part AS part,
          COALESCE(SUM(
            COALESCE((e.usage->>'input_tokens')::numeric, 0)
            + COALESCE((e.usage->>'output_tokens')::numeric, 0)
            + COALESCE((e.usage->>'cache_tokens')::numeric, 0)
          ), 0) AS total_tokens
        FROM event e
        JOIN agent a ON a.id = e.agent_id
        WHERE e.usage IS NOT NULL
          AND e.project_id = ${projectId}
          AND e.created_at >= ${from}::date
          AND e.created_at < (${to}::date + 1)
        GROUP BY 1, 2
      `),
      db.execute(sql`
        SELECT to_char(MIN(date_trunc('day', created_at)), 'YYYY-MM-DD') AS first_day
        FROM event
        WHERE usage IS NOT NULL AND project_id = ${projectId}
      `),
    ])

    const dayRows = (dayRes.rows ?? []) as unknown as UsageRow[]
    const modelRows = (modelRes.rows ?? []) as unknown as UsageByModelRow[]
    const agentRows = (agentRes.rows ?? []) as unknown as UsageByModelRow[] & { part: string }[]
    const dayAgentRows = (dayAgentRes.rows ?? []) as unknown as { day: string; part: string; total_tokens: string | number }[]
    const firstDay = ((boundsRes.rows ?? [])[0] as { first_day: string | null } | undefined)?.first_day ?? null

    const series = toSeries(dayRows, dayRows.length, modelRows)

    const agents: UsageAgentTotal[] = (agentRows as unknown as Array<{ part: string; input_tokens: string | number; output_tokens: string | number; cache_tokens: string | number; cost_usd: string | number }>).map((r) => {
      const inputTokens = Number(r.input_tokens)
      const outputTokens = Number(r.output_tokens)
      const cacheTokens = Number(r.cache_tokens)
      return {
        part: r.part,
        inputTokens,
        outputTokens,
        cacheTokens,
        totalTokens: inputTokens + outputTokens + cacheTokens,
        costUsd: Number(r.cost_usd),
      }
    })

    // Build a per-day-per-agent matrix aligned to the zero-filled day spine.
    const byDay = new Map<string, Record<string, number>>()
    for (const r of dayAgentRows) {
      const m = byDay.get(r.day) ?? {}
      m[r.part] = (m[r.part] ?? 0) + Number(r.total_tokens)
      byDay.set(r.day, m)
    }
    const dayAgents: UsageDayAgents[] = series.days.map((d) => ({
      day: d.day,
      perAgent: byDay.get(d.day) ?? {},
    }))

    return {
      result: true,
      item: {
        from,
        to,
        firstDay,
        days: series.days,
        dayAgents,
        agents,
        byModel: series.byModel,
        totalInputTokens: series.totalInputTokens,
        totalOutputTokens: series.totalOutputTokens,
        totalCacheTokens: series.totalCacheTokens,
        totalTokens: series.totalTokens,
        totalCostUsd: series.totalCostUsd,
      },
    }
  } catch (err) {
    console.error("[getProjectUsageDetail]", err)
    return { result: false, message: "사용량 정보를 불러오는 데 실패했습니다." }
  }
}
