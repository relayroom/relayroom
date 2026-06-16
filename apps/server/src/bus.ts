/**
 * Postgres LISTEN/NOTIFY event bus.
 *
 * Replaces the in-process EventEmitter with a DB-backed bus so that multiple
 * server processes (and later Next.js) can publish and subscribe to the same
 * event stream without an extra broker.
 *
 * Design decisions:
 * - TWO dedicated pg.Client instances per bus: one for LISTEN (receive) and
 *   one for NOTIFY (send).  LISTEN requires a persistent session; pool
 *   rotation would lose the subscription.  The NOTIFY client is also
 *   persistent so we can guarantee ordering: emits are queued and executed
 *   serially on the NOTIFY client.
 * - emit() enqueues a NOTIFY relayroom_events, '<json>'.  Notifications are
 *   sent in FIFO order.  The LISTEN client on THIS process receives its own
 *   NOTIFY back from Postgres (Postgres delivers to all listeners including
 *   the sender's session via the separate LISTEN connection).  Subscribers
 *   are therefore invoked EXACTLY ONCE - via the NOTIFY round-trip - and NOT
 *   additionally on the emit() path (no double-delivery).
 * - Local fan-out uses an internal EventEmitter so SSE handlers and other
 *   in-process subscribers continue to work unchanged.
 * - The public interface (emit / on / off / listenerCount / close) mirrors the
 *   old EventEmitter<{message:[HubBusEvent]}> type so routes and tests need no
 *   changes.
 */
import { EventEmitter } from 'node:events'
import { Client } from 'pg'
import type { HubBusEvent } from '@relayroom/shared'

const CHANNEL = 'relayroom_events'

export const DEFAULT_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub'

export interface Bus {
  emit(event: 'message', payload: HubBusEvent): void
  on(event: 'message', fn: (payload: HubBusEvent) => void): void
  off(event: 'message', fn: (payload: HubBusEvent) => void): void
  listenerCount(event: 'message'): number
  close(): Promise<void>
}

export interface BusOptions {
  connectionString?: string
}

export function createBus(opts?: BusOptions): Bus {
  const connStr = opts?.connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const local = new EventEmitter()
  local.setMaxListeners(0)

  // ── LISTEN client ──────────────────────────────────────────────────────────
  // Receives NOTIFY messages from all processes (including self).
  const listenClient = new Client({ connectionString: connStr })
  let listenConnected = false
  let closing = false
  // A pg Client emits an 'error' event if the connection drops AFTER connect; with no
  // listener that is an unhandled error and CRASHES the process (a brief DB blip would
  // crash-loop the server). Catch it, fall back to local-only delivery. (Full
  // reconnect + re-LISTEN is the multi-instance hardening item; for a single server
  // local emit still drives this process's own SSE consumers.)
  listenClient.on('error', (err: unknown) => {
    if (closing) return
    console.error('[bus] LISTEN client error (local-only until restart/reconnect):', err)
    listenConnected = false
  })

  const listenReady = listenClient.connect().then(() => {
    listenConnected = true
    listenClient.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return
      try {
        const event = JSON.parse(msg.payload) as HubBusEvent
        local.emit('message', event)
      }
      catch {
        // malformed payload — ignore
      }
    })
    return listenClient.query(`LISTEN ${CHANNEL}`)
  }).catch((err: unknown) => {
    console.error('[bus] LISTEN connection failed, falling back to local-only mode:', err)
    listenConnected = false
  })

  // ── NOTIFY client ──────────────────────────────────────────────────────────
  // Used exclusively for sending NOTIFY.  A persistent connection ensures that
  // sequential emit() calls are delivered in order (no per-emit connect race).
  const notifyClient = new Client({ connectionString: connStr })
  let notifyConnected = false
  // Same crash-guard as the LISTEN client: a post-connect drop must not crash the
  // process. Mark disconnected so enqueueNotify falls back to local emit.
  notifyClient.on('error', (err: unknown) => {
    if (closing) return
    console.error('[bus] NOTIFY client error (local-only until restart/reconnect):', err)
    notifyConnected = false
  })

  const notifyReady = notifyClient.connect().then(() => {
    notifyConnected = true
  }).catch((err: unknown) => {
    console.error('[bus] NOTIFY connection failed, falling back to local-only mode:', err)
    notifyConnected = false
  })

  // Ordered NOTIFY queue — ensures messages are sent in emit() call order.
  let notifyChain: Promise<void> = Promise.resolve()

  // Await both clients before any emit can fire a NOTIFY, so tests that
  // emit immediately after createBus() don't race with the connect.
  const allReady = Promise.all([listenReady, notifyReady])

  function enqueueNotify(payload: HubBusEvent) {
    notifyChain = notifyChain.then(async () => {
      if (closing) {
        local.emit('message', payload)
        return
      }

      const json = JSON.stringify(payload)
      // NOTIFY payload limit is 8000 BYTES (not JS chars). A multi-byte JSON (e.g. a
      // CJK subject) can be under 8000 chars but over 8000 bytes, which Postgres
      // rejects - so measure UTF-8 byte length, not string length.
      if (Buffer.byteLength(json, 'utf8') > 7999) {
        console.warn('[bus] NOTIFY payload exceeds 8000 bytes, emitting locally')
        local.emit('message', payload)
        return
      }

      if (!notifyConnected) {
        // No Postgres connection — emit locally so the process doesn't stall.
        local.emit('message', payload)
        return
      }

      try {
        const escaped = json.replace(/'/g, "''")
        await notifyClient.query(`NOTIFY ${CHANNEL}, '${escaped}'`)
      }
      catch (err) {
        console.error('[bus] NOTIFY failed, emitting locally:', err)
        local.emit('message', payload)
      }
    })
  }

  return {
    emit(_event: 'message', payload: HubBusEvent) {
      // Await both connections being established before sending NOTIFY, so the
      // LISTEN subscription is in place before we NOTIFY (guarantees we see
      // our own message via the round-trip).  We chain onto allReady so the
      // queue still serialises after the first emit.
      void allReady.then(() => enqueueNotify(payload))
    },

    on(_event: 'message', fn: (payload: HubBusEvent) => void) {
      local.on('message', fn)
    },

    off(_event: 'message', fn: (payload: HubBusEvent) => void) {
      local.off('message', fn)
    },

    listenerCount(_event: 'message'): number {
      return local.listenerCount('message')
    },

    async close() {
      closing = true
      if (listenConnected) {
        try { await listenClient.query(`UNLISTEN ${CHANNEL}`) }
        catch { /* best-effort */ }
        await listenClient.end().catch(() => {})
      }
      if (notifyConnected) {
        await notifyClient.end().catch(() => {})
      }
    },
  }
}
