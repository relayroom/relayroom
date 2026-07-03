/**
 * Dev-only: re-bootstrap the local admin + org after a fresh database.
 * Run from apps/web:  pnpm exec tsx scripts/bootstrap-dev.mts
 *
 * Refuses to run against a production environment: this seeds a freshly
 * generated admin password that is printed to stdout, which is only safe on
 * a throwaway dev database. Guarded by NODE_ENV, with an explicit opt-out
 * flag (--force) for anyone who really knows what they're doing.
 */
import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { auth } from "../lib/auth"
import { db } from "../lib/db"
import { promoteToAdminAtomic } from "../lib/promote-admin"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"

const FORCE = process.argv.includes("--force")

if (process.env.NODE_ENV === "production" && !FORCE) {
  console.error(
    "bootstrap-dev: refusing to seed a known-password admin with NODE_ENV=production. " +
      "Re-run with --force if this is intentional.",
  )
  process.exit(1)
}

const EMAIL = "admin@example.com"
const PASSWORD = randomBytes(18).toString("base64url")
const ORG_NAME = "RelayRoom"
const ORG_SLUG = "relayroom"

async function main() {
  const existing = await db
    .select({ id: better_auth_user.id })
    .from(better_auth_user)
    .where(eq(better_auth_user.email, EMAIL))
  if (existing.length > 0) {
    console.log("admin already exists, skipping")
    return
  }

  const res = await auth.api.createUser({
    body: { name: "Admin", email: EMAIL, password: PASSWORD },
  })
  const userId = (res as { user?: { id?: string } }).user?.id
  if (!userId) throw new Error("createUser returned no id")

  const promoted = await promoteToAdminAtomic(userId)
  if (!promoted) throw new Error("failed to promote seeded user to admin (already one present?)")

  const orgId = randomBytes(12).toString("hex")
  await db.insert(better_auth_organization).values({
    id: orgId,
    name: ORG_NAME,
    slug: ORG_SLUG,
    createdAt: new Date(),
  })
  await db.insert(better_auth_member).values({
    id: randomBytes(12).toString("hex"),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  })

  console.log(`bootstrapped admin ${EMAIL} (id=${userId}) + org ${ORG_NAME} (${orgId})`)
  console.log(`admin password: ${PASSWORD}`)
}

main()
  .then(() => db.$client.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("bootstrap failed:", e)
    process.exit(1)
  })
