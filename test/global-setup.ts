import postgres from 'postgres'

export const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'

export default async function setup() {
  const admin = postgres('postgres://hub:hub@localhost:48802/postgres', { max: 1 })
  await admin.unsafe('DROP DATABASE IF EXISTS hub_test WITH (FORCE)')
  await admin.unsafe('CREATE DATABASE hub_test')
  await admin.end()

  const { createDb } = await import('../packages/db/src/client')
  const { runMigrations } = await import('../packages/db/src/migrate')
  const db = createDb(TEST_DATABASE_URL)
  await runMigrations(db)
  await db.$client.end()
}
