import { z } from "zod"

/**
 * Encryption presets. The admin picks one and the form fills the conventional
 * port; the transport-level `secure` flag (implicit TLS) is derived from this:
 *   - none:     no encryption,            default port 25,  secure=false
 *   - starttls: opportunistic TLS upgrade, default port 587, secure=false
 *   - ssl:      implicit TLS (SMTPS),      default port 465, secure=true
 */
export const SMTP_ENCRYPTIONS = ["none", "starttls", "ssl"] as const
export type SmtpEncryption = (typeof SMTP_ENCRYPTIONS)[number]

/** Conventional port for each encryption preset. */
export const SMTP_ENCRYPTION_PORTS: Record<SmtpEncryption, number> = {
  none: 25,
  starttls: 587,
  ssl: 465,
}

/** Implicit-TLS (`secure`) is on only for the SSL/TLS preset. */
export function encryptionToSecure(encryption: SmtpEncryption): boolean {
  return encryption === "ssl"
}

/**
 * Instance-wide SMTP configuration, edited by the instance superuser.
 *
 * The password field is optional on save: leaving it blank keeps the existing
 * stored password (so an admin editing other fields does not have to re-type the
 * secret, and the UI never receives the secret back to round-trip).
 */
export const saveSmtpConfigSchema = z.object({
  host: z.string().min(1, "SMTP host is required.").max(255),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().max(255).optional().default(""),
  // Blank = keep existing stored password.
  pass: z.string().max(1024).optional().default(""),
  from: z.string().max(320).optional().default(""),
  encryption: z.enum(SMTP_ENCRYPTIONS).optional().default("starttls"),
})

/** Form-side (pre-coercion) shape: port may arrive as a string from the input. */
export type SaveSmtpConfigInput = z.input<typeof saveSmtpConfigSchema>
/** Validated shape after coercion/defaults. */
export type SaveSmtpConfigValues = z.output<typeof saveSmtpConfigSchema>

export const sendTestEmailSchema = saveSmtpConfigSchema

export type SendTestEmailInput = z.input<typeof sendTestEmailSchema>

/**
 * Instance-wide public server base URL, edited by the superuser. This is the
 * address agents reach the MCP server at, shown in the connect guide. Blank
 * clears the stored value so it falls back to the env/default.
 */
export const saveServerBaseSchema = z.object({
  serverBase: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .default("")
    .refine(
      (v) => v === "" || /^https?:\/\/.+/.test(v),
      "Must be a full http(s) URL, for example https://hub.example.com or http://192.168.0.18:48801.",
    ),
})

export type SaveServerBaseInput = z.input<typeof saveServerBaseSchema>
