// API wrapper functions for the market-making (mmsettings) subsystem.
//
// Mirrors the 12 methods on vanilla's `MM` singleton (class
// `MarketMakerBot` at `client/webserver/site/src/js/mmutil.ts`), plus
// re-exports the two MM-adjacent bridge endpoints that live in
// `components/bridging/bridgeApi.ts`, so mmsettings modules have a
// single import surface.
//
// Response shapes mirror the inline structs in
// `client/webserver/api.go` (apiUpdateBotConfig / apiMarketReport /
// apiAvailableBalances / etc.). Each wrapper returns a structured
// result so callers can branch on `res.ok` and access typed payload
// fields even on failure (empty defaults) — same idiom as
// `bridgeApi.ts`.
//
// Not in scope for mmsettings: `apiCEXBalance` (used only by MMPage).

import { getJSON, postJSON, checkResponse } from './api'
import type {
  BotConfig,
  CEXConfig,
  MarketWithHost,
  MarketMakingStatus,
  MarketReport,
  BotInventoryDiffs,
  AutoRebalanceConfig
} from '../stores/types'

export { allBridgePaths, bridgeFeesAndLimits } from '../components/bridging/bridgeApi'
export type { BridgePathsResult, BridgeFeesAndLimitsResult } from '../components/bridging/bridgeApi'

// Minimal ack returned by endpoints that only signal success/failure.
export interface AckResult {
  ok: boolean
  msg?: string
}

export interface MMStatusResult {
  ok: boolean
  msg?: string
  status: MarketMakingStatus | null
}

export interface MarketReportResult {
  ok: boolean
  msg?: string
  report: MarketReport | null
}

export interface MaxFundingFeesResult {
  ok: boolean
  msg?: string
  buyFees: number
  sellFees: number
}

export interface EstimateSendTxFeeResult {
  ok: boolean
  msg?: string
  txfee: number
  validAddress: boolean
}

export interface NewDepositAddressResult {
  ok: boolean
  msg?: string
  address: string
}

export interface AvailableBalancesResult {
  ok: boolean
  msg?: string
  dexBalances: Record<number, number>
  cexBalances: Record<number, number>
}

export async function mmStatus (): Promise<MMStatusResult> {
  const res = await getJSON('/api/marketmakingstatus')
  if (!checkResponse(res)) return { ok: false, msg: res.msg, status: null }
  return { ok: true, status: res.status }
}

export async function updateBotConfig (cfg: BotConfig): Promise<AckResult> {
  const res = await postJSON('/api/updatebotconfig', cfg)
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function updateRunningBot (
  cfg: BotConfig,
  diffs: BotInventoryDiffs,
  autoRebalanceCfg?: AutoRebalanceConfig
): Promise<AckResult> {
  const body: { cfg: BotConfig; diffs: BotInventoryDiffs; autoRebalanceCfg?: AutoRebalanceConfig } = { cfg, diffs }
  if (autoRebalanceCfg) body.autoRebalanceCfg = autoRebalanceCfg
  const res = await postJSON('/api/updaterunningbot', body)
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function updateCEXConfig (cfg: CEXConfig): Promise<AckResult> {
  const res = await postJSON('/api/updatecexconfig', cfg)
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function removeBotConfig (host: string, baseID: number, quoteID: number): Promise<AckResult> {
  const res = await postJSON('/api/removebotconfig', { host, baseID, quoteID })
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function marketReport (host: string, baseID: number, quoteID: number): Promise<MarketReportResult> {
  const res = await postJSON('/api/marketreport', { host, baseID, quoteID })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, report: null }
  return { ok: true, report: res.report as MarketReport }
}

export async function maxFundingFees (
  market: MarketWithHost,
  maxBuyPlacements: number,
  maxSellPlacements: number,
  baseOptions: Record<string, string>,
  quoteOptions: Record<string, string>
): Promise<MaxFundingFeesResult> {
  const res = await postJSON('/api/maxfundingfees', {
    market,
    maxBuyPlacements,
    maxSellPlacements,
    baseOptions,
    quoteOptions
  })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, buyFees: 0, sellFees: 0 }
  return { ok: true, buyFees: res.buyFees, sellFees: res.sellFees }
}

export async function estimateSendTxFee (
  addr: string,
  assetID: number,
  value: number,
  subtract = false,
  maxWithdraw = false
): Promise<EstimateSendTxFeeResult> {
  const res = await postJSON('/api/txfee', { addr, assetID, value, subtract, maxWithdraw })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, txfee: 0, validAddress: false }
  return { ok: true, txfee: res.txfee, validAddress: res.validaddress }
}

export async function newDepositAddress (assetID: number): Promise<NewDepositAddressResult> {
  const res = await postJSON('/api/depositaddress', { assetID })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, address: '' }
  return { ok: true, address: res.address }
}

export async function startBot (config: MarketWithHost): Promise<AckResult> {
  const res = await postJSON('/api/startmarketmakingbot', { config })
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function stopBot (market: MarketWithHost): Promise<AckResult> {
  const res = await postJSON('/api/stopmarketmakingbot', { market })
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true }
}

export async function availableBalances (
  market: MarketWithHost,
  cexBaseID: number,
  cexQuoteID: number,
  cexName?: string
): Promise<AvailableBalancesResult> {
  const res = await postJSON('/api/availablebalances', { market, cexBaseID, cexQuoteID, cexName })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, dexBalances: {}, cexBalances: {} }
  return { ok: true, dexBalances: res.dexBalances ?? {}, cexBalances: res.cexBalances ?? {} }
}
