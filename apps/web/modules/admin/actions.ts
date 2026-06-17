"use server"

import type { ApiResult } from "@relayroom/shared"
import {
  saveSmtpConfigSchema,
  sendTestEmailSchema,
  saveServerBaseSchema,
  encryptionToSecure,
  type SaveSmtpConfigInput,
  type SendTestEmailInput,
  type SaveServerBaseInput,
} from "./schema"
import { isInstanceSuperuser, getSmtpConfigRaw } from "./queries"
import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { configurations } from "@relayroom/db/schema"
import { getServerSession } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import { resolveSmtpFromValue, sendMailWith } from "@/lib/email"

/**
 * Authorize the caller as the instance superuser (earliest-created user). Every
 * SMTP mutation is gated on this - there is no superadmin role.
 */
async function requireSuperuser(): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }
  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) return { ok: false, message: t("admin.superuserOnly") }
  return { ok: true, userId: session.user.id, email: session.user.email ?? "" }
}

// ── saveSmtpConfig ──────────────────────────────────────────────────────────

export async function saveSmtpConfig(input: SaveSmtpConfigInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const auth = await requireSuperuser()
    if (!auth.ok) return { result: false, message: auth.message }

    const parsed = saveSmtpConfigSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const data = parsed.data

    // If the password field is blank on edit, keep the existing stored password
    // instead of wiping the secret.
    let pass = data.pass
    if (!pass || pass === "") {
      const existing = await getSmtpConfigRaw()
      pass = existing?.pass ?? ""
    }

    const encryption = data.encryption ?? "starttls"
    const value = {
      host: data.host,
      port: data.port,
      user: data.user ?? "",
      pass,
      from: data.from ?? "",
      encryption,
      // Derived for the transport layer; kept in sync with the preset.
      secure: encryptionToSecure(encryption),
    }

    // The unique index treats NULL scope_id as distinct, so onConflict would not
    // dedupe the global row. Select-then-update/insert to keep a single global row.
    const [existing] = await db
      .select({ id: configurations.id })
      .from(configurations)
      .where(
        and(
          eq(configurations.scope, "global"),
          isNull(configurations.scopeId),
          eq(configurations.key, "smtp"),
        ),
      )
      .limit(1)

    if (existing) {
      await db
        .update(configurations)
        .set({ value, updatedByUserId: auth.userId, updatedAt: new Date() })
        .where(eq(configurations.id, existing.id))
    } else {
      await db.insert(configurations).values({
        scope: "global",
        scopeId: null,
        key: "smtp",
        value,
        updatedByUserId: auth.userId,
      })
    }

    return { result: true }
  } catch {
    return { result: false, message: t("admin.smtpSaveFailed") }
  }
}

// ── saveServerBaseConfig ────────────────────────────────────────────────────

/**
 * Save the instance-wide public server base URL (the address agents reach the MCP
 * server at, shown in the connect guide). Superuser-only. A blank value clears the
 * stored config so getPublicServerBase falls back to the env/default.
 */
export async function saveServerBaseConfig(input: SaveServerBaseInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const auth = await requireSuperuser()
    if (!auth.ok) return { result: false, message: auth.message }

    const parsed = saveServerBaseSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const serverBase = parsed.data.serverBase.replace(/\/$/, "")

    // Single global row; NULL scope_id is not deduped by the unique index, so
    // select-then-update/insert (same as SMTP).
    const [existing] = await db
      .select({ id: configurations.id })
      .from(configurations)
      .where(
        and(
          eq(configurations.scope, "global"),
          isNull(configurations.scopeId),
          eq(configurations.key, "server_base"),
        ),
      )
      .limit(1)

    if (existing) {
      await db
        .update(configurations)
        .set({ value: serverBase, updatedByUserId: auth.userId, updatedAt: new Date() })
        .where(eq(configurations.id, existing.id))
    } else {
      await db.insert(configurations).values({
        scope: "global",
        scopeId: null,
        key: "server_base",
        value: serverBase,
        updatedByUserId: auth.userId,
      })
    }

    return { result: true }
  } catch {
    return { result: false, message: t("admin.serverBaseSaveFailed") }
  }
}

// ── sendTestEmail ───────────────────────────────────────────────────────────

/**
 * Send a test email to the superuser's own address using the supplied config
 * (the form values being edited). A blank password falls back to the stored one,
 * matching saveSmtpConfig behaviour, so a test before saving still works.
 */
export async function sendTestEmail(input: SendTestEmailInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const auth = await requireSuperuser()
    if (!auth.ok) return { result: false, message: auth.message }

    const parsed = sendTestEmailSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const data = parsed.data

    if (!auth.email) return { result: false, message: t("admin.smtpTestFailed") }

    let pass = data.pass
    if (!pass || pass === "") {
      const existing = await getSmtpConfigRaw()
      pass = existing?.pass ?? ""
    }

    const encryption = data.encryption ?? "starttls"
    const smtp = resolveSmtpFromValue({
      host: data.host,
      port: data.port,
      user: data.user ?? "",
      pass: pass ?? "",
      from: data.from ?? "",
      encryption,
      secure: encryptionToSecure(encryption),
    })
    if (!smtp) return { result: false, message: t("admin.smtpTestFailed") }

    await sendMailWith(smtp, {
      to: auth.email,
      subject: "[RelayRoom] SMTP test email",
      html: `
        <p>This is a test email from RelayRoom.</p>
        <p>If you received this, your SMTP configuration works.</p>
      `,
    })

    return { result: true }
  } catch {
    return { result: false, message: t("admin.smtpTestFailed") }
  }
}
