// MMSettings shell (placeholder) — contexts + shared types used by
// sibling mmsettings components ported from vanilla
// `mmsettings/components/MMSettings.tsx`.
//
// B-L-MMS-STUB-2 only ports the context plumbing; the full component
// tree (tab shell + form orchestration) arrives in B-L-MMS-STUB-9.
// Keeping the context in the same file/path as vanilla avoids churning
// import statements across consumers (ErrorPopup, later tabs, etc.)
// when the real component lands.

import React, { createContext, useContext } from 'react'

export interface MMSettingsError {
  message: string
  onClose?: () => void
}

// AvailableMarket is the row shape consumed by MarketSelector and the
// top-level MMSettingsPage dropdown. Lean adds `vol24` (used for the
// usd-equivalent volume sort) — vanilla had a `hasArb` field here that
// is never read by MarketSelector (supported-cex presence is computed
// fresh via `checkCexMarketSupport`), so it's intentionally omitted.
export interface AvailableMarket {
  host: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
  vol24: number
}

// MMSettingsSetErrorContext lets any descendant surface a user-visible
// error without threading callbacks through every intermediate component.
// The provider (batch 9) holds the error state and renders `ErrorPopup`.
export const MMSettingsSetErrorContext = createContext<React.Dispatch<MMSettingsError | null> | undefined>(undefined)

// MMSettingsSetLoadingContext exposes a page-wide loading overlay
// toggle for async operations (bridge fee lookups, etc.).
export const MMSettingsSetLoadingContext = createContext<React.Dispatch<boolean> | undefined>(undefined)

export const useMMSettingsSetError = () => {
  const context = useContext(MMSettingsSetErrorContext)
  if (context === undefined) {
    throw new Error('useMMSettingsSetError must be used within a MMSettingsSetErrorProvider')
  }
  return context
}

export const useMMSettingsSetLoading = () => {
  const context = useContext(MMSettingsSetLoadingContext)
  if (context === undefined) {
    throw new Error('useMMSettingsSetLoading must be used within a MMSettingsSetLoadingProvider')
  }
  return context
}
