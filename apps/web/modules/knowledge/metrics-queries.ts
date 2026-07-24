import { and, desc, eq, gte } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { knowledgeMetricDaily } from "@relayroom/db/schema"
import { HEADLINE_WINDOW_DAYS, type MetricDay } from "./metrics"

/**
 * The last HEADLINE_WINDOW_DAYS of rolled-up metrics for a project, oldest first.
 *
 * Read-only over the rollup table: the job (server) computes and writes these
 * rows; the panel only reads and gates them. Returns whatever days exist in the
 * window - it may be sparser than the window length, which the gating treats as
 * simply less sample, never as zeros.
 */
export async function getMetricWindow(projectId: string): Promise<MetricDay[]> {
  const from = new Date()
  from.setUTCDate(from.getUTCDate() - (HEADLINE_WINDOW_DAYS - 1))
  const fromDay = from.toISOString().slice(0, 10)

  const rows = await db
    .select({
      day: knowledgeMetricDaily.day,
      normalizationVersion: knowledgeMetricDaily.normalizationVersion,
      repeatErrorNum: knowledgeMetricDaily.repeatErrorNum,
      repeatErrorDen: knowledgeMetricDaily.repeatErrorDen,
      recallHitNum: knowledgeMetricDaily.recallHitNum,
      recallHitDen: knowledgeMetricDaily.recallHitDen,
      precisionNum: knowledgeMetricDaily.precisionNum,
      precisionDen: knowledgeMetricDaily.precisionDen,
      candidateToTrustedP50Hours: knowledgeMetricDaily.candidateToTrustedP50Hours,
      trustedCount: knowledgeMetricDaily.trustedCount,
      candidateCount: knowledgeMetricDaily.candidateCount,
    })
    .from(knowledgeMetricDaily)
    .where(
      and(
        eq(knowledgeMetricDaily.projectId, projectId),
        gte(knowledgeMetricDaily.day, fromDay),
      ),
    )
    .orderBy(desc(knowledgeMetricDaily.day))

  // `day` is a date column; drizzle returns it as a "YYYY-MM-DD" string. Reverse
  // to oldest-first so the aggregation and sparkline read left-to-right in time.
  return rows.reverse() as MetricDay[]
}
