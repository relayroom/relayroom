"use server"

import { z } from "zod"
import { auth } from "@/lib/auth"
import { adminExists } from "@/lib/auth-session"
import { credentialSchema } from "@/lib/validation"
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
  // SERVER-SIDE validation: server actions bypass the client zod, and an empty
  // password would create a user with no credential account that we then promote
  // to admin — bricking the install (adminExists() closes setup, nobody can sign in).
  const { name, password } = credentialSchema.parse({
    name: params.name,
    password: params.password,
  })
  const email = z.string().email("올바른 이메일 형식을 입력해주세요.").parse(params.email)

  // Gate: abort if an admin already exists (prevents abuse after bootstrap).
  if (await adminExists()) {
    throw new Error("관리자 계정이 이미 존재합니다.")
  }

  // Create user via admin plugin server-side path (no session/headers = no auth check).
  const result = await auth.api.createUser({
    body: { name, email, password },
  })

  const userId = (result as { user?: { id?: string } }).user?.id
  if (!userId) throw new Error("사용자 생성에 실패했습니다.")

  // Promote to admin (atomic, race-safe).
  const promoted = await promoteToAdminAtomic(userId)
  if (!promoted) {
    throw new Error(
      "관리자 권한을 부여하지 못했습니다. 이미 다른 관리자가 존재할 수 있습니다.",
    )
  }

  return userId
}
