import { z } from "zod"

/**
 * Shared credential schema for account creation (name + password).
 *
 * Server actions are an untrusted boundary: client-side zod can be bypassed by
 * calling the action directly. Both the setup (first admin) and accept-invitation
 * flows MUST `.parse()` their inputs with this schema BEFORE calling
 * auth.api.createUser — better-auth's admin createUser accepts an empty password
 * and creates a user with NO credential account, which would leave the install
 * bricked (admin) or the invited email permanently "taken" (invite).
 *
 * Constraints match the client forms (setup-form.tsx, accept-form.tsx):
 *   - name: min 1
 *   - password: min 8
 *
 * The messages are `errors` namespace KEYS, not display text: this schema is
 * shared by two Server Actions that surface the failure as a toast, and only
 * they know the caller's locale. Both translate the first issue's message
 * (see VALIDATION_KEY_PREFIX) before returning it.
 */
export const VALIDATION_KEY_PREFIX = "validation."

export const credentialSchema = z.object({
  name: z.string().min(1, "validation.nameRequired"),
  password: z.string().min(8, "validation.passwordMin"),
})

/**
 * Translate the first issue of a failed credential parse. Anything that is not
 * one of our keys (a zod built-in message, a message added later without a key)
 * falls back to the generic copy rather than rendering a raw key at the user.
 */
export function credentialIssueMessage(
  issues: { message: string }[],
  t: (key: string) => string,
): string {
  const first = issues[0]?.message
  return first?.startsWith(VALIDATION_KEY_PREFIX) ? t(first) : t("common.invalidInput")
}

export type Credential = z.infer<typeof credentialSchema>
