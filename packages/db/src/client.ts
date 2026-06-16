import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export const DEFAULT_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub'

// Opens a new connection pool per call: create one instance per process and reuse it.
export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = postgres(url)
  return drizzle(client, { schema })
}
export type Db = ReturnType<typeof createDb>

/** A Db handle OR an open transaction. Helpers that only use the query-builder
 *  surface (select/insert/update/delete) accept this so they can run either
 *  standalone or composed inside a caller's transaction (e.g. wake issuance). */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
