import { create } from 'zustand'
import ws, { type NoteReceiver } from '../services/websocket'

interface WebSocketState {
  connected: boolean
  // `onOpen` fires on every successful WS open - initial connect AND
  // every reconnect. Use it to (re)hydrate server-derived state.
  connect: (uri: string, onOpen: () => void) => void
  subscribe: (route: string, handler: NoteReceiver) => void
  unsubscribe: (route: string) => void
  request: (route: string, payload: any) => void
  close: () => void
}

export const useWebSocketStore = create<WebSocketState>((set) => ({
  connected: false,

  connect: (uri: string, onOpen: () => void) => {
    ws.registerRoute('open', () => {
      set({ connected: true })
    })
    ws.registerRoute('close', () => {
      set({ connected: false })
    })
    ws.connect(uri, onOpen)
  },

  subscribe: (route: string, handler: NoteReceiver) => {
    ws.registerRoute(route, handler)
  },

  unsubscribe: (route: string) => {
    ws.deregisterRoute(route)
  },

  request: (route: string, payload: any) => {
    ws.request(route, payload)
  },

  close: () => {
    ws.close('store close')
    set({ connected: false })
  },
}))
