/**
 * Minimal email helper.
 *
 * SMTP config is resolved in priority order:
 *   1. The DB-stored instance config (configurations scope='global' key='smtp'),
 *      set by the superuser in Settings -> SMTP.
 *   2. Environment variables (SMTP_HOST/PORT/USER/PASS/FROM/SECURE) from
 *      docker-compose.
 *   3. Dev fallback: log to the server console (the team page renders a "copy
 *      invite link" button, so no real email is needed locally).
 */
import { getSmtpConfigRaw, type SmtpConfigValue } from "@/modules/admin/queries"

interface MailOptions {
  to: string
  subject: string
  html: string
}

/** A resolved, ready-to-send SMTP transport config. */
export interface ResolvedSmtp {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}

/**
 * Escape a string for safe interpolation into HTML (both element text and
 * double-quoted attribute values). Use on every untrusted value placed into an
 * email body (inviter name/email, org name, urls).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// docker compose forwards unset vars as empty strings, so treat blank as absent.
function env(name: string): string | undefined {
  const v = process.env[name]
  return v != null && v.trim() !== "" ? v.trim() : undefined
}

/** Resolve SMTP from an explicit DB config value (used directly for test sends). */
export function resolveSmtpFromValue(v: SmtpConfigValue): ResolvedSmtp | null {
  if (!v.host || v.host.trim() === "") return null
  const port = v.port || 587
  return {
    host: v.host.trim(),
    port,
    secure: v.secure,
    user: v.user && v.user.trim() !== "" ? v.user.trim() : undefined,
    pass: v.pass && v.pass !== "" ? v.pass : undefined,
    from: v.from && v.from.trim() !== "" ? v.from.trim() : `noreply@${v.host.trim()}`,
  }
}

/** Resolve SMTP from environment variables. Returns null when SMTP_HOST is unset. */
function resolveSmtpFromEnv(): ResolvedSmtp | null {
  const host = env("SMTP_HOST")
  if (!host) return null
  const port = Number(env("SMTP_PORT") ?? 587)
  // Port 465 is implicit TLS (SMTPS) and requires secure:true; 587/25 use STARTTLS
  // (secure:false). SMTP_SECURE explicitly overrides the port-based default.
  const secureEnv = env("SMTP_SECURE")
  const secure = secureEnv != null ? secureEnv === "true" : port === 465
  return {
    host,
    port,
    secure,
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS") ?? "",
    from: env("SMTP_FROM") ?? `noreply@${host}`,
  }
}

/**
 * Resolve the active SMTP config, preferring the DB row over env vars.
 * Returns null when neither is configured (dev fallback applies).
 */
export async function resolveSmtp(): Promise<ResolvedSmtp | null> {
  try {
    const dbConfig = await getSmtpConfigRaw()
    if (dbConfig) {
      const resolved = resolveSmtpFromValue(dbConfig)
      if (resolved) return resolved
    }
  } catch {
    // DB unavailable - fall through to env vars.
  }
  return resolveSmtpFromEnv()
}

/** Send a mail through a resolved SMTP transport. Throws on transport failure. */
export async function sendMailWith(smtp: ResolvedSmtp, opts: MailOptions): Promise<void> {
  const nodemailer = await import("nodemailer")
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? "" } : undefined,
  })
  await transport.sendMail({
    from: smtp.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  })
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const smtp = await resolveSmtp()

  if (smtp) {
    await sendMailWith(smtp, opts)
  } else {
    // Dev fallback - print to server stdout. The invite link is also shown in
    // the team settings UI ("copy invite link" button) so this log is supplemental.
    const acceptUrl = extractAcceptUrl(opts.html)
    console.log(
      `[invite-email:fallback] to=${opts.to} subject="${opts.subject}"` +
        (acceptUrl ? `\n[invite-email:fallback] accept-url: ${acceptUrl}` : ""),
    )
  }
}

/** Pull the first href out of the HTML so the fallback log is easy to scan. */
function extractAcceptUrl(html: string): string | null {
  const m = html.match(/href="([^"]+)"/)
  return m ? m[1] : null
}
