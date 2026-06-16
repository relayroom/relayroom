"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import type { HubBusEvent } from "@relayroom/shared"

// Mirror of the server's pager-liveness window (modules/agent/queries.ts). After
// this long without a beat, the client downgrades an agent's indicator to offline.
const PAGER_ONLINE_WINDOW_MS = 90_000
// How often to re-check for stale pagers (offline detection granularity).
const STALE_CHECK_MS = 15_000
const REFRESH_DEBOUNCE_MS = 400

interface PagerEntry {
  online: boolean
  /** epoch ms of the last beat we saw live (0 = never). */
  lastSeen: number
}

interface RealtimeContextValue {
  /** Live pager status for an agent, or undefined if we have no live signal yet
   *  (caller should fall back to the server-rendered value). */
  pagerOnline: (agentId: string) => boolean | undefined
  /** Run `cb` when a pager beat arrives for `part` (i.e. the agent connected). */
  onAgentConnected: (part: string, cb: () => void) => () => void
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null)

/** Null when rendered outside a project (no SSE scope) - callers fall back to props. */
export function useRealtime(): RealtimeContextValue | null {
  return useContext(RealtimeContext)
}

/**
 * One SSE connection per project, shared with all descendants. Drives two things:
 * - `message` events → debounced router.refresh() (live threads/events, as before).
 * - `pager` events → an in-memory store so satellite-dish indicators flip
 *   online/offline live without a full refresh, plus connect-dialog notifications.
 */
export function RealtimeProvider({
  projectId,
  children,
}: {
  projectId: string
  children: ReactNode
}) {
  const router = useRouter()
  const [pagers, setPagers] = useState<Record<string, PagerEntry>>({})
  const connectListeners = useRef<Map<string, Set<() => void>>>(new Map())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pagerOnline = useCallback(
    (agentId: string) => pagers[agentId]?.online,
    [pagers],
  )

  const onAgentConnected = useCallback((part: string, cb: () => void) => {
    const listeners = connectListeners.current
    let set = listeners.get(part)
    if (!set) {
      set = new Set()
      listeners.set(part, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
      // Drop the now-empty Set so the map doesn't grow unbounded as parts come and go
      // over the provider's lifetime (every connect-dialog open registers a new part).
      if (set && set.size === 0) listeners.delete(part)
    }
  }, [])

  // SSE subscription. EventSource auto-reconnects if the stream drops.
  useEffect(() => {
    const source = new EventSource(
      `/api/realtime?projectId=${encodeURIComponent(projectId)}`,
    )

    const onMessage = (ev: MessageEvent) => {
      let event: HubBusEvent
      try {
        event = JSON.parse(ev.data) as HubBusEvent
      } catch {
        return
      }

      if (event.kind === "pager") {
        setPagers((prev) => ({
          ...prev,
          [event.agentId]: { online: event.online, lastSeen: Date.now() },
        }))
        if (event.online) {
          connectListeners.current.get(event.part)?.forEach((cb) => cb())
        }
        return
      }

      // message / activity → coalesce a server refresh so threads + events update.
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    source.addEventListener("message", onMessage)
    return () => {
      source.removeEventListener("message", onMessage)
      source.close()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [projectId, router])

  // Offline detection: a stopped pager sends no events, so age out live entries.
  useEffect(() => {
    const id = setInterval(() => {
      setPagers((prev) => {
        const now = Date.now()
        let changed = false
        const next: Record<string, PagerEntry> = {}
        for (const [agentId, entry] of Object.entries(prev)) {
          const online = entry.lastSeen > 0 && now - entry.lastSeen < PAGER_ONLINE_WINDOW_MS
          if (online !== entry.online) changed = true
          next[agentId] = online === entry.online ? entry : { ...entry, online }
        }
        return changed ? next : prev
      })
    }, STALE_CHECK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <RealtimeContext.Provider value={{ pagerOnline, onAgentConnected }}>
      {children}
    </RealtimeContext.Provider>
  )
}
