/**
 * Dev-only: re-bootstrap the local admin + org after a fresh database.
 * Run from apps/web:  pnpm exec tsx scripts/bootstrap-dev.mts
 */
import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { auth } from "../lib/auth"
import { db } from "../lib/db"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"

const EMAIL = "admin@example.com"
const PASSWORD = "relayroom123"
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

  await db.update(better_auth_user).set({ role: "admin" }).where(eq(better_auth_user.id, userId))

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
}

main()
  .then(() => db.$client.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("bootstrap failed:", e)
    process.exit(1)
  })
