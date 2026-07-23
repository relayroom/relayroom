"use server"

import { z } from "zod"
import { auth } from "@/lib/auth"
import { adminExists } from "@/lib/auth-session"
import { credentialSchema, credentialIssueMessage } from "@/lib/validation"
import { getErrorTranslations } from "@/lib/action-i18n"
import { promoteToAdminAtomic } from "@/lib/promote-admin"

/**
 * Create the first admin user (one-time bootstrap).
 *
 * Because public sign-up is disabled (disableSignUp: true), the client-side
 * signUp.email would be rejected by the /api/auth/sign-up/email endpoint.
 * Instead we call auth.api.createUser server-side WITHOUT passing headers —
 * the admin plugin allows server-internal creation when no request context is
 * provided (see routes.mjs: "if (!session && (ctx.request || ctx.headers)) throw UNAUTHORIZED").
 *
 * After creation, we immediately promote the new user to admin using the same
 * atomic SQL guard as before.
 *
 * Security:
 *   - The entire action is gated on !adminExists(), so it cannot be invoked
 *     once an admin is already in place.
 *   - The partial unique index `better_auth_user_single_admin` provides the
 *     race-safe hard guarantee (concurrent winners hit Postgres 23505).
 *
 * Returns the new user id on success, throws on failure.
 */
export async function createFirstAdmin(params: {
  name: string
  email: string
  password: string
}): Promise<string> {
  // Every message thrown from here is rendered by setup-form's toast, so it is
  // localized rather than raw.
  const t = await getErrorTranslations()

  // SERVER-SIDE validation: server actions bypass the client zod, and an empty
  // password would create a user with no credential account that we then promote
  // to admin — bricking the install (adminExists() closes setup, nobody can sign in).
  // safeParse (not parse) so the failure surfaces as a translated Error rather than
  // a raw ZodError, whose message is a `validation.*` key.
  const parsed = credentialSchema.safeParse({
    name: params.name,
    password: params.password,
  })
  if (!parsed.success) throw new Error(credentialIssueMessage(parsed.error.issues, t))
  const { name, password } = parsed.data

  const parsedEmail = z.string().email().safeParse(params.email)
  if (!parsedEmail.success) throw new Error(t("setup.invalidEmail"))
  const email = parsedEmail.data

  // Gate: abort if an admin already exists (prevents abuse after bootstrap).
  if (await adminExists()) {
    throw new Error(t("setup.adminExists"))
  }

  // Create user via admin plugin server-side path (no session/headers = no auth check).
  const result = await auth.api.createUser({
    body: { name, email, password },
  })

  const userId = (result as { user?: { id?: string } }).user?.id
  if (!userId) throw new Error(t("setup.userCreateFailed"))

  // Promote to admin (atomic, race-safe).
  const promoted = await promoteToAdminAtomic(userId)
  if (!promoted) {
    throw new Error(t("setup.promoteFailed"))
  }

  return userId
}
