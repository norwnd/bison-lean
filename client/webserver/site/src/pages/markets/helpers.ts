import { useState, useEffect } from 'react'
import { formatRateAtomToRateStep, RateEncodingFactor } from '../../hooks/useFormatters'
import { filled } from '../../components/AccountUtils'
import OrderBook from '../../components/OrderBook'
import type { Exchange, Market, MiniOrder, Order, UnitInfo } from '../../stores/types'
import {
  OrderTypeLimit, StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled, StatusRevoked, ImmediateTiF
} from '../../stores/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ORDER_BOOK_SIDE_MAX = 13
export const MAX_ACTIVE_ORDERS = 8
export const MAX_COMPLETED_ORDERS = 100
export const CANDLE_DUR_24H = '24h'
// Beyond this divergence (10%) an order is treated as completely irrelevant for
// the row-weight gradient (MP-05) and the rate-delta display is capped (MP-01).
export const MAX_PRICE_DIVERGENCE = 0.10

// MP-44: Labels match vanilla (markets.ts L77-81): lowercase,
// singular "month", no plural on "3 month". Vanilla key values are
// also the exact label strings; we keep separate keys here only because
// `'1 day'` with a space is awkward as a Map/state key.
export const COMPLETED_PERIODS: { key: string; label: string; ms: number }[] = [
  { key: 'hide', label: 'hide', ms: 0 },
  { key: '1d', label: '1 day', ms: 86400000 },
  { key: '1w', label: '1 week', ms: 604800000 },
  { key: '1m', label: '1 month', ms: 2592000000 },
  { key: '3m', label: '3 month', ms: 7776000000 }
]

export const RECENT_MATCHES_AGE_WINDOW_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface OrderBookDisplayRow {
  rate: number
  msgRate: number
  qty: number
  numOrders: number
  isEpoch: boolean
  hasOwnOrder: boolean
  deltaText: string
  deltaInverted: boolean
  priceRelevance: number
  rowWeightRatio: number
  key: string
}

export interface SelectedMarket {
  host: string
  baseID: number
  quoteID: number
}

