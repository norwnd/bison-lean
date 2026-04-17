// MMSettings shell (placeholder) — contexts used by sibling mmsettings
// components ported from vanilla `mmsettings/components/MMSettings.tsx`.
//
// B-L-MMS-STUB-2 only ports the context plumbing; the full component
// tree (tab shell + form orchestration) arrives in B-L-MMS-STUB-9.
// Keeping the context in the same file/path as vanilla avoids churning
// import statements across consumers (ErrorPopup, later tabs, etc.)
// when the real component lands.

import { createContext } from 'react'

export interface MMSettingsError {
  message: string
  onClose?: () => void
}

// MMSettingsSetErrorContext lets any descendant surface a user-visible
// error without threading callbacks through every intermediate component.
// The provider (batch 9) holds the error state and renders `ErrorPopup`.
export const MMSettingsSetErrorContext = createContext<((err: MMSettingsError | null) => void) | null>(null)
