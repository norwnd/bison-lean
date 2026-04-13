import { create } from 'zustand'
import ws, { type NoteReceiver } from '../services/websocket'

interface WebSocketState {
  connected: boolean
  connect: (uri: string, onReconnect: () => void) => void
  subscribe: (route: string, handler: NoteReceiver) => void
  unsubscribe: (route: string) => void
  request: (route: string, payload: any) => void
  close: () => void
}

export const useWebSocketStore = create<WebSocketState>((set) => ({
  connected: false,

  connect: (uri: string, onReconnect: () => void) => {
    ws.registerRoute('open', () => {
      set({ connected: true })
    })
    ws.registerRoute('close', () => {
      set({ connected: false })
    })
    ws.connect(uri, onReconnect)
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