export interface ExchangeMarket {
  host: string
  xc: Exchange
  mkt: Market
  baseSymbol: string
  quoteSymbol: string
  baseID: number
  quoteID: number
  mktID: string
  spot: Market['spot']
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function logoPath (symbol: string): string {
  let s = symbol.split('.')[0].toLowerCase()
  if (s === 'weth') s = 'eth'
  return `/img/coins/${s}.png`
}

export function ageSince (ms: number): string {
  let dur = Date.now() - ms
  if (dur < 1000) return '0s'
  const units: [number, string][] = [
    [31536000000, 'y'], [2592000000, 'mo'], [86400000, 'd'],
    [3600000, 'h'], [60000, 'min'], [1000, 's']
  ]
  let chunks = 0
  let result = ''
  for (const [divisor, label] of units) {
    const n = Math.floor(dur / divisor)
    dur %= divisor
    if (n === 0 && chunks === 0) continue
    result += `${n}${label} `
    chunks++
    if (chunks >= 2) break
  }
  return result.trim()
}

export function statusString (order: Order): string {
  if (!order.id) return 'Submitting...'
  const isLive = order.matches?.some(m => m.active) ?? false
  switch (order.status) {
    case StatusEpoch: return 'Epoch'
    case StatusBooked:
      if (order.cancelling) return 'Canceling'
      return isLive
        ? 'Settling'
        : 'Booked'
    case StatusExecuted:
      if (isLive) return 'Settling'
      if (filled(order) === 0 && order.type !== 3) return 'No Match'
      return 'Executed'
    case StatusCanceled:
      return isLive
        ? 'Settling'
        : 'Canceled'
    case StatusRevoked:
      return isLive
        ? 'Settling'
        : 'Revoked'
    default: return 'Unknown'
  }
}

export function typeString (ord: Order, t: (key: string) => string): string {
  // Vanilla (`orderutil.ts` L54): returns the i18n strings `limit`, `limit (i)`,
  // `market` — all lowercase. React had hardcoded capitalized English here;
  // switching to the same `MARKET_ORDER` / `LIMIT_ORDER` / `LIMIT_ORDER_IMMEDIATE_TIF`
  // keys as vanilla restores strict parity (landed with MP-42 where the
  // same `MARKET_ORDER` key is used by the header rate fallback).
  if (ord.type === OrderTypeLimit) {
    return ord.tif === ImmediateTiF
      ? t('LIMIT_ORDER_IMMEDIATE_TIF')
      : t('LIMIT_ORDER')
  }
  return t('MARKET_ORDER')
}

// averageRate returns the base-weighted average fill rate across an order's
// matches. Port of `orderutil.ts` `averageRate` (L132-144). Used by the
// market-order header/details rate string (MP-42).
export function averageRate (ord: Order): number {
  if (!ord.matches?.length) return 0
  let rateProduct = 0
  let baseQty = 0
  for (const m of ord.matches) {
    baseQty += m.qty
    rateProduct += m.rate * m.qty
  }
  return rateProduct / baseQty
}

// marketOrderRateString returns the text shown in a user order row's rate
// column when the order is a market order. Port of `markets.ts`
// `marketOrderHeaderRateString` / `marketOrderDetailsRateString` (L2241-2253):
//
//   - No matches yet → returns the localized "market" label (vanilla uses
//     `intl.prep(intl.ID_MARKET_ORDER)`, which is lowercase in en-us).
//   - One or more matches → returns the base-weighted average fill rate.
//     When there are ≥2 matches a "~ " prefix is added since the displayed
//     rate is a synthetic average.
//
// Vanilla's header and details functions are identical in behavior; we
// collapse them into one helper. The caller is responsible for the header
// "@ " prefix (applied uniformly for both market and limit orders at the
// UserOrderRow render site — vanilla L2014 / L2173).
export function marketOrderRateString (
  ord: Order,
  bui: UnitInfo,
  qui: UnitInfo,
  mkt: Market,
  marketLabel: string
): string {
  if (!ord.matches?.length) return marketLabel
  let rateStr = formatRateAtomToRateStep(averageRate(ord), bui, qui, mkt.ratestep, ord.sell)
  // Vanilla L2245/L2252: `~` only makes sense if the order has more than
  // one match (otherwise the "average" is just the single match's rate).
  if (ord.matches.length > 1) rateStr = '~ ' + rateStr
  return rateStr
}

/** Compute the mid-gap rate from the order book. */
export function midGapRate (book: OrderBook | null): number {
  if (!book) return 0
  const bestBuy = book.bestBuyRateAtom()
  const bestSell = book.bestSellRateAtom()
  if (bestBuy && bestSell) return (bestBuy + bestSell) / 2
  return bestBuy || bestSell || 0
}

/**
 * binOrdersByRateAndEpoch groups sorted orders by rate, placing booked and
 * epoch orders in separate bins (epoch bin comes after non-epoch bin when they
 * share a rate). Drives the grouped-row display with a .numorders badge.
 */
export function binOrdersByRateAndEpoch (orders: MiniOrder[]): MiniOrder[][] {
  if (!orders || !orders.length) return []
  const bins: MiniOrder[][] = []
  let currEpochBin: MiniOrder[] = []
  let currNonEpochBin: MiniOrder[] = []
  let currRate = orders[0].msgRate
  if (orders[0].epoch) currEpochBin.push(orders[0])
  else currNonEpochBin.push(orders[0])
  for (let i = 1; i < orders.length; i++) {
    if (orders[i].msgRate !== currRate) {
      bins.push(currNonEpochBin)
      bins.push(currEpochBin)
      currEpochBin = []
      currNonEpochBin = []
      currRate = orders[i].msgRate
    }
    if (orders[i].epoch) currEpochBin.push(orders[i])
    else currNonEpochBin.push(orders[i])
  }
  bins.push(currNonEpochBin)
  bins.push(currEpochBin)
  return bins.filter(bin => bin.length > 0)
}

/** Parse a decimal string to a rate atom value. Returns 0 on failure. */
export function parseConvRate (s: string, bui: UnitInfo, qui: UnitInfo): number {
  const v = parseFloat(s.replace(',', '.'))
  if (!v || isNaN(v) || v <= 0) return 0
  return v * RateEncodingFactor / (bui.conventional.conversionFactor / qui.conventional.conversionFactor)
}

/** Parse a decimal string to a qty atom value. Returns 0 on failure. */
export function parseConvQty (s: string, bui: UnitInfo): number {
  const v = parseFloat(s.replace(',', '.'))
  if (!v || isNaN(v) || v <= 0) return 0
  return Math.round(v * bui.conventional.conversionFactor)
}

export function collectMarkets (exchanges: Record<string, Exchange>): ExchangeMarket[] {
  const result: ExchangeMarket[] = []
  for (const [host, xc] of Object.entries(exchanges)) {
    for (const mkt of Object.values(xc.markets)) {
      result.push({
        host,
        xc,
        mkt,
        baseSymbol: mkt.basesymbol,
        quoteSymbol: mkt.quotesymbol,
        baseID: mkt.baseid,
        quoteID: mkt.quoteid,
        mktID: mkt.name,
        spot: mkt.spot
      })
    }
  }
  result.sort((a, b) => {
    const volA = a.spot?.vol24 ?? 0
    const volB = b.spot?.vol24 ?? 0
    return volB - volA
  })
  return result
}

// shortSymbol — port of vanilla `Doc.shortSymbol` (doc.ts L709). Strips any
// parent-chain suffix and upper-cases. Drive-by: this helper is duplicated in
// several pages (see cleanup notes); a shared util would consolidate them.
export function shortSymbol (symbol: string): string {
  return symbol.split('.')[0].toUpperCase()
}

// ---------------------------------------------------------------------------
// Custom hook
// ---------------------------------------------------------------------------

// useSecondTicker bumps a 1-Hz counter that forces the calling component to
// re-render every second while `enabled` is true. Used by `UserOrderRow`
// (active variant only) and the `RecentMatchesTable` component so their
// age columns tick live — mirroring the single `window.setInterval` vanilla
// sets up in `markets.ts` L561-566. Each calling component owns its own
// interval; the cost is trivial and it keeps the re-render scope local
// (no full-MarketsPage re-renders).
//
// The `enabled` flag lets callers opt out (e.g. completed user orders,
// whose age text is frozen at draw time in vanilla — L2178 — and shouldn't
// live-update in React either, for strict parity).
export function useSecondTicker (enabled: boolean = true): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setTick(tk => tk + 1), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
}
