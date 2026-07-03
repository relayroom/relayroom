import { and, eq, sql } from "drizzle-orm"
import { db } from "./db"
import { better_auth_user } from "@relayroom/db/auth-schema"

/**
 * Promote a just-created user to admin, atomically.
 *
 * Race-safe: the WHERE clause requires no admin to exist yet, and the partial
 * unique index `better_auth_user_single_admin` gives the hard guarantee -
 * concurrent winners hit Postgres 23505, which we swallow as `false`.
 *
 * Returns `true` if this call promoted the user, `false` otherwise (an admin
 * already exists, or lost the race).
 *
 * Shared by the first-admin setup flow (app/(account)/account/setup/actions.ts)
 * and the dev bootstrap script (scripts/bootstrap-dev.mts).
 */
export async function promoteToAdminAtomic(userId: string): Promise<boolean> {
  try {
    const updated = await db
      .update(better_auth_user)
      .set({ role: "admin" })
      .where(
        and(
          eq(better_auth_user.id, userId),
          sql`not exists (select 1 from ${better_auth_user} where ${better_auth_user.role} = 'admin')`,
        ),
      )
      .returning({ id: better_auth_user.id })

    return updated.length > 0
  } catch (err) {
    if (isUniqueViolation(err)) return false
    throw err
  }
}

/** Postgres unique_violation error code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  )
}
