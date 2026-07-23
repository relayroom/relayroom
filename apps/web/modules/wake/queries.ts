import { and, count, desc, eq, gte, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { wakeEvents, ownerWakeBudgets, projects, agents } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { getErrorTranslations } from "@/lib/action-i18n"

// Spec §15.1 defaults applied when an owner has not set a budget yet.
const DEFAULT_WAKES_PER_HOUR = 30
const DEFAULT_URGENT_PER_HOUR = 5

export interface OwnerWakeBudget {
  wakesPerHour: number
  urgentPerHour: number
  /** true = no row yet, the spec §15.1 defaults are in effect. */
  isDefault: boolean
}

/**
 * Current budget for the logged-in owner, seeding the sliders. No row means the
 * owner has never configured it, so the spec §15.1 defaults (30/5) are returned
 * with isDefault=true.
 */
export async function getOwnerWakeBudget(
  userId: string,
): Promise<ApiResultWithItem<OwnerWakeBudget>> {
  const t = await getErrorTranslations()
  try {
    const [row] = await db
      .select({
        wakesPerHour: ownerWakeBudgets.wakesPerHour,
        urgentPerHour: ownerWakeBudgets.urgentPerHour,
      })
      .from(ownerWakeBudgets)
      .where(eq(ownerWakeBudgets.userId, userId))
      .limit(1)

    if (!row) {
      return {
        result: true,
        item: {
          wakesPerHour: DEFAULT_WAKES_PER_HOUR,
          urgentPerHour: DEFAULT_URGENT_PER_HOUR,
          isDefault: true,
        },
      }
    }
    return {
      result: true,
      item: {
        wakesPerHour: Number(row.wakesPerHour),
        urgentPerHour: Number(row.urgentPerHour),
        isDefault: false,
      },
    }
  } catch (err) {
    console.error("[getOwnerWakeBudget]", err)
    return { result: false, message: t("wake.budgetLoadFailed") }
  }
}

export interface WakeAuditRow {
  id: string
  createdAt: Date
  senderPart: string | null
  senderUserId: string | null
  senderName: string | null
  projectId: string | null
  projectName: string | null
  agentId: string | null
  agentPart: string | null
  urgent: boolean
  /** true = budget-exhausted suppression (no nudge fired) - NOT a charged consume. */
  suppressed: boolean
}

export interface WakeAuditSummary {
  total: number
  urgentCount: number
  suppressedCount: number
  windowHours: number
}

/**
 * Audit (spec §10.6, §11): "who consumed my wake budget". Returns ONLY the
 * logged-in owner's wakeEvents (ownerUserId === userId) within the window, newest
 * first. The `ownerUserId = userId` predicate is the SOLE isolation gate - no
 * other owner's events can leak in.
 */
export async function listOwnerWakeAudit(
  userId: string,
  windowHours: number,
  projectId?: string,
): Promise<ApiResultWithItems<WakeAuditRow> & { summary: WakeAuditSummary }> {
  const t = await getErrorTranslations()
  const emptySummary: WakeAuditSummary = {
    total: 0,
    urgentCount: 0,
    suppressedCount: 0,
    windowHours,
  }
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
    // ownerUserId is the budget-isolation gate (budgets are per-owner, spanning all
    // their projects). When a projectId is passed (e.g. on a project's agent page),
    // also scope to that project so the list isn't mixed with other projects' wakes.
    const ownerGate = and(
      eq(wakeEvents.ownerUserId, userId),
      gte(wakeEvents.createdAt, since),
      ...(projectId ? [eq(wakeEvents.projectId, projectId)] : []),
    )

    const rows = await db
      .select({
        id: wakeEvents.id,
        createdAt: wakeEvents.createdAt,
        senderPart: wakeEvents.senderPart,
        senderUserId: wakeEvents.senderUserId,
        senderName: better_auth_user.name,
        projectId: wakeEvents.projectId,
        projectName: projects.name,
        agentId: wakeEvents.agentId,
        agentPart: agents.part,
        urgent: wakeEvents.urgent,
        suppressed: wakeEvents.suppressed,
      })
      .from(wakeEvents)
      .leftJoin(projects, eq(wakeEvents.projectId, projects.id))
      .leftJoin(agents, eq(wakeEvents.agentId, agents.id))
      .leftJoin(better_auth_user, eq(wakeEvents.senderUserId, better_auth_user.id))
      .where(ownerGate)
      .orderBy(desc(wakeEvents.createdAt))
      .limit(200)

    const [agg] = await db
      .select({
        total: count(),
        urgentCount: sql<number>`count(*) filter (where ${wakeEvents.urgent})`,
        suppressedCount: sql<number>`count(*) filter (where ${wakeEvents.suppressed})`,
      })
      .from(wakeEvents)
      .where(ownerGate)

    return {
      result: true,
      totalCount: rows.length,
      items: rows,
      summary: {
        total: Number(agg?.total ?? 0),
        urgentCount: Number(agg?.urgentCount ?? 0),
        suppressedCount: Number(agg?.suppressedCount ?? 0),
        windowHours,
      },
    }
  } catch (err) {
    console.error("[listOwnerWakeAudit]", err)
    return { result: false, message: t("wake.auditLoadFailed"), summary: emptySummary }
  }
}
