import { and, asc, eq, isNull } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { configurations } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import {
  SMTP_ENCRYPTIONS,
  encryptionToSecure,
  type SmtpEncryption,
} from "./schema"

/**
 * Derive the encryption preset for a stored row. New rows persist `encryption`
 * directly; older rows only have the boolean `secure`, so we fall back to the
 * conventional mapping (implicit TLS -> ssl, port 25 -> none, else starttls).
 */
function deriveEncryption(
  encryption: unknown,
  secure: boolean,
  port: number,
): SmtpEncryption {
  if (typeof encryption === "string" && (SMTP_ENCRYPTIONS as readonly string[]).includes(encryption)) {
    return encryption as SmtpEncryption
  }
  if (secure) return "ssl"
  if (port === 25) return "none"
  return "starttls"
}

/**
 * The instance superuser is defined as the first-created user (the person who
 * installed the instance at /account/setup). There is no explicit superadmin
 * role, so we derive it from the earliest better_auth_user.created_at.
 */
export async function getInstanceSuperuserId(): Promise<string | null> {
  const [row] = await db
    .select({ id: better_auth_user.id })
    .from(better_auth_user)
    .orderBy(asc(better_auth_user.createdAt))
    .limit(1)
  return row?.id ?? null
}

/** Whether the given user is the instance superuser (earliest-created user). */
export async function isInstanceSuperuser(userId: string): Promise<boolean> {
  if (!userId) return false
  const superuserId = await getInstanceSuperuserId()
  return superuserId != null && superuserId === userId
}

/** Full SMTP config including the password. Server-side only (email sender). */
export interface SmtpConfigValue {
  host: string
  port: number
  user: string
  pass: string
  from: string
  // Transport-level implicit TLS, derived from `encryption` on save.
  secure: boolean
  encryption: SmtpEncryption
}

/** Client-safe SMTP config: never includes the password, only whether it is set. */
export interface SmtpConfigView {
  host: string
  port: number
  user: string
  from: string
  encryption: SmtpEncryption
  hasPassword: boolean
}

/**
 * Read the raw SMTP config row (scope='global', key='smtp'), password included.
 * Returns null when no DB config has been saved. Intended for the email sender.
 */
export async function getSmtpConfigRaw(): Promise<SmtpConfigValue | null> {
  const [row] = await db
    .select({ value: configurations.value })
    .from(configurations)
    .where(
      and(
        eq(configurations.scope, "global"),
        isNull(configurations.scopeId),
        eq(configurations.key, "smtp"),
      ),
    )
    .limit(1)

  if (!row) return null
  const v = (row.value ?? {}) as Partial<SmtpConfigValue>
  const port = typeof v.port === "number" ? v.port : 587
  const secure = typeof v.secure === "boolean" ? v.secure : false
  const encryption = deriveEncryption(v.encryption, secure, port)
  return {
    host: typeof v.host === "string" ? v.host : "",
    port,
    user: typeof v.user === "string" ? v.user : "",
    pass: typeof v.pass === "string" ? v.pass : "",
    from: typeof v.from === "string" ? v.from : "",
    // Keep `secure` consistent with the resolved preset for the transport.
    secure: encryptionToSecure(encryption),
    encryption,
  }
}

/**
 * Client-safe view of the saved SMTP config. The password is replaced by a
 * `hasPassword` boolean so the secret never leaves the server.
 */
export async function getSmtpConfig(): Promise<SmtpConfigView | null> {
  const raw = await getSmtpConfigRaw()
  if (!raw) return null
  return {
    host: raw.host,
    port: raw.port,
    user: raw.user,
    from: raw.from,
    encryption: raw.encryption,
    hasPassword: raw.pass.length > 0,
  }
}

/**
 * The instance-wide public server base URL the superuser saved (scope='global',
 * key='server_base'), or null if unset. Callers fall back to env/default.
 */
export async function getServerBaseConfig(): Promise<string | null> {
  const [row] = await db
    .select({ value: configurations.value })
    .from(configurations)
    .where(
      and(
        eq(configurations.scope, "global"),
        isNull(configurations.scopeId),
        eq(configurations.key, "server_base"),
      ),
    )
    .limit(1)
  const v = row?.value
  return typeof v === "string" && v.length > 0 ? v : null
}
