import { getTranslations } from "next-intl/server"
import { TrendingDownIcon, TrendingUpIcon, TimerIcon, ShieldCheckIcon, InfoIcon } from "lucide-react"
import {
  foldHeadline,
  isPrecisionProvisional,
  HEADLINE_WINDOW_DAYS,
  type MetricDay,
  type MetricDisplay,
  type P50Display,
} from "@/modules/knowledge/metrics"

/** A sparkline point: a rate in [0,1] or null (no data that day), maybe provisional. */
interface Point {
  value: number | null
  provisional?: boolean
}

/**
 * Rate-series sparkline. Unlike the activity Sparkline, it plots a 0..1 rate and
 * can mark days provisional (the unsettled precision tail), which it draws hollow
 * so a not-yet-final value never reads as final.
 */
function RateSparkline({ points }: { points: Point[] }) {
  if (points.length === 0) return null
  return (
    <div className="flex h-8 items-end gap-px" aria-hidden>
      {points.map((p, i) => {
        if (p.value == null) {
          return <div key={i} className="w-full rounded-[1px] bg-foreground/10" style={{ height: "6%" }} />
        }
        const h = Math.max(8, p.value * 100)
        return (
          <div
            key={i}
            className={
              p.provisional
                ? "w-full rounded-[1px] border border-dashed border-foreground/40 bg-transparent"
                : "w-full rounded-[1px] bg-foreground/35"
            }
            style={{ height: `${h}%` }}
          />
        )
      })}
    </div>
  )
}

type T = Awaited<ReturnType<typeof getTranslations<"project">>>

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** A card whose figure is a rate, gated. */
function RateCard({
  t,
  icon,
  title,
  hint,
  display,
  points,
  provisionalNote,
}: {
  t: T
  icon: React.ReactNode
  title: string
  hint: string
  display: MetricDisplay
  points: Point[]
  provisionalNote?: string
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </div>

      {display.enough ? (
        <>
          <div className="text-2xl font-semibold tabular-nums">{pct(display.ratio)}</div>
          <p className="text-[11px] text-muted-foreground">
            {t("knowledgeLearning.sampleShort", { count: display.sample })} ·{" "}
            {t("knowledgeLearning.agentReported")}
          </p>
        </>
      ) : (
        <>
          <div className="text-sm font-medium text-muted-foreground">
            {t("knowledgeLearning.notEnoughData")}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("knowledgeLearning.belowThreshold", { threshold: display.threshold })} ·{" "}
            {t("knowledgeLearning.sampleShort", { count: display.sample })}
          </p>
        </>
      )}

      <RateSparkline points={points} />
      {provisionalNote && <p className="text-[10px] text-muted-foreground/70">{provisionalNote}</p>}
      <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
    </div>
  )
}

function P50Card({ t, display, points }: { t: T; display: P50Display; points: Point[] }) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <TimerIcon className="h-3.5 w-3.5" />
        {t("knowledgeLearning.metricP50Title")}
      </div>
      {display.enough ? (
        <>
          <div className="text-2xl font-semibold tabular-nums">
            {t("knowledgeLearning.p50Hours", { hours: Math.round(display.hours) })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("knowledgeLearning.sampleShort", { count: display.sample })} ·{" "}
            {t("knowledgeLearning.agentReported")}
          </p>
        </>
      ) : (
        <>
          <div className="text-sm font-medium text-muted-foreground">
            {t("knowledgeLearning.notEnoughData")}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("knowledgeLearning.belowThreshold", { threshold: display.threshold })} ·{" "}
            {t("knowledgeLearning.sampleShort", { count: display.sample })}
          </p>
        </>
      )}
      <RateSparkline points={points} />
      <p className="text-[11px] leading-snug text-muted-foreground/80">
        {t("knowledgeLearning.metricP50Hint")}
      </p>
    </div>
  )
}

/** Per-day rate (num/den), null when the day has no denominator. */
function rateSeries(rows: MetricDay[], num: (r: MetricDay) => number | null, den: (r: MetricDay) => number | null): Point[] {
  return rows.map((r) => {
    const d = den(r) ?? 0
    return d > 0 ? { value: (num(r) ?? 0) / d } : { value: null }
  })
}

/**
 * The Learning panel: the four compounding metrics for a project, over its own
 * data, each shown only with enough sample behind it. It renders on the server
 * and is handed already-folded figures, so all the honesty decisions live in
 * modules/knowledge/metrics and are unit-tested there.
 */
export async function LearningPanel({ rows, todayUtc }: { rows: MetricDay[]; todayUtc: string }) {
  const t = await getTranslations("project")
  const h = foldHeadline(rows, todayUtc)

  const precisionPoints: Point[] = rows.map((r) => {
    const d = r.precisionDen ?? 0
    return {
      value: d > 0 ? (r.precisionNum ?? 0) / d : null,
      provisional: isPrecisionProvisional(r.day, todayUtc),
    }
  })

  const p50Max = Math.max(1, ...rows.map((r) => r.candidateToTrustedP50Hours ?? 0))
  const p50Points: Point[] = rows.map((r) =>
    r.candidateToTrustedP50Hours == null
      ? { value: null }
      : { value: r.candidateToTrustedP50Hours / p50Max },
  )

  const versionsChanged = h.normalizationVersions.length > 1

  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("knowledgeLearning.panelTitle")}</h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            {t("knowledgeLearning.panelDescription", { days: HEADLINE_WINDOW_DAYS })}
          </p>
        </div>
        {/* Normalization version, per honesty rule 4 - a definition change is
            visible rather than silently reshaping the series. */}
        <span className="shrink-0 rounded bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
          {versionsChanged
            ? t("knowledgeLearning.normalizationChanged", { versions: h.normalizationVersions.join(", ") })
            : t("knowledgeLearning.normalizationLabel", { version: h.normalizationVersions[0] ?? 1 })}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RateCard
          t={t}
          icon={<TrendingDownIcon className="h-3.5 w-3.5" />}
          title={t("knowledgeLearning.metricRepeatErrorTitle")}
          hint={t("knowledgeLearning.metricRepeatErrorHint")}
          display={h.repeatError}
          points={rateSeries(rows, (r) => r.repeatErrorNum, (r) => r.repeatErrorDen)}
        />
        <RateCard
          t={t}
          icon={<TrendingUpIcon className="h-3.5 w-3.5" />}
          title={t("knowledgeLearning.metricRecallHitTitle")}
          hint={t("knowledgeLearning.metricRecallHitHint")}
          display={h.recallHit}
          points={rateSeries(rows, (r) => r.recallHitNum, (r) => r.recallHitDen)}
        />
        <RateCard
          t={t}
          icon={<ShieldCheckIcon className="h-3.5 w-3.5" />}
          title={t("knowledgeLearning.metricPrecisionTitle")}
          hint={t("knowledgeLearning.metricPrecisionHint")}
          display={h.precision}
          points={precisionPoints}
          provisionalNote={t("knowledgeLearning.provisionalTail", { days: 14 })}
        />
        <P50Card t={t} display={h.candidateToTrustedP50} points={p50Points} />
      </div>

      <p className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
        <InfoIcon className="h-3 w-3" />
        {t("knowledgeLearning.windowNote", { days: HEADLINE_WINDOW_DAYS })}
      </p>
    </section>
  )
}
