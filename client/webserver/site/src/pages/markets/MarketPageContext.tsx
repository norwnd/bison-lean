import { createContext, useContext } from 'react'
import type { Market, UnitInfo } from '../../stores/types'
import type { SelectedMarket } from './helpers'

// The 4 values every MarketsPage sub-component needs, pre-null-checked by
// MarketsPage before rendering children. Sub-components call
// useMarketPageContext() and never need null guards on these values.
export interface MarketPageContextValue {
  selected: SelectedMarket
  currentMkt: Market
  bui: UnitInfo
  qui: UnitInfo
}

const MarketPageContext = createContext<MarketPageContextValue | null>(null)

export function MarketPageProvider ({ value, children }: {
  value: MarketPageContextValue
  children: React.ReactNode
}) {
  return (
    <MarketPageContext.Provider value={value}>
      {children}
    </MarketPageContext.Provider>
  )
}

export function useMarketPageContext (): MarketPageContextValue {
  const ctx = useContext(MarketPageContext)
  if (!ctx) throw new Error('useMarketPageContext must be used within MarketPageProvider')
  return ctx
}
