import { create } from 'zustand'
import type { CoreNote } from './types'
import { POKE, desktopNotify } from '../services/notifier'
import { useUIStore } from './useUIStore'
import { useWebSocketStore } from './useWebSocketStore'

const noteCacheSize = 100
const popupCacheSize = 5
const popupTtlMs = 6000

interface PopupItem {
  id: number
  note: CoreNote
}

interface NotificationState {
  notes: CoreNote[]
  pokes: CoreNote[]
  popupQueue: PopupItem[]
  noteReceivers: Record<string, (n: CoreNote) => void>[]

  notify: (note: CoreNote) => void
  setNotes: (notes: CoreNote[]) => void
  setPokes: (pokes: CoreNote[]) => void
  ackNotes: () => void
  removePopup: (id: number) => void
  registerNoteFeeder: (receivers: Record<string, (n: CoreNote) => void>) => () => void
}

let popupCounter = 0

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notes: [],
  pokes: [],
  popupQueue: [],
  noteReceivers: [],

  notify: (note: CoreNote) => {
    const state = get()

    // 1. Dispatch to registered page feeders (each page registers a
    //    `Record<noteType, handler>` via `useNotifications`).
    for (const receivers of state.noteReceivers) {
      const handler = receivers[note.type]
      if (handler) handler(note)
    }

    // 2. Discard data/ignore-only notes — they don't surface in the UI.
    //    Mirrors dev2 `app.ts notify()` "if (note.severity < ntfn.POKE) return".
    if (note.severity < POKE) return

    // 3. POKE → "Recent Activity" tab, SUCCESS+ → "Notifications" tab.
    set(prev => {
      if (note.severity === POKE) {
        return { pokes: [note, ...prev.pokes].slice(0, noteCacheSize) }
      }
      return { notes: [note, ...prev.notes].slice(0, noteCacheSize) }
    })

    // 4. Transient bottom-right popup toast.
    //    Gated here (in the store) rather than inside `PopupNotes` so the
    //    queue stays empty while the user has popups disabled. If we
    //    enqueued unconditionally and gated rendering at the component
    //    level, toggling `showPopups` on would suddenly surface every
    //    queued item at once — items that may already be 5+ seconds old
    //    but would still play their full 6s fade-out, looking stuck.
    if (useUIStore.getState().showPopups) {
      const id = ++popupCounter
      set(prev => ({
        popupQueue: [...prev.popupQueue, { id, note }].slice(-popupCacheSize),
      }))
      setTimeout(() => { get().removePopup(id) }, popupTtlMs)
    }

    // 5. OS/browser desktop notification (gated by per-host settings the
    //    SettingsPage UI writes to localStorage; no-ops when disabled).
    desktopNotify(note).catch(err => console.error('desktopNotify failed:', err))
  },

  // setNotes replaces the entire notification cache, mirroring vanilla
  // `app.ts` `setNotes()` (L1042) which clears `this.notes` and
  // `this.page.noteList` before re-populating from the input. Used by
  // `useAuthStore.login()` to seed the cache with the server's pre-login
  // notification backlog. Vanilla expects the input to already be in
  // chronological order (oldest-first); see `login.ts` `submit()` which
  // calls `res.notes.reverse()` before `loggedIn(res.notes, res.pokes)`.
  setNotes: (notes: CoreNote[]) => {
    set({ notes: notes.slice(0, noteCacheSize) })
  },

  setPokes: (pokes: CoreNote[]) => {
    set({ pokes: pokes.slice(0, noteCacheSize) })
  },

  // ackNotes mirrors dev2 `app.ts ackNotes()` (L893): marks every unacked
  // entry as acked locally, collects the ids of unacked SUCCESS+ notes
  // (POKEs aren't sent — they have no server-side ack), and fires a single
  // batched `acknotes` WS request.
  ackNotes: () => {
    const acks: string[] = []
    set(prev => {
      const notes = prev.notes.map(n => {
        if (n.acked) return n
        if (n.id && n.severity > POKE) acks.push(n.id)
        return { ...n, acked: true }
      })
      const pokes = prev.pokes.map(p => p.acked ? p : { ...p, acked: true })
      return { notes, pokes }
    })
    if (acks.length) {
      useWebSocketStore.getState().request('acknotes', acks)
    }
  },

  removePopup: (id: number) => {
    set(prev => ({
      popupQueue: prev.popupQueue.filter(p => p.id !== id),
    }))
  },

  registerNoteFeeder: (receivers: Record<string, (n: CoreNote) => void>) => {
    set(prev => ({
      noteReceivers: [...prev.noteReceivers, receivers]
    }))
    // Return unregister function for cleanup.
    return () => {
      set(prev => ({
        noteReceivers: prev.noteReceivers.filter(r => r !== receivers)
      }))
    }
  },
}))
