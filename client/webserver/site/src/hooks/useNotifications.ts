import { useEffect } from 'react'
import { useNotificationStore } from '../stores/useNotificationStore'
import type { CoreNote } from '../stores/types'

// useNotifications registers page-specific note handlers on mount
// and unregisters on unmount. This replaces app().registerNoteFeeder().
export function useNotifications (receivers: Record<string, (n: CoreNote) => void>) {
  const registerNoteFeeder = useNotificationStore(s => s.registerNoteFeeder)

  useEffect(() => {
    const unregister = registerNoteFeeder(receivers)
    return unregister
  }, [registerNoteFeeder]) // receivers should be stable (defined outside render or memoized)
}
