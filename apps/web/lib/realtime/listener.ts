import { EventEmitter } from "node:events"
import { Client } from "pg"
import type { HubBusEvent } from "@relayroom/shared"

/**
 * Next.js-side Postgres LISTEN bridge.
 *
 * The Hono server publishes agent activity onto the `relayroom_events` channel
 * via NOTIFY (see apps/server/src/bus.ts). Here the Next.js process holds ONE
 * persistent LISTEN connection and fans every notification out, in-process, to
 * all connected browser SSE streams. So the connection count stays constant (one
 * per Next.js process) regardless of how many dashboards are open — the human
 * stream is fan-out, unlike the agent bus which is single-delivery.
 *
 * Self-healing: the fan-out EventEmitter is stable for the process lifetime, so
 * subscribers (open SSE streams) stay attached across reconnects. If the LISTEN
 * connection drops, we recreate the pg client and re-LISTEN on a backoff; events
 * resume flowing to the same subscribers without them reconnecting.
 */

const CHANNEL = "relayroom_events"
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://hub:hub@localhost:48802/hub"
const RECONNECT_DELAY_MS = 2000

interface ListenerState {
  /** Stable fan-out emitter — never replaced, so subscribers survive reconnects. */
  emitter: EventEmitter
  client: Client | null
  connecting: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

// Cache on globalThis so dev HMR reloads reuse the same emitter + connection
// instead of leaking a new LISTEN connection on every hot reload.
const globalForListener = globalThis as unknown as {
  __relayroomListener?: ListenerState
}

function getState(): ListenerState {
  if (!globalForListener.__relayroomListener) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0)
    globalForListener.__relayroomListener = {
      emitter,
      client: null,
      connecting: false,
      reconnectTimer: null,
    }
  }
  return globalForListener.__relayroomListener
}

function scheduleReconnect(state: ListenerState) {
  if (state.client) {
    try {
      state.client.removeAllListeners()
      state.client.end().catch(() => {})
    } catch {
      // best-effort teardown
    }
    state.client = null
  }
  if (state.reconnectTimer) return
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    connect(state)
  }, RECONNECT_DELAY_MS)
}

function connect(state: ListenerState) {
  if (state.client || state.connecting) return
  state.connecting = true

  const client = new Client({ connectionString: DATABASE_URL })

  client.on("notification", (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return
    try {
      state.emitter.emit("event", JSON.parse(msg.payload) as HubBusEvent)
    } catch {
      // malformed payload — ignore
    }
  })
  client.on("error", (err) => {
    console.error("[realtime] LISTEN client error, will reconnect:", err)
    state.connecting = false
    scheduleReconnect(state)
  })
  client.on("end", () => {
    state.connecting = false
    scheduleReconnect(state)
  })

  client
    .connect()
    .then(() => client.query(`LISTEN ${CHANNEL}`))
    .then(() => {
      state.client = client
      state.connecting = false
    })
    .catch((err: unknown) => {
      console.error("[realtime] LISTEN connect failed, will retry:", err)
      state.connecting = false
      try {
        client.end().catch(() => {})
      } catch {
        // ignore
      }
      scheduleReconnect(state)
    })
}

/**
 * Subscribe to the bus event stream. The callback fires for EVERY event; the
 * caller filters by projectId. Returns an unsubscribe function. The subscription
 * attaches to a stable emitter, so it keeps receiving events across reconnects.
 */
export function subscribe(fn: (event: HubBusEvent) => void): () => void {
  const state = getState()
  connect(state) // idempotent — ensures the LISTEN connection is (being) established
  state.emitter.on("event", fn)
  return () => state.emitter.off("event", fn)
}
