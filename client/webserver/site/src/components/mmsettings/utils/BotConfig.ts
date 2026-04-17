// BotConfig — reducer + context scaffolding for mmsettings
// (placeholder for batch 4).
//
// This stub exists so batch 2 leaf components that depend on the
// BotConfig context (currently only `PlacementsChartWrapper`) can be
// compiled and type-checked in isolation. The full 1557-line vanilla
// port (`mmsettings/utils/BotConfig.ts`) will replace this file in
// B-L-MMS-STUB-4; the exported shapes and hook names are pre-aligned
// with vanilla so the swap is additive.
//
// Until then, `useBotConfigState()` returns an empty/null snapshot,
// which consumers must already handle (vanilla's own effects guard on
// `!botConfig || !dexMarket`).

import type { BotConfig } from '../../../stores/types'

export interface MarketInfo {
  host: string
  baseID: number
  quoteID: number
  baseFeeAssetID: number
  quoteFeeAssetID: number
  lotSize: number
  quoteLot: number
  baseIsAccountLocker: boolean
  quoteIsAccountLocker: boolean
}

export interface QuickPlacementsConfig {
  priceLevelsPerSide: number
  lotsPerLevel: number
  priceIncrement: number
  profitThreshold: number
  matchBuffer: number
}

export interface BotConfigState {
  botConfig: BotConfig | null
  dexMarket: MarketInfo | null
  quickPlacements: QuickPlacementsConfig | null
  fiatRatesMap: Record<number, number>
}

const EMPTY_STATE: BotConfigState = {
  botConfig: null,
  dexMarket: null,
  quickPlacements: null,
  fiatRatesMap: {}
}

export const useBotConfigState = (): BotConfigState => {
  return EMPTY_STATE
}
