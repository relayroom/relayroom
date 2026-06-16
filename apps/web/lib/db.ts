import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

// Cache the pg Pool on globalThis so dev HMR reloads reuse the same pool
// instead of leaking a fresh Pool (and its connections) on every hot reload.
// In production (`next start`) this module evaluates once, so the guard is a
// no-op there but prevents the dev-time connection/memory bloat.
const globalForDb = globalThis as unknown as {
  __relayroomPool?: Pool
}

const pool =
  globalForDb.__relayroomPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://hub:hub@localhost:48802/hub",
  })

if (process.env.NODE_ENV !== "production") {
  globalForDb.__relayroomPool = pool
}

export const db = drizzle({ client: pool })
