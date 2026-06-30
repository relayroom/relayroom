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
 * - SELF-HEALING: the local EventEmitter is stable for the bus lifetime, so
 *   subscribers (open SSE streams) survive reconnects. If either pg client
 *   drops (a Postgres restart / network blip), we recreate it and re-LISTEN on
 *   a backoff. Without this a single DB blip left the LISTEN session dead and,
 *   since delivery rides the NOTIFY->LISTEN round-trip, permanently stopped
 *   wake delivery (cross-process AND this process's own SSE consumers) until the
 *   server was restarted. While a client is down, emit() falls back to local
 *   in-process delivery so the process never stalls.
 * - The public interface (emit / on / off / listenerCount / degraded / close)
 *   mirrors the old EventEmitter<{message:[HubBusEvent]}> type so routes and
 *   tests need no changes (degraded() is additive).
 */
import { EventEmitter } from 'node:events'
import { Client } from 'pg'
import type { HubBusEvent } from '@relayroom/shared'

const CHANNEL = 'relayroom_events'
const RECONNECT_DELAY_MS = 2000

export const DEFAULT_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub'

export interface Bus {
  emit(event: 'message', payload: HubBusEvent): void
  on(event: 'message', fn: (payload: HubBusEvent) => void): void
  off(event: 'message', fn: (payload: HubBusEvent) => void): void
  listenerCount(event: 'message'): number
  /** True when either pg client is currently disconnected (degraded delivery). */
  degraded(): boolean
  close(): Promise<void>
}

export interface BusOptions {
  connectionString?: string
}

export function createBus(opts?: BusOptions): Bus {
  const connStr = opts?.connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const local = new EventEmitter()
  local.setMaxListeners(0)

  let closing = false

  // ── LISTEN client (self-healing) ────────────────────────────────────────────
  // Receives NOTIFY messages from all processes (including self) and fans them out
  // to in-process subscribers via the stable `local` emitter.
  let listenClient: Client | null = null
  let listenConnected = false
  let listenConnecting = false
  let listenReconnectTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleListenReconnect() {
    if (closing) return
    if (listenClient) {
      try { listenClient.removeAllListeners(); listenClient.end().catch(() => {}) }
      catch { /* best-effort teardown */ }
      listenClient = null
    }
    listenConnected = false
    if (listenReconnectTimer) return
    listenReconnectTimer = setTimeout(() => { listenReconnectTimer = null; void connectListen() }, RECONNECT_DELAY_MS)
  }

  function connectListen(): Promise<void> {
    if (closing || listenClient || listenConnecting) return Promise.resolve()
    listenConnecting = true
    const client = new Client({ connectionString: connStr })
    // A post-connect drop emits 'error'/'end'; with no listener that 'error' is an
    // unhandled exception that CRASHES the process. Catch it and reconnect.
    client.on('error', (err: unknown) => {
      if (closing) return
      console.error('[bus] LISTEN client error, will reconnect:', err)
      listenConnecting = false
      scheduleListenReconnect()
    })
    client.on('end', () => {
      if (closing) return
      listenConnecting = false
      scheduleListenReconnect()
    })
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return
      try {
        local.emit('message', JSON.parse(msg.payload) as HubBusEvent)
      }
      catch { /* malformed payload - ignore */ }
    })
    return client.connect()
      .then(() => client.query(`LISTEN ${CHANNEL}`))
      .then(() => {
        listenConnecting = false
        // close() may have run while this connect was in flight; don't adopt a client
        // into a closing bus (it would leak an open connection past shutdown).
        if (closing) { client.end().catch(() => {}); return }
        listenClient = client
        listenConnected = true
      })
      .catch((err: unknown) => {
        console.error('[bus] LISTEN connect failed, will retry:', err)
        listenConnecting = false
        try { client.end().catch(() => {}) } catch { /* ignore */ }
        scheduleListenReconnect()
      })
  }

  // ── NOTIFY client (self-healing) ────────────────────────────────────────────
  // Used exclusively for sending NOTIFY.  A persistent connection keeps sequential
  // emit() calls in order (no per-emit connect race).
  let notifyClient: Client | null = null
  let notifyConnected = false
  let notifyConnecting = false
  let notifyReconnectTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleNotifyReconnect() {
    if (closing) return
    if (notifyClient) {
      try { notifyClient.removeAllListeners(); notifyClient.end().catch(() => {}) }
      catch { /* best-effort teardown */ }
      notifyClient = null
    }
    notifyConnected = false
    if (notifyReconnectTimer) return
    notifyReconnectTimer = setTimeout(() => { notifyReconnectTimer = null; void connectNotify() }, RECONNECT_DELAY_MS)
  }

  function connectNotify(): Promise<void> {
    if (closing || notifyClient || notifyConnecting) return Promise.resolve()
    notifyConnecting = true
    const client = new Client({ connectionString: connStr })
    client.on('error', (err: unknown) => {
      if (closing) return
      console.error('[bus] NOTIFY client error, will reconnect:', err)
      notifyConnecting = false
      scheduleNotifyReconnect()
    })
    client.on('end', () => {
      if (closing) return
      notifyConnecting = false
      scheduleNotifyReconnect()
    })
    return client.connect()
      .then(() => {
        notifyConnecting = false
        // Same close()-during-connect guard as the LISTEN client above.
        if (closing) { client.end().catch(() => {}); return }
        notifyClient = client
        notifyConnected = true
      })
      .catch((err: unknown) => {
        console.error('[bus] NOTIFY connect failed, will retry:', err)
        notifyConnecting = false
        try { client.end().catch(() => {}) } catch { /* ignore */ }
        scheduleNotifyReconnect()
      })
  }

  // Ordered NOTIFY queue — ensures messages are sent in emit() call order.
  let notifyChain: Promise<void> = Promise.resolve()

  // Await BOTH clients' INITIAL connect before any emit fires a NOTIFY, so tests
  // that emit immediately after createBus() don't race the connect. (Reconnects
  // after a drop are NOT awaited - emit falls back to local delivery while down.)
  const allReady = Promise.all([connectListen(), connectNotify()]).then(() => {})

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

      if (!notifyConnected || !notifyClient) {
        // No Postgres connection (down / reconnecting) — emit locally so the process
        // doesn't stall; the reconnect loop restores cross-process delivery.
        local.emit('message', payload)
        return
      }

      try {
        const escaped = json.replace(/'/g, "''")
        await notifyClient.query(`NOTIFY ${CHANNEL}, '${escaped}'`)
        // ASYMMETRIC-DROP GUARD: the NOTIFY fans out to OTHER processes, but THIS
        // process only sees it back via its OWN LISTEN round-trip. If our LISTEN is
        // down (reconnecting) while NOTIFY is up, the round-trip never arrives, so the
        // wake would be silently lost for our in-process SSE/pager consumers. Deliver
        // locally too in that window. (Double-delivery would require LISTEN to reconnect
        // within the sub-ms NOTIFY-delivery window vs the 2s reconnect backoff -
        // negligible; and wake coalescing/lease dedupes a stray repeat anyway.)
        if (!listenConnected) local.emit('message', payload)
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

    degraded(): boolean {
      return !listenConnected || !notifyConnected
    },

    async close() {
      closing = true
      if (listenReconnectTimer) { clearTimeout(listenReconnectTimer); listenReconnectTimer = null }
      if (notifyReconnectTimer) { clearTimeout(notifyReconnectTimer); notifyReconnectTimer = null }
      if (listenClient) {
        try { await listenClient.query(`UNLISTEN ${CHANNEL}`) }
        catch { /* best-effort */ }
        await listenClient.end().catch(() => {})
        listenClient = null
      }
      if (notifyClient) {
        await notifyClient.end().catch(() => {})
        notifyClient = null
      }
    },
  }
}
