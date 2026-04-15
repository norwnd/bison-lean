import { useEffect, useRef } from 'react'
import { useNotificationStore } from '../stores/useNotificationStore'
import type { CoreNote } from '../stores/types'

// useNotifications registers page-specific note handlers on mount
// and unregisters on unmount. This replaces app().registerNoteFeeder().
//
// T18#11: the hook previously registered the `receivers` object
// captured at first render and never updated the registration when
// `receivers` changed. That was a latent bug: if a caller built a
// fresh `receivers` object each render (common pattern since
// handlers close over reducer state or props), the store kept
// calling the FIRST render's handlers with their stale closures.
// For BridgingPopup specifically, this meant a second bridge note
// arriving after a first one would process with state captured
// before the first note's dispatch, overwriting it.
//
// Fix: keep a single stable receivers object in a ref and mutate
// it in place on every render to track the caller's current
// handlers. The store holds a reference to the same stable object
// for the component's entire lifetime, so its `receivers[type]`
// lookups always reach the freshest handler. No re-registration
// churn either -- the effect only runs once (on mount) to register
// the stable ref with the store, and once on unmount to remove it.
export function useNotifications (receivers: Record<string, (n: CoreNote) => void>) {
  // Stable receivers object. Same reference for the component's
  // lifetime; its keys are synced to `receivers` on every render.
  const stableRef = useRef<Record<string, (n: CoreNote) => void>>({})

  // Sync the stable object to the latest receivers on every render.
  // Mutating a ref during render is safe (it doesn't trigger
  // re-renders and doesn't affect React's reconciliation output).
  // First drop keys that the caller no longer provides, then
  // overwrite remaining keys with the current handlers.
  for (const key of Object.keys(stableRef.current)) {
    if (!(key in receivers)) delete stableRef.current[key]
  }
  for (const key of Object.keys(receivers)) {
    stableRef.current[key] = receivers[key]
  }

  const registerNoteFeeder = useNotificationStore(s => s.registerNoteFeeder)

  useEffect(() => {
    // Register the stable ref once on mount. Because it's the same
    // object reference for the component's whole lifetime, the store
    // keeps a stable entry and we avoid re-registration churn even
    // though `receivers` changes on every render.
    const unregister = registerNoteFeeder(stableRef.current)
    return unregister
  }, [registerNoteFeeder])
}
