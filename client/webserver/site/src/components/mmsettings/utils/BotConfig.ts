// BotConfig — reducer + context scaffolding for mmsettings
// (placeholder for batch 4).
//
// This stub exists so batches 2-3 can compile the mmsettings components
// and utilities that depend on the BotConfig context/state before the
// full 1557-line vanilla port (`mmsettings/utils/BotConfig.ts`) lands.
// The exported shapes and hook names are pre-aligned with vanilla so
// the swap is additive.
//
// Until batch 4 lands, `useBotConfigState()` returns a safe empty
// snapshot — callers that mount against it will see an unconfigured
// bot (no placements, zero balances, etc.) rather than crash.

import type {
  BotConfig,
  BotInventoryDiffs,
  MarketReport,
  LotFees,
  LotFeeRange,
  BridgeFeesAndLimits,
  MMCEXStatus,
  RunStats,
  OrderOption
} from '../../../stores/types'

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

// Mirrors vanilla `utils/BotConfig.ts` — a withdraw/deposit pair plus
// the CEX-side asset (may differ from the DEX asset when bridging) and
// the bridge protocol name. Populated for each side when auto-rebalance
// is enabled and the bridge path has been resolved.
export interface RoundTripFeesAndLimits {
  withdrawal: BridgeFeesAndLimits
  deposit: BridgeFeesAndLimits
  cexAsset: number
  bridgeName: string
}

export interface BotConfigState {
  botConfig: BotConfig
  inventoryDiffs: BotInventoryDiffs
  dexMarket: MarketInfo
  availableDEXBalances: Record<number, number>
  availableCEXBalances: Record<number, number> | null
  baseBridgeFeesAndLimits: RoundTripFeesAndLimits | null
  quoteBridgeFeesAndLimits: RoundTripFeesAndLimits | null
  quickPlacements: QuickPlacementsConfig | null
  runStats: RunStats | null
  marketReport: MarketReport
  baseMultiFundingOpts: OrderOption[] | null
  quoteMultiFundingOpts: OrderOption[] | null
  cexStatus: MMCEXStatus | null
  fiatRatesMap: Record<number, number>
  buyFundingFees: number
  sellFundingFees: number
  baseExternalFee: number
  quoteExternalFee: number
}

function emptyLotFees (): LotFees {
  return { swap: 0, redeem: 0, refund: 0 }
}

function emptyLotFeeRange (): LotFeeRange {
  return { max: emptyLotFees(), estimated: emptyLotFees() }
}

function emptyBotConfig (): BotConfig {
  return {
    host: '',
    baseID: 0,
    quoteID: 0,
    cexBaseID: 0,
    cexQuoteID: 0,
    baseBridgeName: '',
    quoteBridgeName: '',
    baseWalletOptions: null,
    quoteWalletOptions: null,
    cexName: '',
    uiConfig: {
      quickBalance: {
        buysBuffer: 0,
        sellsBuffer: 0,
        buyFeeReserve: 0,
        sellFeeReserve: 0,
        rebalanceFeeReserve: 0,
        slippageBuffer: 0
      },
      usingQuickBalance: false
    }
  }
}

function emptyMarketInfo (): MarketInfo {
  return {
    host: '',
    baseID: 0,
    quoteID: 0,
    baseFeeAssetID: 0,
    quoteFeeAssetID: 0,
    lotSize: 0,
    quoteLot: 0,
    baseIsAccountLocker: false,
    quoteIsAccountLocker: false
  }
}

function emptyMarketReport (): MarketReport {
  return {
    price: 0,
    oracles: [],
    baseFiatRate: 0,
    quoteFiatRate: 0,
    baseFees: emptyLotFeeRange(),
    quoteFees: emptyLotFeeRange()
  }
}

const EMPTY_STATE: BotConfigState = {
  botConfig: emptyBotConfig(),
  inventoryDiffs: { dex: {}, cex: {} },
  dexMarket: emptyMarketInfo(),
  availableDEXBalances: {},
  availableCEXBalances: null,
  baseBridgeFeesAndLimits: null,
  quoteBridgeFeesAndLimits: null,
  quickPlacements: null,
  runStats: null,
  marketReport: emptyMarketReport(),
  baseMultiFundingOpts: null,
  quoteMultiFundingOpts: null,
  cexStatus: null,
  fiatRatesMap: {},
  buyFundingFees: 0,
  sellFundingFees: 0,
  baseExternalFee: 0,
  quoteExternalFee: 0
}

export const useBotConfigState = (): BotConfigState => {
  return EMPTY_STATE
}
