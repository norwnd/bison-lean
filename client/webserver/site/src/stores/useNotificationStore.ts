import { create } from 'zustand'
import type { CoreNote } from './types'

const noteCacheSize = 100

interface NotificationState {
  notes: CoreNote[]
  pokes: CoreNote[]
  noteReceivers: Record<string, (n: CoreNote) => void>[]

  notify: (note: CoreNote) => void
  addNotes: (notes: CoreNote[]) => void
  setPokes: (pokes: CoreNote[]) => void
  ackNotes: () => void
  registerNoteFeeder: (receivers: Record<string, (n: CoreNote) => void>) => () => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notes: [],
  pokes: [],
  noteReceivers: [],

  notify: (note: CoreNote) => {
    const state = get()

    // Dispatch to registered feeders.
    for (const receivers of state.noteReceivers) {
      const handler = receivers[note.type]
      if (handler) handler(note)
    }

    // Store the note.
    set(prev => {
      const notes = [note, ...prev.notes].slice(0, noteCacheSize)
      return { notes }
    })
  },

  addNotes: (notes: CoreNote[]) => {
    set(prev => ({
      notes: [...notes, ...prev.notes].slice(0, noteCacheSize)
    }))
  },

  setPokes: (pokes: CoreNote[]) => {
    set({ pokes })
  },

  ackNotes: () => {
    set(prev => ({
      pokes: prev.pokes.map(p => ({ ...p, acked: true }))
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
