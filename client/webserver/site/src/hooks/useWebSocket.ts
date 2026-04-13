import { useEffect, useRef } from 'react'
import { useWebSocketStore } from '../stores/useWebSocketStore'
import type { NoteReceiver } from '../services/websocket'

// useWebSocket subscribes to WebSocket routes on mount and
// unsubscribes on unmount. Handlers should be stable references
// (wrap with useCallback).
export function useWebSocket (routes: Record<string, NoteReceiver>) {
  const subscribe = useWebSocketStore(s => s.subscribe)
  const unsubscribe = useWebSocketStore(s => s.unsubscribe)
  const routesRef = useRef(routes)
  routesRef.current = routes

  useEffect(() => {
    const entries = Object.entries(routesRef.current)
    for (const [route, handler] of entries) {
      subscribe(route, handler)
    }
    return () => {
      for (const [route] of entries) {
        unsubscribe(route)
      }
    }
  }, [subscribe, unsubscribe])
}
