"use server"

import { eq, and } from "drizzle-orm"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { better_auth_invitation, better_auth_user } from "@relayroom/db/auth-schema"
import { credentialSchema, credentialIssueMessage } from "@/lib/validation"
import { getErrorTranslations } from "@/lib/action-i18n"

export interface CreateInvitedAccountResult {
  ok: boolean
  error?: string
  /** Email to sign in with after account creation (from the invitation) */
  email?: string
}

/**
 * Create an account for the invited email address.
 *
 * Approach (Option B): auth.api.createUser server-side WITHOUT headers. The admin
 * plugin guard is "if (!session && (ctx.request || ctx.headers)) throw UNAUTHORIZED"
 * — called without a request context the check is skipped, so account creation works
 * even though disableSignUp is true and no admin session exists.
 *
 * This action ONLY creates the user. It does NOT sign in or accept the invitation.
 * Those happen on the client: signIn.email sets the session cookie, then
 * authClient.organization.acceptInvitation creates the member row authenticated as
 * the new user. (Doing the accept server-side here is unreliable — the internal
 * sign-in returns the token at the top level and there's no bearer plugin to consume
 * an Authorization header, so the accept call would be silently skipped.)
 */
export async function createInvitedAccount(
  invitationId: string,
  params: { name: string; password: string },
): Promise<CreateInvitedAccountResult> {
  // `error` is thrown straight into a toast by accept-form, so it is localized here.
  const t = await getErrorTranslations()

  // 0. SERVER-SIDE credential validation: the action bypasses client zod, and an
  // empty password would create an unusable user for the invited email, making the
  // email "taken" so the invite can never be completed without manual cleanup.
  const parsed = credentialSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: credentialIssueMessage(parsed.error.issues, t) }
  }
  const { name, password } = parsed.data

  // 1. Validate invitation
  const [invitation] = await db
    .select()
    .from(better_auth_invitation)
    .where(
      and(
        eq(better_auth_invitation.id, invitationId),
        eq(better_auth_invitation.status, "pending"),
      ),
    )

  if (!invitation) {
    return { ok: false, error: t("invitation.invalid") }
  }
  if (invitation.expiresAt < new Date()) {
    return { ok: false, error: t("invitation.expired") }
  }

  // 2. Reject if the email already has an account
  const existingUser = await db
    .select({ id: better_auth_user.id })
    .from(better_auth_user)
    .where(eq(better_auth_user.email, invitation.email))
  if (existingUser.length > 0) {
    return { ok: false, error: t("invitation.emailTaken") }
  }

  // 3. Create the user (server-internal, bypasses disableSignUp)
  try {
    const result = await auth.api.createUser({
      body: {
        name,
        email: invitation.email,
        password,
      },
    })
    const id = (result as { user?: { id?: string } }).user?.id
    if (!id) return { ok: false, error: t("invitation.accountCreateFailed") }
  } catch (err) {
    // better-auth's own message (already localized by it, or English) is kept when
    // there is one - it is more specific than our generic copy.
    const msg = err instanceof Error ? err.message : t("invitation.accountCreateFailed")
    return { ok: false, error: msg }
  }

  return { ok: true, email: invitation.email }
}
