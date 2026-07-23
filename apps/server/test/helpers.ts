import { createDb } from '@relayroom/db'
import { createApp } from '../src/app'
import { createBus } from '../src/bus'

import { TEST_DATABASE_URL } from '../../../test/db-url'

// Re-exported, not redefined: the database name varies per worktree so that
// concurrent runs do not drop each other's database. See test/db-url.ts.
export { TEST_DATABASE_URL }

export function makeTestApp() {
  const db = createDb(TEST_DATABASE_URL)
  const bus = createBus({ connectionString: TEST_DATABASE_URL })
  const app = createApp(db, bus)
  return { app, db, bus }
}

export async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}
