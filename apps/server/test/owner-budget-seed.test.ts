import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import { authSchema, ownerWakeBudgets } from '@relayroom/db'
import { seedOwnerWakeBudget } from '../src/budget/seed-owner-budget'

const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'
const db: Db = createDb(TEST_DATABASE_URL)

const USER = 'user_seed_11'

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function getBudget(userId: string) {
  const [row] = await db
    .select()
    .from(ownerWakeBudgets)
    .where(eq(ownerWakeBudgets.userId, userId))
    .limit(1)
  return row
}

beforeEach(async () => {
  await db.delete(ownerWakeBudgets).where(eq(ownerWakeBudgets.userId, USER))
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, USER))
  await seedUser(USER)
})

afterAll(async () => {
  await db.delete(ownerWakeBudgets).where(eq(ownerWakeBudgets.userId, USER))
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, USER))
  await db.$client.end()
})

describe('seedOwnerWakeBudget', () => {
  it('fresh connect seeds the budget row with schema defaults 30/5', async () => {
    expect(await getBudget(USER)).toBeUndefined()

    await seedOwnerWakeBudget(db, USER)

    const row = await getBudget(USER)
    expect(row).toBeDefined()
    expect(row?.wakesPerHour).toBe(30)
    expect(row?.urgentPerHour).toBe(5)
  })

  it('is idempotent and does not overwrite a user slider edit', async () => {
    // User set their wake budget to 3 via the slider (phase 10).
    await db.insert(ownerWakeBudgets).values({ userId: USER, wakesPerHour: 3, urgentPerHour: 0 })

    // A later reconnect must not clobber that value.
    await seedOwnerWakeBudget(db, USER)
    await seedOwnerWakeBudget(db, USER)

    const row = await getBudget(USER)
    expect(row?.wakesPerHour).toBe(3)
    expect(row?.urgentPerHour).toBe(0)
  })
})
