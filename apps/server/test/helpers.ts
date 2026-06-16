import { createDb } from '@relayroom/db'
import { createApp } from '../src/app'
import { createBus } from '../src/bus'

export const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'

export function makeTestApp() {
  const db = createDb(TEST_DATABASE_URL)
  const bus = createBus({ connectionString: TEST_DATABASE_URL })
  const app = createApp(db, bus)
  return { app, db, bus }
}

export async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}
