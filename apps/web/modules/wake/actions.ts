"use server"

import { and, eq } from "drizzle-orm"
import type { ApiResult } from "@relayroom/shared"
import {
  upsertOwnerWakeBudgetSchema,
  type UpsertOwnerWakeBudgetInput,
  updateBroadcastCapSchema,
  type UpdateBroadcastCapInput,
} from "./schema"
import { db } from "@/modules/drizzle/db"
import { ownerWakeBudgets, projects } from "@relayroom/db/schema"
import { getServerSession } from "@/lib/auth-session"
import { requireProjectManage } from "@/modules/project/member-actions"
import { getErrorTranslations } from "@/lib/action-i18n"

/**
 * Upsert the LOGGED-IN owner's wake budget. The principal is always
 * session.user.id - the input carries no userId, so a caller can never touch
 * another owner's budget (spec §5/§11).
 */
export async function upsertOwnerWakeBudget(
  input: UpsertOwnerWakeBudgetInput,
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const parsed = upsertOwnerWakeBudgetSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { wakesPerHour, urgentPerHour } = parsed.data

    await db
      .insert(ownerWakeBudgets)
      .values({ userId: session.user.id, wakesPerHour, urgentPerHour, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: ownerWakeBudgets.userId,
        set: { wakesPerHour, urgentPerHour, updatedAt: new Date() },
      })

    return { result: true }
  } catch (err) {
    console.error("[upsertOwnerWakeBudget]", err)
    return { result: false, message: t("wake.budgetFailed") }
  }
}

/**
 * Update a project's max broadcast recipients. Manager-only: the
 * requireProjectManage gate (spec §11) is the sole authority check, and the
 * update is org-scoped (IDOR guard).
 */
export async function updateBroadcastCap(
  input: UpdateBroadcastCapInput,
): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = updateBroadcastCapSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, maxBroadcastRecipients } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }

    const updated = await db
      .update(projects)
      .set({ maxBroadcastRecipients, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, access.orgId)))
      .returning({ id: projects.id })

    if (updated.length === 0) return { result: false, message: t("project.notFound") }
    return { result: true }
  } catch (err) {
    console.error("[updateBroadcastCap]", err)
    return { result: false, message: t("wake.broadcastCapFailed") }
  }
}
