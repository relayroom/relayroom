"use server"

import type { ApiResult, ApiResultWithItem } from "@relayroom/shared"
import type { Db } from "@relayroom/db/client"
import { getMode, setMode, isModeChosen, sendFeedback } from "@relayroom/telemetry"
import { db as rawDb } from "@/modules/drizzle/db"

// The telemetry package types its db against @relayroom/db's postgres-js `Db`,
// while web runs the node-postgres driver. Both are valid drizzle instances and
// the telemetry helpers only touch the `configurations` table, so we bridge the
// driver-type gap here once. Runtime behaviour is identical.
const db = rawDb as unknown as Db
import { getServerSession } from "@/lib/auth-session"
import { isInstanceSuperuser } from "@/modules/admin/queries"
import { getErrorTranslations } from "@/lib/action-i18n"
import {
  setTelemetryModeSchema,
  feedbackSchema,
  type SetTelemetryModeInput,
  type TelemetryMode,
  type FeedbackInput,
} from "./schema"

/**
 * Authorize the caller as the instance superuser (earliest-created user, the
 * installer). Telemetry consent is an instance-wide decision, so only the
 * superuser may read/change it - the same gate SMTP config uses.
 */
async function requireSuperuser(): Promise<
  | { ok: true; userId: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }
  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) return { ok: false, message: t("admin.superuserOnly") }
  return { ok: true, userId: session.user.id }
}

export interface TelemetryStatus {
  mode: TelemetryMode
  /** True once the superuser has made an explicit choice (community or off). */
  chosen: boolean
}

// ── getTelemetryStatus ────────────────────────────────────────────────────────

/**
 * Read the current consent mode and whether a choice has been made. Superuser
 * only - non-superusers are denied so the banner/settings never leak the state.
 */
export async function getTelemetryStatus(): Promise<ApiResultWithItem<TelemetryStatus>> {
  const t = await getErrorTranslations()
  try {
    const auth = await requireSuperuser()
    if (!auth.ok) return { result: false, message: auth.message }

    const [mode, chosen] = await Promise.all([getMode(db), isModeChosen(db)])
    return { result: true, item: { mode, chosen } }
  } catch {
    return { result: false, message: t("telemetry.statusFailed") }
  }
}

// ── setTelemetryMode ──────────────────────────────────────────────────────────

/**
 * Set the consent mode. Superuser only. Nothing is ever transmitted until this
 * is called with an explicit choice (active consent), and `off` keeps the
 * product fully functional while blocking transmission.
 */
export async function setTelemetryMode(input: SetTelemetryModeInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const auth = await requireSuperuser()
    if (!auth.ok) return { result: false, message: auth.message }

    const parsed = setTelemetryModeSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    await setMode(db, parsed.data.mode)
    return { result: true }
  } catch {
    return { result: false, message: t("telemetry.saveFailed") }
  }
}

// ── submitFeedback ────────────────────────────────────────────────────────────

/**
 * Send dashboard feedback to the project's collector. Available to any signed-in
 * dashboard user (not superuser-gated) - it is the user's own message, not an
 * instance config change. Sends regardless of telemetry mode because it is an
 * explicit action the form discloses; see `sendFeedback` in @relayroom/telemetry.
 */
export async function submitFeedback(input: FeedbackInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const parsed = feedbackSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { rating, message, contact } = parsed.data
    const ok = await sendFeedback(db, {
      rating,
      message,
      contact: contact && contact.length > 0 ? contact : undefined,
    })
    if (!ok) return { result: false, message: t("telemetry.feedbackFailed") }
    return { result: true }
  } catch {
    return { result: false, message: t("telemetry.feedbackFailed") }
  }
}
