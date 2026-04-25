import { create } from 'zustand'
import type { ActionRequiredNote } from './types'

// Wallet action-required notes are deduped by `uniqueID` (the wallet uses
// txID for tooCheap/lostNonce, a per-asset string like
// `missingNonces_<chainID>` for missingNonces). On a duplicate uniqueID
// arriving (e.g. a re-emitted prompt after the user's previous Wait
// cooled down) we replace the entry rather than append, keeping the
// queue free of stale clones with the same uniqueID.

interface ActionRequiredState {
  // queue is the FIFO of pending action-required notes. The dispatcher
  // dialog renders queue[0] (the head) and the user resolves it before
  // the next pops up. Order = arrival order; duplicates by uniqueID
  // overwrite the existing entry in place to preserve queue position
  // (so a re-prompt doesn't cut the line).
  queue: ActionRequiredNote[]

  // enqueue adds (or replaces by uniqueID) a note into the queue.
  enqueue: (n: ActionRequiredNote) => void
  // resolve removes a note by uniqueID. Called when the wallet emits an
  // actionResolved note (the canonical signal that the underlying state
  // changed and the dialog should close).
  resolve: (uniqueID: string) => void
  // reset clears the entire queue. Used on logout / user switch.
  reset: () => void
  // seed replaces the queue with the given notes preserving order.
  // Used by the auth store on /api/user load to hydrate the initial
  // backlog from `User.actions[]`.
  seed: (notes: ActionRequiredNote[]) => void
}

export const useActionRequiredStore = create<ActionRequiredState>((set) => ({
  queue: [],
  enqueue: (n) => set(prev => {
    const idx = prev.queue.findIndex(q => q.uniqueID === n.uniqueID)
    if (idx >= 0) {
      const next = prev.queue.slice()
      next[idx] = n
      return { queue: next }
    }
    return { queue: [...prev.queue, n] }
  }),
  resolve: (uniqueID) => set(prev => ({
    queue: prev.queue.filter(q => q.uniqueID !== uniqueID),
  })),
  reset: () => set({ queue: [] }),
  seed: (notes) => set({ queue: notes.slice() }),
}))
