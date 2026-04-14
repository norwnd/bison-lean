import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { leftMarketDockLK, lastCandleDurationLK, lastMarketLK, orderDisclaimerAckedLK, fetchLocal, storeLocal } from '../services/state'
import { useAuthStore } from '../stores/useAuthStore'
import { useUIStore } from '../stores/useUIStore'
import { useWebSocketStore } from '../stores/useWebSocketStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { ReputationMeter } from '../components/common/ReputationMeter'
import { CandleChart, CandleReporters } from '../components/charts/CandleChart'
import { Wave } from '../components/charts/Wave'
import OrderBook from '../components/OrderBook'
import {
  formatCoinValue, formatRateFullPrecision,
  formatRateAtomToRateStep, formatRateToRateStep,
  formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency,
  formatBestWeCan, formatFiatConversion,
  adjRateAtomsBuy, adjRateAtomsSell, RateEncodingFactor
} from '../hooks/useFormatters'
import {
  filled, settled, isCancellable, hasActiveMatches, strongTier,
  tradingLimits, baseToQuote
} from '../components/AccountUtils'
import { orderPath } from '../router/routes'
import type {
  Exchange, Market, MiniOrder, MarketOrderBook, CandlesPayload, Order,
  OrderNote, MatchNote, SpotPriceNote, BalanceNote, EpochNote, BookUpdate,
  UnitInfo, Candle, RecentMatch, MaxOrderEstimate, OrderFilter,
  ConnEventNote, BondNote, WalletStateNote, RemainderUpdate, SupportedAsset
} from '../stores/types'
import {
  OrderTypeLimit, OrderTypeMarket, StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled, StatusRevoked, ImmediateTiF, ConnectionStatus,
  ApprovalStatus
} from '../stores/types'
import { TokenApprovalForm } from '../components/common/TokenApprovalForm'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORDER_BOOK_SIDE_MAX = 13
const MAX_ACTIVE_ORDERS = 8
const MAX_COMPLETED_ORDERS = 100
const CANDLE_DUR_24H = '24h'
// Beyond this divergence (10%) an order is treated as completely irrelevant for
// the row-weight gradient (MP-05) and the rate-delta display is capped (MP-01).
const MAX_PRICE_DIVERGENCE = 0.10

// MP-44: Labels match vanilla (markets.ts L77-81): lowercase,
// singular "month", no plural on "3 month". Vanilla key values are
// also the exact label strings; we keep separate keys here only because
// `'1 day'` with a space is awkward as a Map/state key.
const COMPLETED_PERIODS: { key: string; label: string; ms: number }[] = [
  { key: 'hide', label: 'hide', ms: 0 },
  { key: '1d', label: '1 day', ms: 86400000 },
  { key: '1w', label: '1 week', ms: 604800000 },
  { key: '1m', label: '1 month', ms: 2592000000 },
  { key: '3m', label: '3 month', ms: 7776000000 }
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logoPath (symbol: string): string {
  let s = symbol.split('.')[0].toLowerCase()
  if (s === 'weth') s = 'eth'
  return `/img/coins/${s}.png`
}

function ageSince (ms: number): string {
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

function statusString (order: Order): string {
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

function typeString (ord: Order, t: (key: string) => string): string {
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
function averageRate (ord: Order): number {
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
function marketOrderRateString (
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
function useSecondTicker (enabled: boolean = true): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setTick(tk => tk + 1), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
}

/** Compute the mid-gap rate from the order book. */
function midGapRate (book: OrderBook | null): number {
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
function binOrdersByRateAndEpoch (orders: MiniOrder[]): MiniOrder[][] {
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

interface OrderBookDisplayRow {
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

/** Parse a decimal string to a rate atom value. Returns 0 on failure. */
function parseConvRate (s: string, bui: UnitInfo, qui: UnitInfo): number {
  const v = parseFloat(s.replace(',', '.'))
  if (!v || isNaN(v) || v <= 0) return 0
  return v * RateEncodingFactor / (bui.conventional.conversionFactor / qui.conventional.conversionFactor)
}

/** Parse a decimal string to a qty atom value. Returns 0 on failure. */
function parseConvQty (s: string, bui: UnitInfo): number {
  const v = parseFloat(s.replace(',', '.'))
  if (!v || isNaN(v) || v <= 0) return 0
  return Math.round(v * bui.conventional.conversionFactor)
}

interface SelectedMarket {
  host: string
  baseID: number
  quoteID: number
}

interface ExchangeMarket {
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

function collectMarkets (exchanges: Record<string, Exchange>): ExchangeMarket[] {
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

// ---------------------------------------------------------------------------
// UserOrderRow — expandable row matching original .user-order template
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OrderBookRow — one grouped row in the order book
// Implements MP-01 (rate delta), MP-02 (own-order marker),
// MP-03 (epoch check icons), MP-04 (numorders badge),
// MP-05 (weight gradient background).
// ---------------------------------------------------------------------------
interface OrderBookRowProps {
  row: OrderBookDisplayRow
  sell: boolean
  bui: UnitInfo
  qui: UnitInfo
  ratestep: number
  lotsize: number
  darkMode: boolean
  onClick: () => void
}

function OrderBookRow ({ row, sell, bui, qui, ratestep, lotsize, darkMode, onClick }: OrderBookRowProps) {
  // MP-05: background gradient colors match the pre-migration palette.
  const buyBg = darkMode ? '#102821' : '#d9f5e1'
  const sellBg = darkMode ? '#35141D' : '#ffe7e7'
  const bgColor = sell ? sellBg : buyBg
  const bgPct = row.priceRelevance * row.rowWeightRatio * 100
  const bgStyle: React.CSSProperties = {
    background: `linear-gradient(to left, ${bgColor} ${bgPct}%, transparent 0%)`
  }

  // MP-01: rate delta color inverts when the order sits on the "wrong" side of
  // the external price, so the operator can see it at a glance.
  const baseColor = sell ? 'var(--sell-color)' : 'var(--buy-color)'
  const invertedColor = sell ? 'var(--buy-color)' : 'var(--sell-color)'
  const deltaColor = row.deltaInverted ? invertedColor : baseColor

  return (
    <tr
      className="d-flex justify-content-between px-2 w-100 pointer"
      style={bgStyle}
      onClick={onClick}
    >
      <td className="d-flex align-items-center text-nowrap pe-2">
        <span className="fs17" style={{ color: baseColor }}>
          {formatRateAtomToRateStep(row.rate, bui, qui, ratestep, sell)}
        </span>
        <span className="fs14 ps-1" style={{ color: deltaColor }}>
          {row.deltaText}
        </span>
        {row.hasOwnOrder && <div className="own-book-order fs8 ms-1" />}
        {row.isEpoch && (
          sell
            ? <span className="ico-check-sell fs10 ps-1" />
            : <span className="ico-check-buy fs10 ps-1" />
        )}
      </td>
      <td className="d-flex justify-content-end align-items-center ps-2">
        {row.numOrders > 1 && (
          <small
            className="numorders lh1 border-rounded3 text-center"
            title={`quantity is comprised of ${row.numOrders} orders`}
          >
            {row.numOrders}
          </small>
        )}
        <div className="fs17 ms-2">
          {formatCoinAtomToLotSizeBaseCurrency(row.qty, bui, lotsize)}
        </div>
      </td>
    </tr>
  )
}

interface UserOrderRowProps {
  order: Order
  bui: UnitInfo | null
  qui: UnitInfo | null
  mkt: Market | null
  navigate: (path: string) => void
  cancelOrder?: (id: string) => void
  // Differentiates active vs completed user orders. Matches vanilla's
  // two separate render paths (`drawRecentlyActiveUserOrders` vs
  // `drawCompletedUserOrders`), which use different header text for
  // side/qty/status.
  variant: 'active' | 'completed'
  // Ref to the rightmost-panel scroll container (vanilla `orderScroller`)
  // — the MP-37 floater menu repositions on scroll so it stays anchored
  // to its owning row's header.
  scrollRef: React.RefObject<HTMLDivElement | null>
}

function UserOrderRow ({ order, bui, qui, mkt, navigate, cancelOrder, variant, scrollRef }: UserOrderRowProps) {
  const { t } = useTranslation()
  // MP-43: Force a 1 Hz re-render for active orders so the details.age
  // column ticks live (vanilla markets.ts L561-566). We deliberately do
  // NOT tick completed rows — vanilla's interval only touches
  // `recentlyActiveUserOrders`, leaving the completed-order ages stale
  // until the user reopens the page. Preserving this quirk for strict
  // parity; the small drift on the completed-order header age (added in
  // MP-41) is acceptable.
  useSecondTicker(variant === 'active')

  const [expanded, setExpanded] = useState(false)

  // MP-37: Floater-menu state. `floaterPos` is null when hidden; when
  // shown, holds viewport coordinates used by the createPortal'd menu.
  // Separate refs track the row header (for positioning + hover-region
  // detection) and the floater element (also for hover-region detection).
  // The hideTimer is a brief grace period so that moving the mouse from
  // the header down into the floater doesn't blink it off — mouseleave
  // fires on the header before mouseenter fires on the floater.
  const headerRef = useRef<HTMLDivElement>(null)
  const floaterRef = useRef<HTMLDivElement>(null)
  const [floaterPos, setFloaterPos] = useState<{ top: number; left: number } | null>(null)
  const hideTimerRef = useRef<number | null>(null)

  const isBuy = !order.sell
  const filledPct = order.qty > 0 ? (filled(order) / order.qty * 100).toFixed(1) : '0.0'
  const settledPct = order.qty > 0 ? (settled(order) / order.qty * 100).toFixed(1) : '0.0'
  // MP-42: Recognize market orders so the rate column can render the
  // averaged-over-matches string instead of the book-rate string.
  const isMarketOrder = order.type === OrderTypeMarket
  const marketLabel = t('MARKET_ORDER')

  // MP-40 / MP-41: Active shows unfilled (remaining), completed shows settled.
  // Vanilla: `unfilledFormatted = ord.qty - OrderUtil.filled(ord)` for active
  // (L2003-2006), `settledFormatted = OrderUtil.settled(ord)` for completed
  // (L2168-2170).
  const headerQtyAtom = variant === 'active'
    ? order.qty - filled(order)
    : settled(order)
  const headerQtyStr = bui && mkt
    ? formatCoinAtomToLotSizeBaseCurrency(headerQtyAtom, bui, mkt.lotsize)
    : ''

  // MP-39 / MP-42: Header rate is formatted as `@ <rate>` (vanilla L2014 /
  // L2173). For market orders, `<rate>` comes from `marketOrderRateString`
  // — either the "market" label (no matches yet) or the base-weighted
  // average of matched rates (with a "~ " prefix when >1 matches).
  const headerRateStr = (() => {
    if (!bui || !qui || !mkt) return ''
    const body = isMarketOrder
      ? marketOrderRateString(order, bui, qui, mkt, marketLabel)
      : formatRateAtomToRateStep(order.rate, bui, qui, mkt.ratestep, order.sell)
    return `@ ${body}`
  })()
  // Details rate mirrors header rate but without the "@ " prefix (vanilla
  // sets `details.rate.textContent = detailsRateStr` with no prefix).
  const detailsRateStr = (() => {
    if (!bui || !qui || !mkt) return ''
    return isMarketOrder
      ? marketOrderRateString(order, bui, qui, mkt, marketLabel)
      : formatRateAtomToRateStep(order.rate, bui, qui, mkt.ratestep, order.sell)
  })()

  // MP-41: Completed header uses "bought" / "sold" (vanilla L2165). Active
  // uses lowercase "buy" / "sell" via `OrderUtil.sellString` (L1994).
  const headerSideWord = variant === 'completed'
    ? (order.sell ? 'sold' : 'bought')
    : (order.sell ? 'sell' : 'buy')

  // Vanilla renders different text in the header's status column per
  // variant: active → order status ("Booked", "Settling", etc.; L2023 via
  // `updateMetaOrder`), completed → age since order was submitted (L2178).
  const headerStatusText = variant === 'active'
    ? statusString(order)
    : ageSince(order.stamp)

  // MP-38: Apply `unready-user-order` class when an active user order is
  // on a wallet that isn't ready-to-tick and has in-flight matches (vanilla
  // L1987-1990). Completed orders don't get this class.
  const isUnready = variant === 'active' && !order.readyToTick && hasActiveMatches(order)
  const headerClasses = [
    'user-order-header',
    'pointer',
    isUnready ? 'unready-user-order' : ''
  ].filter(Boolean).join(' ')

  // Vanilla L1988: active orders that are already inactive (status >=
  // StatusExecuted with no active matches) get an `inactive` class on
  // the side-light. Completed orders don't get this class at all — the
  // "inactive" styling is reserved for the active-list path.
  const isActive = order.status < StatusExecuted || hasActiveMatches(order)
  const sideLightClasses = [
    'side-indicator',
    order.sell ? 'sell' : 'buy',
    variant === 'active' && !isActive ? 'inactive' : ''
  ].filter(Boolean).join(' ')

  // MP-37: Compute + show the floater menu. Vanilla positions it directly
  // below the header, flush to the header's left edge (markets.ts L2078-2081:
  // `top = m.bodyTop + m.height - 1`, `left = m.bodyLeft`). The `-1` hides
  // the header's bottom border under the floater's top border so the two
  // borders merge visually.
  const showFloater = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    // Vanilla L2068: floater is suppressed entirely when the details are
    // already expanded — the details row already exposes the same links,
    // so the floater would be redundant.
    if (expanded) return
    if (!headerRef.current) return
    const r = headerRef.current.getBoundingClientRect()
    setFloaterPos({ top: r.bottom - 1, left: r.left })
  }
  const scheduleHideFloater = () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    // Small grace period so moving from header → floater (or back) doesn't
    // flicker the menu off between mouseleave and mouseenter events.
    hideTimerRef.current = window.setTimeout(() => {
      setFloaterPos(null)
      hideTimerRef.current = null
    }, 50)
  }
  // Reposition the floater when the rightmost panel scrolls (vanilla
  // L2096-2102: the scroll listener recomputes `floater.style.top`). We
  // re-read the header's current `getBoundingClientRect` since viewport
  // coordinates already account for scroll. Keyed on a local
  // `isFloaterOpen` flag (not the full `floaterPos` object) so the
  // listener is only attached/detached when the menu opens/closes, not
  // on every reposition — otherwise scroll-triggered setState would
  // churn the effect.
  const isFloaterOpen = floaterPos !== null
  useEffect(() => {
    if (!isFloaterOpen) return
    const container = scrollRef.current
    if (!container) return
    const onScroll = () => {
      if (!headerRef.current) return
      const r = headerRef.current.getBoundingClientRect()
      setFloaterPos({ top: r.bottom - 1, left: r.left })
    }
    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [isFloaterOpen, scrollRef])
  // Clean up any pending hide timer on unmount so a stale callback doesn't
  // fire into a stale state setter.
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  const onHeaderClick = () => {
    setExpanded(e => !e)
    // Vanilla L2073-2074: clicking the header removes any floater. Clear
    // it immediately so the expanded details don't fight for real estate
    // with the hovering menu.
    setFloaterPos(null)
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  return (
    <div className="user-order border-top border-bottom">
      <div
        ref={headerRef}
        className={headerClasses}
        onClick={onHeaderClick}
        onMouseEnter={showFloater}
        onMouseLeave={scheduleHideFloater}
      >
        <div className={sideLightClasses}></div>
        <span className="fs16" style={{ color: isBuy ? 'var(--buy-color)' : 'var(--sell-color)' }}>
          {headerSideWord}
        </span>
        <span className="ms-1 fs16">
          {headerQtyStr}
        </span>
        <span className="ms-1 grey fs16">{mkt?.basesymbol?.toUpperCase() ?? ''}</span>
        <span className="ms-1 fs16">
          {headerRateStr}
        </span>
        <span className="flex-grow-1 d-flex align-items-center justify-content-end">
          <span className="fs16">{headerStatusText}</span>
        </span>
      </div>
      {expanded && (
        <div className="order-details border-top border-bottom">
          <div className="user-order-datum full-span d-flex flex-row justify-content-start align-items-center border-bottom fs14">
            {cancelOrder && isCancellable(order) && (
              <span
                className="ico-cross pointer hoverbg fs11 py-2 px-3 mx-1"
                title="Cancel order"
                onClick={e => { e.stopPropagation(); cancelOrder(order.id) }}
              ></span>
            )}
            {order.id && (
              <a
                className="ico-open pointer hoverbg fs13 plainlink py-2 px-3 ms-1"
                title="Order details"
                onClick={() => navigate(orderPath(order.id))}
              ></a>
            )}
          </div>
          <div className="user-order-datum fs15">
            <span>Type</span>
            <span>{typeString(order, t)}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Side</span>
            <span>{order.sell ? 'sell' : 'buy'}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Status</span>
            <span>{statusString(order)}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Age</span>
            <span>{ageSince(order.submitTime)}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Quantity</span>
            <span>{bui && mkt ? formatCoinAtomToLotSizeBaseCurrency(order.qty, bui, mkt.lotsize) : ''}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Rate</span>
            <span>{detailsRateStr}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Filled</span>
            <span>{filledPct}%</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Settled</span>
            <span>{settledPct}%</span>
          </div>
        </div>
      )}
      {/* MP-37: Floater hover menu rendered to document.body via portal
          so the absolutely-positioned menu doesn't get clipped by any
          ancestor `overflow: hidden`. Vanilla does the equivalent with
          `document.body.appendChild(floater)` at markets.ts L2072. The
          active variant exposes a cancel button (if cancellable) + the
          order-details link; the completed variant exposes only the
          order-details link (vanilla L2219). */}
      {floaterPos && createPortal(
        <div
          ref={floaterRef}
          className="user-order-floaty-menu"
          style={{ top: `${floaterPos.top}px`, left: `${floaterPos.left}px` }}
          onMouseEnter={showFloater}
          onMouseLeave={scheduleHideFloater}
        >
          {variant === 'active' && cancelOrder && isCancellable(order) && (
            <span
              className="ico-cross pointer hoverbg fs11 py-2 px-3 mx-1"
              title="Cancel order"
              onClick={() => { setFloaterPos(null); cancelOrder(order.id) }}
            ></span>
          )}
          {order.id && (
            <a
              className="ico-open pointer hoverbg fs13 plainlink py-2 px-3 ms-1"
              title="Order details"
              onClick={() => { setFloaterPos(null); navigate(orderPath(order.id)) }}
            ></a>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RecentMatchesTable — extracted so its `useSecondTicker()` re-render is
// isolated to just this table. Without the extraction, putting the ticker
// at the MarketsPage level would force the whole page to re-render once
// per second.
//
// Implements vanilla parity for Section H (MP-45..MP-50):
//   MP-45: sortable columns (click to toggle direction / change column).
//   MP-46: 24-hour age filter.
//   MP-47: side-colored price and qty cells.
//   MP-48: headers include quote/base asset symbols (shortSymbol).
//   MP-49: live age ticker (shared with `useSecondTicker` above).
//   MP-50: 100-match storage cap — already enforced in the feed handler
//          (see `handleEpochMatchSummary`); no render cap here (vanilla
//          shows all 24h-filtered matches, box scrolls via
//          `max-height: 350px` + `stylish-overflow`).
// ---------------------------------------------------------------------------

type RecentMatchesSortKey = 'price' | 'qty' | 'age'
type RecentMatchesSortDir = 1 | -1

const RECENT_MATCHES_AGE_WINDOW_MS = 24 * 60 * 60 * 1000

// shortSymbol — port of vanilla `Doc.shortSymbol` (doc.ts L709). Strips any
// parent-chain suffix and upper-cases. Drive-by: this helper is duplicated in
// several pages (see cleanup notes); a shared util would consolidate them.
function shortSymbol (symbol: string): string {
  return symbol.split('.')[0].toUpperCase()
}

interface RecentMatchesTableProps {
  recentMatches: RecentMatch[]
  bui: UnitInfo | null
  qui: UnitInfo | null
  currentMkt: Market | null
  baseSymbol: string
  quoteSymbol: string
}

function RecentMatchesTable ({
  recentMatches, bui, qui, currentMkt, baseSymbol, quoteSymbol
}: RecentMatchesTableProps) {
  // MP-43/MP-49: 1 Hz re-render so the age column in the recent matches
  // table ticks live. Vanilla L566: the same ticker also touches
  // `page.recentMatchesLiveList` age cells.
  useSecondTicker()

  // MP-45: sort state. Vanilla defaults to `{ key: 'age', dir: -1 }` at
  // markets.ts L204-205 — newest matches first.
  const [sort, setSort] = useState<{ key: RecentMatchesSortKey; dir: RecentMatchesSortDir }>({
    key: 'age',
    dir: -1
  })

  // Click handler mirrors vanilla `setRecentMatchesSortCol` (markets.ts
  // L600-611): clicking the same column toggles direction; clicking a new
  // column switches and resets direction to ascending (1).
  const onHeaderClick = (key: RecentMatchesSortKey) => {
    setSort(prev => (
      prev.key === key
        ? { key, dir: (prev.dir * -1) as RecentMatchesSortDir }
        : { key, dir: 1 }
    ))
  }

  // MP-45 + MP-46: sort first, then filter — matches vanilla ordering in
  // `refreshRecentMatchesTable` (markets.ts L2794-2802). We copy the array
  // before sorting because vanilla's in-place `.sort` would mutate React
  // state, and React must never mutate state.
  //
  // No `useMemo` here deliberately: the 24h filter depends on `Date.now()`,
  // which has no React dep to key on. The parent `useSecondTicker` forces a
  // re-render every second, so inline recomputation is the simplest way to
  // keep the filter fresh as matches age out. Cost is trivial — ≤100 items
  // sorted and filtered once per second.
  const sortedFiltered = (() => {
    const copy = [...recentMatches]
    const dir = sort.dir
    switch (sort.key) {
      case 'price':
        copy.sort((a, b) => dir * (a.rate - b.rate))
        break
      case 'qty':
        copy.sort((a, b) => dir * (a.qty - b.qty))
        break
      case 'age':
        copy.sort((a, b) => dir * (a.stamp - b.stamp))
        break
    }
    const now = Date.now()
    return copy.filter(m => now - m.stamp <= RECENT_MATCHES_AGE_WINDOW_MS)
  })()

  // MP-45: the `sorted-asc` / `sorted-dsc` classes decide arrow visibility
  // and rotation via `markets.scss` L631-661.
  const sortClass = (key: RecentMatchesSortKey): string => {
    if (sort.key !== key) return ''
    return sort.dir === 1 ? 'sorted-asc' : 'sorted-dsc'
  }

  // MP-48: headers interpolate the market's short base/quote symbols.
  // Vanilla (markets.ts L1397-1399) uses:
  //   priceHdr = `Price (${Doc.shortSymbol(quote.symbol)})`
  //   qtyHdr   = `Size (${Doc.shortSymbol(base.symbol)})`
  //   ageHdr   = 'Age'
  const priceHdrText = quoteSymbol ? `Price (${shortSymbol(quoteSymbol)})` : 'Price'
  const qtyHdrText = baseSymbol ? `Size (${shortSymbol(baseSymbol)})` : 'Size'

  return (
    <div id="recentMatchesBox" className="flex-stretch-column my-1 border-top">
      <div className="text-center demi fs20 p-1">Recent Matches</div>
      <table id="recentMatchesTable" className="row-border row-hover lh1 border-bottom">
        <thead>
          <tr className="pointer">
            <th
              className={`text-start text-nowrap grey ${sortClass('price')}`.trim()}
              onClick={() => onHeaderClick('price')}
            >
              <span>{priceHdrText}</span>
              {' '}
              <span className="ico-arrowdown"></span>
            </th>
            <th
              className={`text-end text-nowrap grey ${sortClass('qty')}`.trim()}
              onClick={() => onHeaderClick('qty')}
            >
              <span className="ico-arrowdown"></span>
              {' '}
              <span>{qtyHdrText}</span>
            </th>
            <th
              className={`text-end text-nowrap grey ${sortClass('age')}`.trim()}
              onClick={() => onHeaderClick('age')}
            >
              <span className="ico-arrowdown"></span>
              {' '}
              <span>Age</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedFiltered.map((m, i) => {
            // MP-47: both price and qty use vanilla's `buycolor`/`sellcolor`
            // utility classes (utilities.scss L106-111) rather than an inline
            // style — matches markets.ts L2810 + L2812. The `!m.sell`
            // inversion on the price comes from vanilla L2808: "for match
            // (when rate-formatting) the meaning of sell is reversed".
            const sideCls = m.sell ? 'sellcolor' : 'buycolor'
            return (
              <tr key={`${m.stamp}-${i}`}>
                <td className={`text-start fs17 ${sideCls}`}>
                  {bui && qui && currentMkt
                    ? formatRateAtomToRateStep(m.rate, bui, qui, currentMkt.ratestep, !m.sell)
                    : ''}
                </td>
                <td className={`text-end fs17 ${sideCls}`}>
                  {bui && currentMkt
                    ? formatCoinAtomToLotSizeBaseCurrency(m.qty, bui, currentMkt.lotsize)
                    : ''}
                </td>
                <td className="preserve-spaces text-end fs17">{ageSince(m.stamp)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// OrderForm — fully independent buy/sell limit-order form
// ---------------------------------------------------------------------------

interface OrderFormProps {
  side: 'buy' | 'sell'
  selected: SelectedMarket
  currentMkt: Market | null
  bui: UnitInfo | null
  qui: UnitInfo | null
  walletMap: Record<number, any>
  baseSymbol: string
  quoteSymbol: string
  // MP-52: fiat rates for the verify-modal fiat total. Null/0 hides the
  // total row (vanilla `showFiatValue` hides the parent when rate=0).
  baseFiatRate: number
  quoteFiatRate: number
  bookRateAtom: number
  bookRateVersion: number
  onOrderSubmitted: () => void
}

function OrderForm ({
  side, selected, currentMkt, bui, qui, walletMap, baseSymbol, quoteSymbol,
  baseFiatRate, quoteFiatRate, bookRateAtom, bookRateVersion, onOrderSubmitted
}: OrderFormProps) {
  const { t } = useTranslation()
  const isSell = side === 'sell'
  const buiConv = bui?.conventional
  const quiConv = qui?.conventional

  // Fully independent form state
  const [rateInput, setRateInput] = useState('')
  const [qtyInput, setQtyInput] = useState('')
  const rateAtomRef = useRef(0)
  const qtyAtomRef = useRef(0)
  const [sliderValue, setSliderValue] = useState(0)
  const [submitEnabled, setSubmitEnabled] = useState(false)
  const [submitMsg, setSubmitMsg] = useState('')
  const [orderError, setOrderError] = useState('')
  const [showVerify, setShowVerify] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const verifiedOrderRef = useRef<any>(null)

  // MP-51: disclaimer ack state, persisted to localStorage. Vanilla
  // `setDisclaimerAckViz` (markets.ts L479-491) hides the disclaimer+ack
  // block once the user has acknowledged, and shows a "view warnings"
  // toggle that re-opens it. We mirror that with a single boolean —
  // initial read from `fetchLocal` runs once at mount via the lazy
  // initializer so we don't re-read on every render.
  const [disclaimerAcked, setDisclaimerAcked] = useState<boolean>(
    () => fetchLocal(orderDisclaimerAckedLK) === true
  )
  const ackDisclaimer = useCallback(() => {
    storeLocal(orderDisclaimerAckedLK, true)
    setDisclaimerAcked(true)
  }, [])
  const unackDisclaimer = useCallback(() => {
    storeLocal(orderDisclaimerAckedLK, false)
    setDisclaimerAcked(false)
  }, [])

  // Max estimation cache. Buy: keyed by rateAtom. Sell: keyed by 0.
  const maxCacheRef = useRef<Record<number, MaxOrderEstimate>>({})
  // Used only by the validate effect below to detect when a newer validate
  // has superseded an in-flight one. The requestMax market-switch guard uses
  // the separate `selectedRef` snapshot pattern instead of a counter.
  const maxReqIdRef = useRef(0)
  // MP-17: market-switch guard. Snapshot `selected` at requestMax call time,
  // compare against `selectedRef.current` after the fetch returns; drop the
  // response if the market has changed. The OrderForm `key` prop normally
  // remounts the component on a market switch, but this guard is a defensive
  // safety net that mirrors vanilla's marketBefore/marketAfter check.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Refs to the price/quantity input boxes so we can flash a red outline on
  // invalid submission. Matches the vanilla highlightOutlineRed animation.
  const priceBoxRef = useRef<HTMLDivElement | null>(null)
  const qtyBoxRef = useRef<HTMLDivElement | null>(null)
  // MP-70: refs to the actual <input> elements so the wrapper-level click
  // handlers (which let the user click anywhere in the price/qty box to
  // focus the input — vanilla `markets.ts` L366-368, L392-394) can call
  // `.focus()` directly. The visual `.selected` border state is handled
  // entirely by the SCSS `:focus-within` rule on `.order-form-input`,
  // so no JS class toggling is needed.
  const rateInputRef = useRef<HTMLInputElement | null>(null)
  const qtyInputRef = useRef<HTMLInputElement | null>(null)
  const flashInvalid = useCallback((el: HTMLElement | null) => {
    if (!el) return
    el.classList.remove('flash-invalid')
    // Force reflow so the animation restarts on repeated triggers.
    // eslint-disable-next-line no-void
    void el.offsetWidth
    el.classList.add('flash-invalid')
  }, [])

  // Invalidate max caches when wallets change (balance updates)
  useEffect(() => {
    maxCacheRef.current = {}
  }, [walletMap])

  // MP-15: Initialize qty to 1 lot when the market first becomes available.
  // Mirrors vanilla setBuyQtyDefault/setSellQtyDefault. The OrderForm is
  // remounted on market change via its `key` prop, so this logically runs
  // once per market. The `qtyInitRef` ref-guard is load-bearing though:
  // within a single instance, `currentMkt` and `bui` identities change
  // whenever the exchanges/assets store is mutated (e.g. spot-price WS
  // updates), and without the guard the effect would re-fire and clobber
  // whatever qty the user had typed. Rate initialization is handled
  // separately by the book-fill effect.
  const qtyInitRef = useRef(false)
  useEffect(() => {
    if (qtyInitRef.current || !currentMkt || !bui) return
    qtyInitRef.current = true
    qtyAtomRef.current = currentMkt.lotsize
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(currentMkt.lotsize, bui, currentMkt.lotsize))
    setSliderValue(0)
    maxCacheRef.current = {}
  }, [currentMkt, bui])

  // Fill rate from order book click
  useEffect(() => {
    if (bookRateVersion === 0 || !bookRateAtom || !bui || !qui || !currentMkt) return
    const adjusted = isSell
      ? adjRateAtomsSell(bookRateAtom, currentMkt.ratestep)
      : adjRateAtomsBuy(bookRateAtom, currentMkt.ratestep)
    rateAtomRef.current = adjusted
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, currentMkt.ratestep, isSell))
    if (!isSell) maxCacheRef.current = {}
  }, [bookRateVersion])

  // Request max estimate for this side
  const requestMax = useCallback(async (): Promise<MaxOrderEstimate | null> => {
    if (!selected || !currentMkt || !bui || !qui) return null
    const reqSelected = selected
    const marketChanged = () =>
      selectedRef.current.host !== reqSelected.host ||
      selectedRef.current.baseID !== reqSelected.baseID ||
      selectedRef.current.quoteID !== reqSelected.quoteID
    if (isSell) {
      const cached = maxCacheRef.current[0]
      if (cached) return cached
      const baseWallet = walletMap[selected.baseID]
      if (!baseWallet?.running) return null
      const res = await postJSON('/api/maxsell', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxSell) return null
      maxCacheRef.current[0] = res.maxSell
      return res.maxSell as MaxOrderEstimate
    } else {
      const rateAtom = rateAtomRef.current
      if (!rateAtom) return null
      const cached = maxCacheRef.current[rateAtom]
      if (cached) return cached
      const quoteWallet = walletMap[selected.quoteID]
      if (!quoteWallet?.running) return null
      const res = await postJSON('/api/maxbuy', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID, rate: rateAtom
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxBuy) return null
      maxCacheRef.current[rateAtom] = res.maxBuy
      return res.maxBuy as MaxOrderEstimate
    }
  }, [selected, currentMkt, bui, qui, isSell, walletMap])

  // Sync slider position from current qty vs max estimate
  const syncSlider = useCallback(async () => {
    if (!currentMkt) return
    const lotsize = currentMkt.lotsize
    const currentLots = Math.floor(qtyAtomRef.current / lotsize)
    if (currentLots <= 0) { setSliderValue(0); return }
    const maxEst = await requestMax()
    if (maxEst && maxEst.swap.lots > 0) {
      setSliderValue(Math.min(1, currentLots / maxEst.swap.lots))
    }
  }, [currentMkt, requestMax])

  const handleRateChange = useCallback((value: string) => {
    setRateInput(value)
    if (!bui || !qui || !currentMkt) return
    // MP-16: If the value ends with a decimal separator, wait for the user to
    // finish typing before processing. Matches vanilla rate field handlers.
    if (value.length > 0) {
      const last = value.charAt(value.length - 1)
      if (last === '.' || last === ',') return
    }
    const rateAtom = parseConvRate(value, bui, qui)
    if (!rateAtom) {
      rateAtomRef.current = 0
      setSubmitEnabled(false)
      return
    }
    const adjusted = isSell
      ? adjRateAtomsSell(rateAtom, currentMkt.ratestep)
      : adjRateAtomsBuy(rateAtom, currentMkt.ratestep)
    rateAtomRef.current = adjusted
    if (!isSell) maxCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell])

  const handleRateBlur = useCallback(() => {
    if (!bui || !qui || !currentMkt) return
    // MP-72: vanilla splits rate field handling into 'input' (live, fast
    // path for "perfect" inputs only) and 'change' (commit, slower path
    // that handles invalidity and rate-step rounding with an error
    // animation). React's handleRateChange is the live input path, this
    // is the commit path. Detect both invalid and rounded-down inputs by
    // re-parsing the typed value and comparing against the adjusted
    // value already stored in `rateAtomRef` by handleRateChange — if
    // they differ, the input was rounded; if it parsed to 0, it was
    // invalid (vanilla L3030 animates errors in both cases).
    const typedAtom = parseConvRate(rateInput, bui, qui)
    if (typedAtom === 0) {
      // Empty is silent, anything else is a parse error worth flashing.
      if (rateInput.trim().length > 0) flashInvalid(priceBoxRef.current)
      return
    }
    if (typedAtom !== rateAtomRef.current) {
      flashInvalid(priceBoxRef.current)
    }
    if (rateAtomRef.current > 0) {
      setRateInput(formatRateAtomToRateStep(rateAtomRef.current, bui, qui, currentMkt.ratestep, isSell))
    }
  }, [bui, qui, currentMkt, isSell, rateInput, flashInvalid])

  const handleRateStep = useCallback((direction: 1 | -1) => {
    if (!bui || !qui || !currentMkt) return
    const step = currentMkt.ratestep
    let current = rateAtomRef.current || 0
    current += step * direction
    if (current < step) current = step
    const adjusted = isSell
      ? adjRateAtomsSell(current, step)
      : adjRateAtomsBuy(current, step)
    rateAtomRef.current = adjusted
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, step, isSell))
    if (!isSell) maxCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell])

  const handleQtyChange = useCallback((value: string) => {
    setQtyInput(value)
    if (!bui || !currentMkt) return
    // MP-16: If the value ends with a decimal separator, wait for the user to
    // finish typing before processing. Matches vanilla qty field handlers.
    if (value.length > 0) {
      const last = value.charAt(value.length - 1)
      if (last === '.' || last === ',') return
    }
    const qtyAtom = parseConvQty(value, bui)
    if (!qtyAtom) {
      qtyAtomRef.current = 0
      setSubmitEnabled(false)
      return
    }
    const lots = Math.floor(qtyAtom / currentMkt.lotsize)
    qtyAtomRef.current = lots * currentMkt.lotsize
    syncSlider()
  }, [bui, currentMkt, syncSlider])

  const handleQtyBlur = useCallback(() => {
    if (!bui || !currentMkt) return
    // MP-72: same input/change split as the rate field — flash the
    // outline if the typed value is invalid or got rounded down to a
    // sub-lot value. Vanilla `qtyField{Buy,Sell}ChangeHandler` calls
    // `animateErrors(highlightOutlineRed(qtyBox*))` when parseQtyInput
    // returns invalid or rounded; mirror that here.
    const typedAtom = parseConvQty(qtyInput, bui)
    if (typedAtom === 0) {
      if (qtyInput.trim().length > 0) flashInvalid(qtyBoxRef.current)
      return
    }
    if (typedAtom !== qtyAtomRef.current) {
      flashInvalid(qtyBoxRef.current)
    }
    if (qtyAtomRef.current > 0) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, currentMkt.lotsize))
    }
    syncSlider()
  }, [bui, currentMkt, syncSlider, qtyInput, flashInvalid])

  const handleQtyStep = useCallback((direction: 1 | -1) => {
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    let current = qtyAtomRef.current || 0
    current += lotsize * direction
    if (current < lotsize) current = lotsize
    const lots = Math.floor(current / lotsize)
    qtyAtomRef.current = lots * lotsize
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, lotsize))
    syncSlider()
  }, [bui, currentMkt, syncSlider])

  // Slider handler: slider value (0-1) -> qty via max lots estimate
  const handleSlider = useCallback(async (value: number) => {
    setSliderValue(value)
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    const maxEst = await requestMax()
    const maxLots = maxEst?.swap.lots ?? 0
    if (maxLots <= 0) return
    const lots = Math.max(1, Math.floor(maxLots * value))
    const adjQty = lots * lotsize
    qtyAtomRef.current = adjQty
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(adjQty, bui, lotsize))
  }, [bui, currentMkt, requestMax])

  // Validate and enable submit button
  useEffect(() => {
    if (!selected || !currentMkt || !bui || !qui) {
      setSubmitEnabled(false)
      return
    }
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom || !qtyAtom) {
      setSubmitEnabled(false)
      setSubmitMsg('')
      return
    }
    let cancelled = false
    const validate = async () => {
      setSubmitMsg('Calculating...')
      setSubmitEnabled(false)
      maxReqIdRef.current++
      const reqId = maxReqIdRef.current
      const maxEst = await requestMax()
      if (cancelled || reqId !== maxReqIdRef.current) return
      if (isSell) {
        if (!maxEst || qtyAtom > maxEst.swap.value) {
          setSubmitEnabled(false)
          setSubmitMsg('Insufficient balance')
          return
        }
      } else {
        if (!maxEst || qtyAtom > maxEst.swap.lots * currentMkt.lotsize) {
          setSubmitEnabled(false)
          setSubmitMsg('Insufficient balance')
          return
        }
      }
      setSubmitEnabled(true)
      setSubmitMsg('')
    }
    validate()
    return () => { cancelled = true }
  }, [selected, currentMkt, bui, qui, isSell, rateInput, qtyInput, requestMax])

  // Preview total
  const previewTotal = useMemo(() => {
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom || !qtyAtom || !bui || !qui || !currentMkt) return ''
    const total = baseToQuote(rateAtom, qtyAtom)
    return formatCoinAtomToLotSizeQuoteCurrency(total, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
  }, [rateInput, qtyInput, bui, qui, currentMkt])

  // MP-13: Wallet-readiness gate. Mirrors vanilla displayMessageIfMissingWallet
  // priority order — both missing > base missing > quote missing > base
  // disabled/not-running > quote disabled/not-running. When set, this message
  // replaces submitMsg and the submit button is disabled.
  const walletMsg = useMemo(() => {
    if (!selected) return ''
    const baseW = walletMap[selected.baseID]
    const quoteW = walletMap[selected.quoteID]
    if (!baseW && !quoteW) return `Create ${baseSymbol} and ${quoteSymbol} wallet to trade`
    if (!baseW) return `Create a ${baseSymbol} wallet to trade`
    if (!quoteW) return `Create a ${quoteSymbol} wallet to trade`
    if (baseW.disabled || !baseW.running) return `Enable / Activate a ${baseSymbol} wallet to trade`
    if (quoteW.disabled || !quoteW.running) return `Enable / Activate a ${quoteSymbol} wallet to trade`
    return ''
  }, [selected, walletMap, baseSymbol, quoteSymbol])

  // Submit order: step 1 - show confirmation.
  // Validation messages/flashes match vanilla validateOrderBuy/validateOrderSell.
  const stepSubmit = useCallback(async () => {
    if (!selected || !currentMkt || !bui || !qui) return
    setOrderError('')
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom) {
      setOrderError('zero rate not allowed')
      flashInvalid(priceBoxRef.current)
      return
    }
    if (rateAtom < currentMkt.minimumRate) {
      const rateConv = RateEncodingFactor / bui.conventional.conversionFactor * qui.conventional.conversionFactor
      const r = rateAtom / rateConv
      const minRate = currentMkt.minimumRate / rateConv
      setOrderError(`rate is lower than the market's minimum rate. ${r} < ${minRate}`)
      flashInvalid(priceBoxRef.current)
      return
    }
    if (!qtyAtom) {
      setOrderError('zero quantity not allowed')
      flashInvalid(qtyBoxRef.current)
      return
    }
    // Insufficient-balance gate: the validate effect keeps maxCacheRef in sync
    // and sets submitEnabled false with submitMsg='Insufficient balance'. If
    // the user clicks anyway (e.g. due to a stale cache), re-check against the
    // latest max estimate and flash the quantity box.
    const maxEst = maxCacheRef.current[isSell ? 0 : rateAtom]
    if (maxEst) {
      const maxAtoms = isSell ? maxEst.swap.value : maxEst.swap.lots * currentMkt.lotsize
      if (qtyAtom > maxAtoms) {
        setOrderError('not enough funds')
        flashInvalid(qtyBoxRef.current)
        return
      }
    }
    const baseWallet = walletMap[selected.baseID]
    const quoteWallet = walletMap[selected.quoteID]
    if (!baseWallet || !quoteWallet) { setOrderError('Missing wallet'); return }
    verifiedOrderRef.current = {
      host: selected.host, isLimit: true, sell: isSell,
      base: selected.baseID, quote: selected.quoteID,
      qty: qtyAtom, rate: rateAtom, tifnow: false, options: {}
    }
    setShowVerify(true)
  }, [selected, currentMkt, bui, qui, walletMap, isSell, flashInvalid])

  // Submit order: step 2 - send to server
  const submitVerifiedOrder = useCallback(async () => {
    if (!verifiedOrderRef.current) return
    setSubmitting(true)
    setOrderError('')
    const res = await postJSON('/api/tradeasync', { order: verifiedOrderRef.current })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setOrderError(res.msg || 'Order submission failed')
      return
    }
    setShowVerify(false)
    qtyAtomRef.current = currentMkt?.lotsize ?? 0
    if (bui && currentMkt) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(currentMkt.lotsize, bui, currentMkt.lotsize))
    }
    setSliderValue(0)
    maxCacheRef.current = {}
    onOrderSubmitted()
  }, [currentMkt, bui, onOrderSubmitted])

  return (
    <>
      <section id={isSell ? 'orderFormSell' : 'orderFormBuy'} className="px-1">
        <form className="d-flex flex-stretch-column py-1" autoComplete="off">
          {/* Price input. MP-70: clicking anywhere in the wrapper focuses
              the input (vanilla L366-368). The visual focus border is
              handled by the SCSS `:focus-within` rule on
              `.order-form-input`, so no JS class toggling is needed. */}
          <div
            ref={priceBoxRef}
            className="d-flex flex-stretch-row align-items-center order-form-input select m-1"
            onClick={() => rateInputRef.current?.focus()}
          >
            <label className="form-label grey fs18 px-2">Price</label>
            <input
              ref={rateInputRef}
              type="text"
              className="text-end demi fs18 p-0"
              value={rateInput}
              onChange={e => handleRateChange(e.target.value)}
              onBlur={handleRateBlur}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') { e.preventDefault(); handleRateStep(1) }
                if (e.key === 'ArrowDown') { e.preventDefault(); handleRateStep(-1) }
              }}
            />
            <span className="grey demi fs18 px-1">{quiConv?.unit ?? ''}</span>
            <div className="d-flex flex-stretch-column align-items-center justify-content-between arrows-up-down ps-0-5 pe-1 border-left">
              <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 border-bottom pointer" onClick={() => handleRateStep(1)}>
                <div className="arrow-up"></div>
              </div>
              <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 pointer" onClick={() => handleRateStep(-1)}>
                <div className="arrow-down"></div>
              </div>
            </div>
          </div>
          {/* Quantity input. MP-70: same focus-on-wrapper-click behavior
              as the price box (vanilla L392-394). */}
          <div
            ref={qtyBoxRef}
            className="d-flex flex-stretch-row align-items-center order-form-input select m-1"
            onClick={() => qtyInputRef.current?.focus()}
          >
            <label className="form-label grey fs18 px-2">Quantity</label>
            <input
              ref={qtyInputRef}
              type="text"
              className="text-end demi fs18 p-0"
              value={qtyInput}
              onChange={e => handleQtyChange(e.target.value)}
              onBlur={handleQtyBlur}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') { e.preventDefault(); handleQtyStep(1) }
                if (e.key === 'ArrowDown') { e.preventDefault(); handleQtyStep(-1) }
              }}
            />
            <span className="grey demi fs18 px-1">{buiConv?.unit ?? ''}</span>
            <div className="d-flex flex-stretch-column align-items-center justify-content-between arrows-up-down ps-0-5 pe-1 border-left">
              <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 border-bottom pointer" onClick={() => handleQtyStep(1)}>
                <div className="arrow-up"></div>
              </div>
              <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 pointer" onClick={() => handleQtyStep(-1)}>
                <div className="arrow-down"></div>
              </div>
            </div>
          </div>
          {/* Slider with 5 mark indicators (0/25/50/75/100%). */}
          <div id={isSell ? 'qtySliderSell' : 'qtySliderBuy'} className="mt-2 mb-1 mx-2">
            <input
              type="range" min="0" max="1" step="0.01"
              value={sliderValue}
              onChange={e => handleSlider(parseFloat(e.target.value))}
              style={{ backgroundSize: `${sliderValue * 100}% 100%` }}
            />
            <div className="slider-mark slider-mark-0 mark-enabled"></div>
            <div className={`slider-mark slider-mark-25${sliderValue > 0.25 ? ' mark-enabled' : ''}`}></div>
            <div className={`slider-mark slider-mark-50${sliderValue > 0.50 ? ' mark-enabled' : ''}`}></div>
            <div className={`slider-mark slider-mark-75${sliderValue > 0.75 ? ' mark-enabled' : ''}`}></div>
            <div className={`slider-mark slider-mark-100${sliderValue >= 1.0 ? ' mark-enabled' : ''}`}></div>
          </div>
          {/* Preview total */}
          <div className="d-flex flex-stretch-row m-1">
            {isSell
              ? (
                <>
                  <div className="d-flex align-items-center justify-content-end me-1 demi fs18" style={{ flexBasis: '47%' }}>
                    {qtyInput && <>{qtyInput} {buiConv?.unit ?? ''}</>}
                  </div>
                  <span className="d-flex align-items-center mx-1 pt-0-5 fs22 grey" style={{ flexBasis: '6%' }}>{previewTotal ? '⇄' : ''}</span>
                  <div className="d-flex align-items-center justify-content-start ms-1 demi fs18" style={{ flexBasis: '47%' }}>
                    {previewTotal && <>{previewTotal} {quiConv?.unit ?? ''}</>}
                  </div>
                </>
              )
              : (
                <>
                  <div className="d-flex align-items-center justify-content-end me-1 demi fs18" style={{ flexBasis: '47%' }}>
                    {previewTotal && <>{previewTotal} {quiConv?.unit ?? ''}</>}
                  </div>
                  <span className="d-flex align-items-center mx-1 pt-0-5 fs22 grey" style={{ flexBasis: '6%' }}>{previewTotal ? '⇄' : ''}</span>
                  <div className="d-flex align-items-center justify-content-start ms-1 demi fs18" style={{ flexBasis: '47%' }}>
                    {qtyInput && <>{qtyInput} {buiConv?.unit ?? ''}</>}
                  </div>
                </>
              )}
          </div>
          {(walletMsg || submitMsg) && <div className="m-1 fs14 text-center grey">{walletMsg || submitMsg}</div>}
          <button
            type="button"
            className={`flex-center border pointer hoverbg border-rounded3 m-1 submit fs18 text-center ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
            disabled={!submitEnabled || !!walletMsg}
            onClick={stepSubmit}
          >
            {isSell ? t('Sell') : t('Buy')} {baseSymbol}
          </button>
          {orderError && <div className="m-1 fs17 text-center text-danger text-break">{orderError}</div>}
        </form>
      </section>

      {/* Order verification modal */}
      <FormOverlay show={showVerify} onClose={() => setShowVerify(false)}>
        <VerifyOrderForm
          isSell={isSell}
          order={verifiedOrderRef.current}
          bui={bui}
          qui={qui}
          currentMkt={currentMkt}
          baseSymbol={baseSymbol}
          buiUnit={buiConv?.unit ?? ''}
          quiUnit={quiConv?.unit ?? ''}
          baseFiatRate={baseFiatRate}
          quoteFiatRate={quoteFiatRate}
          submitting={submitting}
          orderError={orderError}
          disclaimerAcked={disclaimerAcked}
          onAckDisclaimer={ackDisclaimer}
          onUnackDisclaimer={unackDisclaimer}
          onClose={() => setShowVerify(false)}
          onSubmit={submitVerifiedOrder}
          t={t}
        />
      </FormOverlay>
    </>
  )
}

// ---------------------------------------------------------------------------
// VerifyOrderForm — the confirmation modal shown after the user clicks the
// main order-form submit button. Extracted from OrderForm to keep the
// Batch 9 parity changes (MP-51..MP-55) isolated and independently
// testable. All inputs are props; no side effects beyond invoking the
// callbacks passed in.
// ---------------------------------------------------------------------------

interface VerifyOrderFormProps {
  isSell: boolean
  order: {
    host: string
    rate: number
    qty: number
    tifnow?: boolean
  } | null
  bui: UnitInfo | null
  qui: UnitInfo | null
  currentMkt: Market | null
  baseSymbol: string
  buiUnit: string
  quiUnit: string
  baseFiatRate: number
  quoteFiatRate: number
  submitting: boolean
  orderError: string
  disclaimerAcked: boolean
  onAckDisclaimer: () => void
  onUnackDisclaimer: () => void
  onClose: () => void
  onSubmit: () => void
  t: (key: string) => string
}

function VerifyOrderForm ({
  isSell, order, bui, qui, currentMkt, baseSymbol, buiUnit, quiUnit,
  baseFiatRate, quoteFiatRate, submitting, orderError,
  disclaimerAcked, onAckDisclaimer, onUnackDisclaimer,
  onClose, onSubmit, t
}: VerifyOrderFormProps) {
  // MP-54: order type label. Vanilla (markets.ts L2436-2441) reads:
  //   const buySellStr = intl.prep(isSell ? ID_SELL : ID_BUY)
  //   const orderDesc  = `Limit ${buySellStr} Order`
  //   vOrderType = order.tifnow ? orderDesc + ' (immediate)' : orderDesc
  const buySellStr = isSell ? t('Sell') : t('Buy')
  const orderDesc = `Limit ${buySellStr} Order`
  const orderTypeLabel = order?.tifnow ? `${orderDesc} (immediate)` : orderDesc

  // MP-51: disclaimer HTML interpolation. The `order_disclaimer` i18n key
  // still contains the Go template's `<span class=brand>` and
  // `<span data-*-ticker>` placeholders (see en-US.json L137 + app.ts
  // `updateMarketElements` L909-928). Vanilla populates those at runtime
  // via a DOM walk; React replaces them at render time with string
  // substitution before feeding to `dangerouslySetInnerHTML`.
  const disclaimerHtml = (() => {
    let raw = t('order_disclaimer')
    raw = raw.replace(
      /<span\s+class=("brand"|brand)\s*><\/span>/g,
      'Bison Wallet'
    )
    raw = raw.replace(/<span\s+data-base-ticker\s*><\/span>/g, buiUnit)
    raw = raw.replace(/<span\s+data-quote-ticker\s*><\/span>/g, quiUnit)
    return raw
  })()

  // MP-52: fiat total. Vanilla `showFiatValue` (markets.ts L2507-2513)
  // multiplies the atomic youGet qty by `fiatRatesMap[youGetAsset.id]` and
  // hides the parent if rate is 0. We compute `youGetAtom` and pick the
  // matching fiat rate based on which side of the trade is the `youGet`
  // asset (non-sell = base is youGet; sell = quote is youGet).
  let youSpendText = ''
  let youGetText = ''
  let youGetAtom = 0
  let youGetFiatRate = 0
  let youGetUnitInfo: UnitInfo | null = null
  let youSpendUnit = ''
  let youGetUnit = ''
  let rateDisplay = ''
  if (order && bui && qui && currentMkt) {
    rateDisplay = formatRateAtomToRateStep(
      order.rate, bui, qui, currentMkt.ratestep, isSell
    )
    const baseQty = order.qty
    const quoteQty = baseToQuote(order.rate, order.qty)
    if (isSell) {
      // Sell: spend base, get quote.
      youSpendText = formatCoinAtomToLotSizeBaseCurrency(baseQty, bui, currentMkt.lotsize)
      youGetText = formatCoinAtomToLotSizeQuoteCurrency(quoteQty, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
      youSpendUnit = buiUnit
      youGetUnit = quiUnit
      youGetAtom = quoteQty
      youGetFiatRate = quoteFiatRate
      youGetUnitInfo = qui
    } else {
      // Buy: spend quote, get base.
      youSpendText = formatCoinAtomToLotSizeQuoteCurrency(quoteQty, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
      youGetText = formatCoinAtomToLotSizeBaseCurrency(baseQty, bui, currentMkt.lotsize)
      youSpendUnit = quiUnit
      youGetUnit = buiUnit
      youGetAtom = baseQty
      youGetFiatRate = baseFiatRate
      youGetUnitInfo = bui
    }
  }

  // MP-52: only render the fiat row when we have a positive rate. Vanilla
  // hides the parent via `Doc.hide(display.parentElement)` when rate is 0.
  const showFiatTotal = youGetFiatRate > 0 && youGetUnitInfo !== null
  const fiatTotalText = showFiatTotal
    ? formatFiatConversion(youGetAtom, youGetFiatRate, youGetUnitInfo ?? undefined)
    : ''

  return (
    <form id="verifyForm" className="position-relative" autoComplete="off">
      <div className="form-closer" onClick={onClose}><span className="ico-cross"></span></div>
      <header id="vHeader" className={`fs18 ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}>
        {/* vBuySell: vanilla uses the gerund form (Selling/Buying) at
            markets.ts L2435. */}
        <span id="vBuySell" className="me-2">{isSell ? t('SELLING') : t('BUYING')}</span>
        {' '}
        <span>{baseSymbol}</span>
      </header>
      {order && bui && qui && currentMkt && (
        <>
          <div className="d-flex justify-content-between align-items-center fs14">
            {/* MP-54: vOrderType */}
            <span id="vOrderType" className="grey">{orderTypeLabel}</span>
            <span id="vOrderHost" className="grey">{order.host}</span>
          </div>
          <div id="verifyLimit">
            <div className="d-flex align-items-center justify-content-between">
              <span className="grey fs18 flex-grow-1 text-start">{t('Price')}</span>
              <span id="vRate" className="fs18 demi">{rateDisplay}</span>
              <span className="grey fs18 ms-2">
                <sup>{quiUnit}</sup>/<sub>{buiUnit}</sub>
              </span>
            </div>
            <div className="d-flex align-items-center mt-1">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Spend')}</span>
              {/* MP-55: prefix with `-`. Vanilla L2484. */}
              <span id="youSpend" className="fs18 demi">{'-' + youSpendText}</span>
              <span id="youSpendTicker" className="grey fs18 ms-2">{youSpendUnit}</span>
            </div>
            <div className="d-flex align-items-center mt-1">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Get')}</span>
              {/* MP-55: prefix with `+`. Vanilla L2486. */}
              <span id="youGet" className="fs18 demi">{'+' + youGetText}</span>
              <span id="youGetTicker" className="grey fs18 ms-2">{youGetUnit}</span>
            </div>
            {/* MP-52: fiat total — hidden when fiat rate unavailable. */}
            {showFiatTotal && (
              <span className="d-flex justify-content-end grey fs14">
                ~<span id="vFiatTotal" className="mx-1">{fiatTotalText}</span>USD
              </span>
            )}
          </div>
        </>
      )}
      <div className="flex-stretch-column">
        {/* MP-53: hide submit button entirely while submitting and show a
            separate loader block. Vanilla submitVerifiedOrder (L2862-2865)
            does the same: `Doc.hide(vSubmit); Doc.show(vLoader)`. */}
        {!submitting && (
          <button
            id="vSubmit"
            type="button"
            className={`justify-content-center fs18 go ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
            onClick={onSubmit}
          >
            <span id="vSideSubmit">{buySellStr}</span>
            {' '}
            <span>{baseSymbol}</span>
          </button>
        )}
        {submitting && (
          <div id="vLoader" className="loader flex-center">
            <div className="ico-spinner spinner"></div>
          </div>
        )}
      </div>
      {orderError && (
        <div id="vErr" className="fs17 p-3 text-center text-danger text-break">{orderError}</div>
      )}

      {/* MP-51: disclaimer block + ack toggle. Vanilla markets.tmpl
          L510-520 and markets.ts L479-491. When acked, the disclaimer
          block is hidden and a "view warnings" link is shown; clicking
          it un-acks and re-opens the block. */}
      {!disclaimerAcked && (
        <>
          <div
            id="disclaimer"
            className="disclaimer fs17 pt-3 mt-3 border-top"
            dangerouslySetInnerHTML={{ __html: disclaimerHtml }}
          />
          <div
            id="disclaimerAck"
            className="d-flex align-items-center grey text-center pointer hoverbg fs17"
            onClick={onAckDisclaimer}
          >
            <span className="ico-check fs12 me-1"></span>
            <span>{t('acknowledge_and_hide')}</span>
          </div>
        </>
      )}
      {disclaimerAcked && (
        <div
          id="showDisclaimer"
          className="d-flex align-items-center grey text-center pointer hoverbg fs17"
          onClick={onUnackDisclaimer}
        >
          <span className="ico-plus fs8 me-1 mt-1"></span>
          <span>{t('show_disclaimer')}</span>
        </div>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MarketsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const isWsConnected = useWebSocketStore(s => s.connected)
  const wsSubscribe = useWebSocketStore(s => s.subscribe)
  const wsUnsubscribe = useWebSocketStore(s => s.unsubscribe)
  const wsRequest = useWebSocketStore(s => s.request)

  // Auth store
  const user = useAuthStore(s => s.user)
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const walletMap = useAuthStore(s => s.walletMap)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const darkMode = useUIStore(s => s.darkMode)

  // -------------------------------------------------------------------------
  // Market selector state
  // -------------------------------------------------------------------------
  const allMarkets = useMemo(() => collectMarkets(exchanges), [exchanges])

  const [selected, setSelected] = useState<SelectedMarket | null>(() => {
    // Resolution priority mirrors vanilla `markets.ts` L572-588:
    //   1. URL params (deep link / nav with explicit market)
    //   2. `lastMarketLK` localStorage entry (last viewed market on this device)
    //   3. null → falls through to the "default to first available market"
    //      effect below once `allMarkets` is populated by the auth store.
    // The `default to first` effect also doubles as a validator (MP-67):
    // if the resolved market doesn't actually exist in `allMarkets` (e.g.
    // user removed the DEX while a stale URL/lastMarketLK still points at
    // it), it falls back to the first market — matching vanilla L580.
    const h = searchParams.get('host')
    const b = searchParams.get('baseID')
    const q = searchParams.get('quoteID')
    if (h && b && q) return { host: h, baseID: Number(b), quoteID: Number(q) }
    // MP-67: localStorage fallback. `lastMarketLK` is shared with the
    // services/state.ts schema. We persist `{host, baseID, quoteID}` in
    // the React format (vanilla used `{host, base, quote}` — different
    // key names — but this is a clean rewrite so we don't need to read
    // vanilla's data).
    const persisted = fetchLocal(lastMarketLK) as
      { host?: string; baseID?: number; quoteID?: number } | null
    if (persisted &&
        typeof persisted.host === 'string' &&
        typeof persisted.baseID === 'number' &&
        typeof persisted.quoteID === 'number') {
      return { host: persisted.host, baseID: persisted.baseID, quoteID: persisted.quoteID }
    }
    return null
  })
  const [marketSearch, setMarketSearch] = useState('')
  // MP-09: persist dock visibility across reloads via leftMarketDockLK.
  // Default is "shown" (matches the pre-migration default seeded in state.ts).
  const [showMarketList, setShowMarketListRaw] = useState<boolean>(() => {
    return fetchLocal(leftMarketDockLK) === '1'
  })
  const setShowMarketList = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setShowMarketListRaw(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      storeLocal(leftMarketDockLK, v ? '1' : '0')
      return v
    })
  }, [])

  // -------------------------------------------------------------------------
  // Order book state
  // -------------------------------------------------------------------------
  const bookRef = useRef<OrderBook | null>(null)
  const [bookVersion, setBookVersion] = useState(0)
  const bumpBook = useCallback(() => setBookVersion(v => v + 1), [])

  // MP-37: Ref to the rightmost-panel scroll container (vanilla's
  // `orderScroller`). Passed down to each `UserOrderRow` so its floater
  // menu can listen for scroll events and keep itself anchored to the
  // owning row's header.
  const orderScrollerRef = useRef<HTMLDivElement | null>(null)

  // -------------------------------------------------------------------------
  // Candle / chart state
  // -------------------------------------------------------------------------
  const [candleData, setCandleData] = useState<CandlesPayload | null>(null)
  // MP-19: initial candle duration is persisted via localStorage so a user's
  // last chosen duration survives reloads (matches vanilla drawCandleDurationBttns).
  const [candleDur, setCandleDurState] = useState<string>(() =>
    (fetchLocal(lastCandleDurationLK) as string | null) ?? CANDLE_DUR_24H
  )
  const setCandleDur = useCallback((dur: string) => {
    setCandleDurState(dur)
    storeLocal(lastCandleDurationLK, dur)
  }, [])
  const [candleLoading, setCandleLoading] = useState(false)
  const [mouseCandle, setMouseCandle] = useState<Candle | null>(null)
  const candleCacheRef = useRef<Record<string, CandlesPayload>>({})
  // MP-20: bumped whenever the 5m candle cache changes so the high/low
  // fallback can reactively pick up new data. Scoped to the 5m dur because
  // that's the only cache entry the MP-20 fallback reads from — bumping on
  // other durs would cost a re-render per candle_update for no benefit.
  const [candleCacheVersion, setCandleCacheVersion] = useState(0)
  const reqCandleDurRef = useRef(candleDur)

  // -------------------------------------------------------------------------
  // Trade form state (each OrderForm owns its own form state)
  // -------------------------------------------------------------------------
  const [showTradingTier, setShowTradingTier] = useState(false)
  const [showReputation, setShowReputation] = useState(false)
  const [bookRateAtom, setBookRateAtom] = useState(0)
  const [bookRateVersion, setBookRateVersion] = useState(0)
  // MP-27/MP-59: ID of the asset currently being approved. null = modal hidden.
  // When non-null, the `TokenApprovalForm` is rendered inside a `FormOverlay`.
  const [approveAssetID, setApproveAssetID] = useState<number | null>(null)

  // -------------------------------------------------------------------------
  // Active / completed orders state
  // -------------------------------------------------------------------------
  const [activeOrders, setActiveOrders] = useState<Order[]>([])
  const [completedOrders, setCompletedOrders] = useState<Order[]>([])
  const [completedPeriod, setCompletedPeriod] = useState('hide')

  // -------------------------------------------------------------------------
  // Recent matches
  // -------------------------------------------------------------------------
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([])

  // -------------------------------------------------------------------------
  // Resolve the current market data
  // -------------------------------------------------------------------------
  const currentXc = selected
    ? exchanges[selected.host]
    : null
  const currentMkt = useMemo(() => {
    if (!currentXc || !selected) return null
    const mktId = Object.keys(currentXc.markets).find(k => {
      const m = currentXc.markets[k]
      return m.baseid === selected.baseID && m.quoteid === selected.quoteID
    })
    return mktId
      ? currentXc.markets[mktId]
      : null
  }, [currentXc, selected])
  const currentMktId = currentMkt?.name ?? ''

  const baseAsset = selected
    ? (assets[selected.baseID] ?? null)
    : null
  const quoteAsset = selected
    ? (assets[selected.quoteID] ?? null)
    : null
  const bui = useMemo(() => {
    if (!selected || !currentXc) return null
    return currentXc.assets[selected.baseID]?.unitInfo ?? assets[selected.baseID]?.unitInfo ?? null
  }, [selected, currentXc, assets])
  const qui = useMemo(() => {
    if (!selected || !currentXc) return null
    return currentXc.assets[selected.quoteID]?.unitInfo ?? assets[selected.quoteID]?.unitInfo ?? null
  }, [selected, currentXc, assets])

  const candleDurs = currentXc?.candleDurs ?? []
  const isRegistered = currentXc
    ? !currentXc.viewOnly && currentXc.acctID !== ''
    : false
  const isConnected = currentXc?.connectionStatus === ConnectionStatus.Connected
  // MP-18 + MP-69: chart overlay message shown when the selected DEX is
  // disabled, disconnected, or has no markets configured. Mirrors vanilla
  // `switchToMarket` (markets.ts L1315-1322) which guards on
  // `!dex || !dex.markets || dex.connectionStatus !== Connected` and
  // shows the same two strings (ID_DEX_DISABLED_MSG, ID_CONNECTION_FAILED).
  //
  // We hold off on the message until we have BOTH a selected market and
  // the exchange data for it. `!currentXc` with `selected` set is a
  // transient state (stale URL/lastMarketLK pointing at a removed DEX, or
  // a DEX that was just removed via the Settings page); the
  // default-to-first-market validation effect resolves it within one
  // render, so showing "Connection failed" in that one-frame flicker
  // would be misleading. The validation falls back to a real market and
  // the user never sees the error.
  const chartErrMsg = (() => {
    if (!selected || !currentXc) return ''
    if (currentXc.disabled) {
      return 'DEX server is disabled. Visit the settings page to enable and connect to this server.'
    }
    // MP-69: vanilla collapses both `!dex.markets` and `!Connected` into
    // ID_CONNECTION_FAILED. The `noMarkets` branch covers the rare bisonw
    // state where the host record exists but its markets map hasn't been
    // populated yet.
    const noMarkets = !currentXc.markets || Object.keys(currentXc.markets).length === 0
    if (noMarkets || !isConnected) {
      return 'Connection to dex server failed. You can close bisonw and try again later or wait for it to reconnect.'
    }
    return ''
  })()

  // -------------------------------------------------------------------------
  // Default to first available market if none selected, plus MP-67
  // validation: if `selected` came from URL params or lastMarketLK but no
  // longer matches a real market (DEX removed since last visit), fall back
  // to the first available market. Mirrors vanilla `markets.ts` L580-585.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (allMarkets.length === 0) return
    if (selected) {
      const exists = allMarkets.some(m =>
        m.host === selected.host &&
        m.baseID === selected.baseID &&
        m.quoteID === selected.quoteID
      )
      if (exists) return
    }
    const first = allMarkets[0]
    setSelected({ host: first.host, baseID: first.baseID, quoteID: first.quoteID })
  }, [selected, allMarkets])

  // MP-67: persist the current market to localStorage whenever it changes
  // so the next visit (or a hard reload without URL params) returns the
  // user to the same market. Vanilla writes from inside `switchToMarket`
  // (markets.ts L1375-1379); React writes here as a side effect of the
  // `selected` state changing, which fires for every market switch
  // regardless of how it was triggered (market list click, URL nav, or
  // the default-to-first effect above).
  useEffect(() => {
    if (!selected) return
    storeLocal(lastMarketLK, {
      host: selected.host,
      baseID: selected.baseID,
      quoteID: selected.quoteID
    })
  }, [selected])

  // -------------------------------------------------------------------------
  // Market subscription + WS route handlers (combined so that handlers
  // are registered BEFORE the loadmarket request is sent — eliminates a
  // race where the server response could arrive before handlers exist)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selected) return

    // Reset state for new market
    bookRef.current = null
    setCandleData(null)
    candleCacheRef.current = {}
    setCandleCacheVersion(0)
    setRecentMatches([])
    bumpBook()

    // 1) Subscribe WS handlers FIRST
    const handleBook = (data: BookUpdate) => {
      const mktBook: MarketOrderBook = data.payload
      if (!currentXc) return
      const baseCfg = currentXc.assets[selected.baseID]
      const quoteCfg = currentXc.assets[selected.quoteID]
      if (!baseCfg || !quoteCfg) return
      if (mktBook.base !== baseCfg.id || mktBook.quote !== quoteCfg.id || data.host !== selected.host) return

      const book = new OrderBook(mktBook, baseCfg.symbol, quoteCfg.symbol)
      for (const order of (mktBook.book.epoch || [])) {
        if (order.rate > 0) book.add(order)
      }
      bookRef.current = book
      setRecentMatches(mktBook.book.recentMatches ?? [])
      bumpBook()

      // Auto-fill initial rate into order forms (mirrors vanilla reInitOrderForms).
      const bestBuy = book.bestBuyRateAtom()
      const bestSell = book.bestSellRateAtom()
      const initRate = (bestBuy && bestSell)
        ? Math.round((bestBuy + bestSell) / 2)
        : (bestBuy || bestSell)
      if (initRate) fillRateFromBook(initRate)
    }

    const handleBookOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const order = data.payload as MiniOrder
      if (order.rate > 0 && bookRef.current) bookRef.current.add(order)
      bumpBook()
    }

    const handleUnbookOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      if (bookRef.current) bookRef.current.remove(data.payload.id)
      bumpBook()
    }

    const handleUpdateRemaining = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const update: RemainderUpdate = data.payload
      if (bookRef.current) bookRef.current.updateRemaining(update.id, update.qty, update.qtyAtomic)
      bumpBook()
    }

    const handleEpochOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const order = data.payload as MiniOrder
      if (order.msgRate > 0 && bookRef.current) bookRef.current.add(order)
      bumpBook()
    }

    const handleCandles = (data: BookUpdate) => {
      if (data.host !== selected.host) return
      if (!data.payload?.candles) return
      const dur = data.payload.dur
      candleCacheRef.current[dur] = data.payload
      // MP-20: notify the high/low fallback only when the 5m cache changes.
      if (dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== dur) return
      setCandleData(data.payload)
      setCandleLoading(false)
    }

    const handleCandleUpdate = (data: BookUpdate) => {
      if (data.host !== selected.host) return
      const { dur, candle } = data.payload
      const cache = candleCacheRef.current[dur]
      if (!cache) return
      const candles = cache.candles
      if (candles.length === 0) {
        candles.push(candle)
      } else {
        const last = candles[candles.length - 1]
        if (last.startStamp === candle.startStamp) candles[candles.length - 1] = candle
        else candles.push(candle)
      }
      // MP-20: live-update the high/low fallback when the 5m cache mutates
      // so the stats header reflects drift in real time.
      if (dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== dur) return
      setCandleData({ ...cache })
    }

    const handleEpochMatchSummary = (data: BookUpdate) => {
      if (!data.payload?.matchSummaries) return
      // Vanilla `addRecentMatches` caps the buffer at 100 entries — match it
      // for parity with the legacy client's memory footprint and the
      // `recentMatchesBox` render window.
      setRecentMatches(prev => [...data.payload.matchSummaries, ...prev].slice(0, 100))
    }

    wsSubscribe('book', handleBook)
    wsSubscribe('book_order', handleBookOrder)
    wsSubscribe('unbook_order', handleUnbookOrder)
    wsSubscribe('update_remaining', handleUpdateRemaining)
    wsSubscribe('epoch_order', handleEpochOrder)
    wsSubscribe('candles', handleCandles)
    wsSubscribe('candle_update', handleCandleUpdate)
    wsSubscribe('epoch_match_summary', handleEpochMatchSummary)

    // 2) THEN send loadmarket (handlers are guaranteed to be ready)
    wsRequest('loadmarket', {
      host: selected.host,
      base: selected.baseID,
      quote: selected.quoteID
    })

    return () => {
      wsUnsubscribe('book')
      wsUnsubscribe('book_order')
      wsUnsubscribe('unbook_order')
      wsUnsubscribe('update_remaining')
      wsUnsubscribe('epoch_order')
      wsUnsubscribe('candles')
      wsUnsubscribe('candle_update')
      wsUnsubscribe('epoch_match_summary')
      wsRequest('unmarket', {})
    }
  }, [selected, isWsConnected, currentXc, currentMktId, wsSubscribe, wsUnsubscribe, wsRequest, bumpBook])

  // -------------------------------------------------------------------------
  // Load candles when market or duration changes
  // -------------------------------------------------------------------------
  const loadCandles = useCallback(() => {
    if (!selected || !currentXc) return
    const cache = candleCacheRef.current[candleDur]
    if (cache) {
      setCandleData(cache)
      setCandleLoading(false)
      return
    }
    reqCandleDurRef.current = candleDur
    setCandleLoading(true)
    wsRequest('loadcandles', {
      host: selected.host,
      base: selected.baseID,
      quote: selected.quoteID,
      dur: candleDur
    })
  }, [selected, currentXc, isWsConnected, candleDur, wsRequest])

  useEffect(() => {
    loadCandles()
  }, [loadCandles])

  // -------------------------------------------------------------------------
  // Load active orders
  // -------------------------------------------------------------------------
  const loadActiveOrders = useCallback(async () => {
    if (!selected) return
    const filter: OrderFilter = {
      hosts: [selected.host],
      market: { baseID: selected.baseID, quoteID: selected.quoteID },
      n: MAX_ACTIVE_ORDERS
    }
    const res = await postJSON('/api/orders', filter)
    if (!checkResponse(res) || !res.orders) {
      setActiveOrders([])
      return
    }
    const active = (res.orders as Order[]).filter(ord => {
      return ord.status < StatusExecuted || hasActiveMatches(ord)
    })
    setActiveOrders(active.slice(0, MAX_ACTIVE_ORDERS))
  }, [selected])

  useEffect(() => {
    loadActiveOrders()
  }, [loadActiveOrders])

  // -------------------------------------------------------------------------
  // Load completed orders
  // -------------------------------------------------------------------------
  const loadCompletedOrders = useCallback(async (period: string) => {
    if (!selected) return
    const entry = COMPLETED_PERIODS.find(p => p.key === period)
    if (!entry || entry.ms === 0) {
      setCompletedOrders([])
      return
    }
    const filter: OrderFilter = {
      hosts: [selected.host],
      market: { baseID: selected.baseID, quoteID: selected.quoteID },
      statuses: [StatusExecuted, StatusCanceled, StatusRevoked],
      fresherThanUnixMs: Date.now() - entry.ms,
      n: MAX_COMPLETED_ORDERS
    }
    const res = await postJSON('/api/orders', filter)
    if (!checkResponse(res) || !res.orders) {
      setCompletedOrders([])
      return
    }
    setCompletedOrders(res.orders)
  }, [selected])

  useEffect(() => {
    loadCompletedOrders(completedPeriod)
  }, [completedPeriod, loadCompletedOrders])

  // -------------------------------------------------------------------------
  // Note handlers (order, match, epoch, balance, spots, bond, walletstate)
  // -------------------------------------------------------------------------
  const noteHandlers = useMemo(() => ({
    order: (note: OrderNote) => {
      if (!selected) return
      const ord = note.order
      if (ord.host !== selected.host) return
      if (ord.baseID !== selected.baseID || ord.quoteID !== selected.quoteID) return
      // MP-66: vanilla `handleOrderNote` (markets.ts L2718) branches on the
      // note topic and on the order's filled/qty equality to imperatively
      // toggle row visibility, the cancel button, and the meta-order text.
      // Specifically:
      //   - 'AsyncOrderFailure' / 'AsyncOrderSubmitted' / 'OrderLoaded'
      //     (with `readyToTick`) → `refreshRecentlyActiveOrders()`.
      //   - 'MissedCancel' → `Doc.show(mord.details.cancelBttn)`.
      //   - `ord.filled === ord.qty` → `Doc.hide(mord.details.cancelBttn)`.
      //   - epoch→booked or booked→completed transition → `updateReputation`.
      // React's reactive model collapses every branch into a single
      // refetch-and-rerender:
      //   - `loadActiveOrders()` re-runs the `/api/orders` query and feeds
      //     fresh `Order` records into state, so any new order surfaced by
      //     `OrderLoaded`/`AsyncOrderSubmitted` arrives automatically.
      //   - `isCancellable(ord)` (used by the cancel-button conditional in
      //     `UserOrderRow`) is a pure function of the order's status and
      //     tif — after the refetch, `MissedCancel` orders that are still
      //     `status < Executed` keep the button visible, and fully-filled
      //     orders (`status >= Executed`) hide it. No imperative toggling
      //     needed.
      //   - `tierData` recomputes automatically when `currentXc.auth`
      //     changes. Auth refreshes happen via `bondpost` and via the
      //     global `feepayment` / `reputation` handlers in `AppLayout.tsx`
      //     (added in Batch 11), both of which call `fetchUser`. So any
      //     reputation update triggered server-side by an order status
      //     transition flows through to React via the same notification
      //     stream vanilla uses, and the displayed tier refreshes without
      //     any per-handler `fetchUser` here.
      loadActiveOrders()
    },
    match: (note: MatchNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      // MP-65: vanilla `handleMatchNote` (markets.ts L2696) does two things
      // for matches that affect a user order on the current market:
      //   (a) for market orders newly matched, replace the row's rate text
      //       via `marketOrderHeaderRateString` / `marketOrderDetailsRateString`;
      //   (b) on terminal match status (Maker→MakerRedeemed, Taker→MatchComplete)
      //       call `updateReputation`.
      // (a) is covered by `loadActiveOrders` → fresh `ord.matches` → the
      // `marketOrderRateString` helper at L164 (MP-43) recomputes the
      // displayed rate on the next render via `averageRate(ord)`. (b) is
      // covered by the global `feepayment` / `reputation` handlers in
      // `AppLayout.tsx` calling `fetchUser`, which refreshes
      // `currentXc.auth` and triggers `tierData` to recompute reactively —
      // see Batch 11 notes for the full rationale.
      loadActiveOrders()
    },
    epoch: (note: EpochNote) => {
      if (!selected) return
      if (note.host !== selected.host || note.marketID !== currentMktId) return
      if (bookRef.current) bookRef.current.setEpoch(note.epoch)
      bumpBook()
      // MP-62: optimistically advance user order statuses when the new
      // epoch index passes their epoch. Vanilla `handleEpochNote`
      // (markets.ts L2749-2773) updates the row text in-place to feel
      // snappy without waiting for the server's follow-up `order` note.
      // Limit orders advance to Booked (Standing tif) or Executed
      // (Immediate tif); market orders advance to Executed unconditionally
      // because they always run as immediate-tif and are settled within a
      // single epoch.
      //
      // Race guard: between `setSelected(newMarket)` and the new
      // `loadActiveOrders` resolving, `activeOrders` still holds entries
      // from the previous market. Vanilla has the same window in
      // `recentlyActiveUserOrders` (markets.ts L2758 iterates without a
      // per-order market filter), so a stale order whose epoch numbering
      // happens to compare-true against `note.epoch` would be advanced by
      // mistake. We skip orders whose host/baseID/quoteID don't match the
      // currently-selected market — `loadActiveOrders` only ever returns
      // orders for the selected market, so any mismatch is necessarily
      // stale and not ours to mutate.
      setActiveOrders(prev => {
        let changed = false
        const next = prev.map(ord => {
          if (
            ord.host !== selected.host ||
            ord.baseID !== selected.baseID ||
            ord.quoteID !== selected.quoteID
          ) {
            return ord
          }
          const alreadyMatched = note.epoch > ord.epoch
          if (
            ord.type === OrderTypeLimit &&
            ord.status === StatusEpoch &&
            alreadyMatched
          ) {
            changed = true
            return {
              ...ord,
              status: ord.tif === ImmediateTiF ? StatusExecuted : StatusBooked
            }
          }
          if (ord.type === OrderTypeMarket && ord.status === StatusEpoch) {
            changed = true
            return { ...ord, status: StatusExecuted }
          }
          return ord
        })
        return changed ? next : prev
      })
    },
    balance: (_note: BalanceNote) => {
      // MP-63: vanilla `handleBalanceNote` (markets.ts L2823) does three
      // things on a balance update:
      //   (a) flush `mkt.maxBuys` / `mkt.maxSell` whenever the cached
      //       buy/sell balance differs from the new available balance;
      //   (b) call `previewMaxBuy` / `previewMaxSell` to refresh the
      //       displayed max estimate;
      //   (c) call `this.approveTokenForm.handleBalanceNote(note)` so the
      //       token-approval modal updates its displayed wallet balance.
      // All three are covered reactively in React — no imperative call
      // needed:
      //   (a) `useMarketStore.handleBalanceNote` (in `AppLayout`'s global
      //       dispatcher) replaces `walletMap` with a fresh reference. The
      //       `OrderForm` `maxCacheRef` is wiped by an effect with
      //       `[walletMap]` deps (L937-940 in this file).
      //   (b) `requestMax` is a `useCallback` whose deps include
      //       `walletMap`; when it recreates, the validate `useEffect`
      //       (L1115-1153) re-runs and calls `requestMax`, which fetches
      //       a fresh estimate now that the cache is empty.
      //   (c) `TokenApprovalForm` registers its own `balance` feeder
      //       (components/common/TokenApprovalForm.tsx L47-52) that
      //       re-reads the wallet's available balance from the auth store.
    },
    spots: (_note: SpotPriceNote) => {
      // Spot prices updated through auth store
    },
    bondpost: (note: BondNote) => {
      if (!selected) return
      if (note.dex !== selected.host) return
      fetchUser()
    },
    walletstate: (_note: WalletStateNote) => {
      // Wallet state updated through auth store (`handleWalletStateNote` in
      // useMarketStore sets new object references on `assets`/`walletMap`).
      // Everything that depends on wallet state — `noWalletMsg`,
      // `tokenApprovalStatus` (MP-27 + MP-61 token approval half),
      // `OrderForm` max caches — recomputes automatically via memo deps,
      // mirroring vanilla `handleWalletState` calling
      // `setTokenApprovalVisibility`. The `resolveOrderVsMMForm` half of
      // vanilla's handler (order form suppression) stays deferred — see
      // TASKS.md section K (MP-61) for the gating-design discussion.
    },
    conn: (note: ConnEventNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      // MP-64: vanilla `handleConnNote` (markets.ts L3698) calls
      //   `await app().fetchUser(); await app().loadPage('markets')`
      // when the DEX server is enabled/disabled or the connection becomes
      // Connected. `loadPage('markets')` is a full re-init that re-fetches
      // book / candles / user orders / user info.
      //
      // Mirror that here. The useMarketStore fix (replacing the xc object
      // with a fresh reference instead of mutating in place) makes the
      // `currentXc` identity change on every conn note, which in turn
      // re-runs the market-subscription `useEffect` (deps include
      // `currentXc`) and the candle-load `useEffect`. Book and candles
      // re-subscribe automatically. Active orders are gated by `selected`
      // (not `currentXc`), so we explicitly refetch them here for
      // parity with vanilla's full re-init.
      if (
        note.topic === 'DEXDisabled' ||
        note.topic === 'DEXEnabled' ||
        note.connectionStatus === ConnectionStatus.Connected
      ) {
        fetchUser()
        loadActiveOrders()
      }
    }
  }), [selected, currentMktId, bumpBook, loadActiveOrders, fetchUser])

  useNotifications(noteHandlers)

  // -------------------------------------------------------------------------
  // Market select handler
  // -------------------------------------------------------------------------
  const selectMarket = useCallback((host: string, baseID: number, quoteID: number) => {
    setSelected({ host, baseID, quoteID })
    setSearchParams({ host, baseID: String(baseID), quoteID: String(quoteID) })
    setBookRateAtom(0)
    setBookRateVersion(0)
  }, [setSearchParams])

  // Fill rate from order book click (propagated to both OrderForm instances)
  const fillRateFromBook = useCallback((msgRate: number) => {
    setBookRateAtom(msgRate)
    setBookRateVersion(v => v + 1)
  }, [])

  // Cancel order
  const cancelOrder = useCallback(async (orderID: string) => {
    const res = await postJSON('/api/cancel', { orderID })
    if (!checkResponse(res)) return
    loadActiveOrders()
  }, [loadActiveOrders])

  // -------------------------------------------------------------------------
  // Candle chart reporters
  // -------------------------------------------------------------------------
  const candleReporters: CandleReporters = useMemo(() => ({
    mouse: (c: Candle | null) => setMouseCandle(c)
  }), [])

  // -------------------------------------------------------------------------
  // Filtered market list
  // -------------------------------------------------------------------------
  const filteredMarkets = useMemo(() => {
    if (!marketSearch) return allMarkets
    const q = marketSearch.toLowerCase()
    return allMarkets.filter(m =>
      m.baseSymbol.toLowerCase().includes(q) ||
      m.quoteSymbol.toLowerCase().includes(q) ||
      m.host.toLowerCase().includes(q)
    )
  }, [allMarkets, marketSearch])

  // -------------------------------------------------------------------------
  // Fiat reference rates and derived external (non-Bison) price.
  // Declared above `orderBookData` because the memo below reads
  // `externalPriceConv` to compute per-row rate deltas (MP-01). Shared with
  // the stats header pill (MP-25) and the order-book mid-section hint (MP-26).
  // -------------------------------------------------------------------------
  const baseFiatRate = selected ? (fiatRatesMap[selected.baseID] ?? 0) : 0
  const quoteFiatRate = selected ? (fiatRatesMap[selected.quoteID] ?? 0) : 0
  const externalPriceConv = (baseFiatRate && quoteFiatRate) ? baseFiatRate / quoteFiatRate : 0

  // -------------------------------------------------------------------------
  // Order book display data (memoized from bookRef + bookVersion)
  //
  // Produces enriched rows with:
  //  - grouped qty + count (MP-04, via binOrdersByRateAndEpoch)
  //  - rate delta vs external fiat price (MP-01)
  //  - own-order flag (MP-02) sourced from activeOrders
  //  - epoch flag (MP-03)
  //  - priceRelevance + rowWeightRatio for bg gradient (MP-05)
  //  - capped at ORDER_BOOK_SIDE_MAX=13 per side (MP-06)
  // -------------------------------------------------------------------------
  const orderBookData = useMemo<{ buys: OrderBookDisplayRow[]; sells: OrderBookDisplayRow[] }>(() => {
    const book = bookRef.current
    if (!book || !bui || !qui || !currentMkt || !selected) return { buys: [], sells: [] }

    // MP-01: Rate-delta reads the component-scoped `externalPriceConv` (hoisted
    // above) so the value is shared with the stats header and order-book mid
    // section; this also narrows the memo's re-render trigger from "any fiat
    // rate change" to "base/quote fiat rate change".
    const userOrderIds = new Set(activeOrders.map(o => o.id))

    const buildSide = (orders: MiniOrder[], sell: boolean): OrderBookDisplayRow[] => {
      const bestOrder = book.bestOrder(sell)
      const heaviestOrder = book.heaviestOrder(sell, MAX_PRICE_DIVERGENCE)
      if (!bestOrder || !heaviestOrder) return []

      const allBins = binOrdersByRateAndEpoch(orders)
      const bins = allBins.slice(0, ORDER_BOOK_SIDE_MAX)

      return bins.map((bin, idx) => {
        const firstOrder = bin[0]
        const msgRate = firstOrder.msgRate
        const isEpoch = !!firstOrder.epoch
        const binQtyAtom = bin.reduce((sum, o) => sum + o.qtyAtomic, 0)

        // Row weight gradient inputs (MP-05)
        let priceDivergence = MAX_PRICE_DIVERGENCE
        if (sell) {
          priceDivergence = Math.min((msgRate - bestOrder.msgRate) / bestOrder.msgRate, MAX_PRICE_DIVERGENCE)
        } else {
          priceDivergence = Math.min((bestOrder.msgRate - msgRate) / bestOrder.msgRate, MAX_PRICE_DIVERGENCE)
        }
        const priceRelevance = (MAX_PRICE_DIVERGENCE - priceDivergence) / MAX_PRICE_DIVERGENCE
        const rowWeightRatio = Math.min(binQtyAtom / heaviestOrder.qtyAtomic, 1.0)

        // Own-order check (MP-02)
        const hasOwnOrder = bin.some(o => userOrderIds.has(o.id))

        // Rate delta vs external fiat price (MP-01)
        let deltaText = '(?)'
        let deltaInverted = false
        if (externalPriceConv > 0 && firstOrder.rate > 0) {
          const priceDelta = sell
            ? ((firstOrder.rate - externalPriceConv) / externalPriceConv) * 100
            : ((externalPriceConv - firstOrder.rate) / externalPriceConv) * 100
          if (priceDelta < 9.94) {
            deltaText = `(${priceDelta.toFixed(1)}%)`
          } else {
            deltaText = '(∞)'
          }
          deltaInverted = priceDelta < 0
        }

        return {
          rate: msgRate,
          msgRate,
          qty: binQtyAtom,
          numOrders: bin.length,
          isEpoch,
          hasOwnOrder,
          deltaText,
          deltaInverted,
          priceRelevance,
          rowWeightRatio,
          key: `${sell ? 's' : 'b'}-${msgRate}-${isEpoch ? 'e' : 'n'}-${idx}`
        }
      })
    }

    return {
      buys: buildSide(book.buys, false),
      sells: buildSide(book.sells, true).reverse()
    }
  }, [bookVersion, bui, qui, currentMkt, selected, externalPriceConv, activeOrders])

  // -------------------------------------------------------------------------
  // Computed market stats
  // -------------------------------------------------------------------------
  const spotRate = currentMkt?.spot?.rate ?? 0
  // `midGap` reads through `bookRef.current`, but the render is already
  // re-triggered by `bumpBook` (setState) on every book update, so the
  // recomputed value propagates to downstream useEffects naturally.
  const midGap = midGapRate(bookRef.current)
  const displayRate = midGap || spotRate
  const spot = currentMkt?.spot
  const change24 = spot?.change24 ?? 0
  const vol24 = spot?.vol24 ?? 0
  // MP-20: High/low prefer spot values; when missing, fall back to iterating
  // the 5m candle cache over the last 24h (matches vanilla setHighLowMarketStats).
  // The fallback is only reachable when the user has previously viewed 5m
  // candles for this market (the cache is populated via WS on-demand).
  const [high24, low24] = useMemo<[number, number]>(() => {
    const sHigh = spot?.high24 ?? 0
    const sLow = spot?.low24 ?? 0
    if (sHigh > 0 && sLow > 0) return [sHigh, sLow]
    const cache = candleCacheRef.current['5m']
    if (!cache || !cache.candles?.length) return [sHigh, sLow]
    const aDayAgo = Date.now() - 86400000
    let h = 0
    let l = 0
    for (let i = cache.candles.length - 1; i >= 0; i--) {
      const c = cache.candles[i]
      if (c.endStamp < aDayAgo) break
      if (l === 0 || (c.lowRate > 0 && c.lowRate < l)) l = c.lowRate
      if (c.highRate > h) h = c.highRate
    }
    return [h || sHigh, l || sLow]
  }, [spot, candleCacheVersion])
  // MP-24: Bison-price color (buycolor/sellcolor) and rounding direction are
  // derived from the most recent match on this market. `RecentMatch.sell` is
  // expressed from the taker's perspective, so `!sell` === "last match was a
  // buy". We find the latest stamp without mutating `recentMatches`, which
  // React owns. Returns null when there are no matches yet.
  const mostRecentMatchIsBuy = useMemo<boolean | null>(() => {
    if (recentMatches.length === 0) return null
    let latest = recentMatches[0]
    for (let i = 1; i < recentMatches.length; i++) {
      if (recentMatches[i].stamp > latest.stamp) latest = recentMatches[i]
    }
    return !latest.sell
  }, [recentMatches])
  // Vanilla `setCurrMarketPrice` shows a bison-price number only when BOTH
  // `mkt.spot` exists AND there is at least one recent match; otherwise it
  // falls back to "-" and strips the color classes. We mirror that gate.
  const hasBisonPrice = !!(spot && spotRate > 0 && mostRecentMatchIsBuy !== null)

  // -------------------------------------------------------------------------
  // Trading tier / reputation data
  //
  // Mirrors vanilla `updateReputation`:
  //  - parcelSizeLots            = mkt.parcelsize
  //  - marketLimitBase           = formatBestWeCan(parcelsize * lotsize / buiConv)
  //  - marketLimitQuote          = formatBestWeCan(parcelsize * qty / quiConv)
  //    where qty = lotsize * conversionRate and conversionRate comes from
  //    vanilla `anyRate()` priority order: order-book mid-gap → spot.rate →
  //    fiat ratio; returns "-" when no rate is available.
  //  - tradingTier               = strongTier(auth)
  //  - tradingLimit              = (parcelLimit * parcelsize).toFixed(2)  [MP-35]
  //  - limitUsage                = (usedParcels / parcelLimit * 100).toFixed(1)
  //
  // Visibility (MP-36): the whole box is hidden unless
  //   effectiveTier > 0 || pendingStrength > 0.
  // -------------------------------------------------------------------------
  const tierData = useMemo(() => {
    if (!selected || !currentXc || !currentMkt || !bui || !qui) return null
    const auth = currentXc.auth
    const { effectiveTier, pendingStrength } = auth
    const visible = effectiveTier > 0 || pendingStrength > 0

    const tier = strongTier(auth)
    const [usedParcels, parcelLimit] = tradingLimits(exchanges, selected.host)

    const parcelsize = currentMkt.parcelsize
    const lotsize = currentMkt.lotsize
    const buiConvFactor = bui.conventional.conversionFactor
    const quiConvFactor = qui.conventional.conversionFactor

    // Parcel size in base (MP-35) — parity with vanilla `marketLimitBase`.
    const parcelSizeBaseStr = formatBestWeCan(parcelsize * lotsize / buiConvFactor)

    // Conversion rate (conventional quote per conventional base), priority
    // order mirrors vanilla `anyRate()`: mid-gap → spot.rate → fiat ratio.
    //   atomicRate / rateConversionFactor == atomicRate * buiConv / (RateEncodingFactor * quiConv)
    // Fiat fallback already produces a conventional ratio directly.
    let conversionRate = 0
    const atomicRate = midGap || spotRate
    if (atomicRate > 0) {
      conversionRate = atomicRate * buiConvFactor / (RateEncodingFactor * quiConvFactor)
    } else if (externalPriceConv > 0) {
      conversionRate = externalPriceConv
    }

    // Parcel size in quote (MP-35) — parity with vanilla `marketLimitQuote`.
    let parcelSizeQuoteStr: string | null = null
    if (conversionRate > 0) {
      const qty = lotsize * conversionRate
      parcelSizeQuoteStr = formatBestWeCan(parcelsize * qty / quiConvFactor)
    }

    // Trading limit (MP-35): parcelLimit in "lots" units, vanilla multiplies
    // by parcelsize and renders with 2 decimals.
    const tradingLimitStr = (parcelLimit * parcelsize).toFixed(2)
    const limitUsageStr = parcelLimit > 0
      ? (usedParcels / parcelLimit * 100).toFixed(1)
      : '0'

    return {
      visible,
      effectiveTier,
      pendingStrength,
      tier,
      usedParcels,
      parcelLimit,
      parcelSize: parcelsize,
      parcelSizeBaseStr,
      parcelSizeQuoteStr,
      baseUnit: bui.conventional.unit,
      quoteUnit: qui.conventional.unit,
      tradingLimitStr,
      limitUsageStr
    }
  }, [selected, currentXc, currentMkt, bui, qui, exchanges, midGap, spotRate, externalPriceConv])

  // -------------------------------------------------------------------------
  // Display helpers (available to both render and effects below)
  // -------------------------------------------------------------------------
  const baseSymbol = baseAsset?.symbol?.toUpperCase() ?? ''
  const quoteSymbol = quoteAsset?.symbol?.toUpperCase() ?? ''
  const buiConv = bui?.conventional

  // -------------------------------------------------------------------------
  // Rightmost-panel visibility/content computations
  //
  // MP-28: `loaderMsgText` — mirrors vanilla `assetsAreSupported` +
  //   `setLoaderMsgVisibility`. When either base or quote asset version isn't
  //   in the supported-versions list for this client build, the loaderMsg
  //   panel is shown with a translated "X (vN) is not supported" message.
  //   Empty string = supported = panel hidden. When shown, vanilla also hides
  //   `notRegistered` and `noWallet`, so those panels gate on `!loaderMsgText`.
  //
  // MP-33: `noWalletMsg` — mirrors vanilla `displayMessageIfMissingWallet`.
  //   Branches over missing / disabled / not-running wallet states and picks
  //   the matching i18n key (NO_WALLET_MSG / CREATE_ASSET_WALLET_MSG /
  //   ENABLE_ASSET_WALLET_MSG). Empty string = no message = panel hidden.
  //
  // MP-34: `hasUnreadyOrders` — mirrors vanilla's `unreadyOrders` flag inside
  //   `drawRecentlyActiveUserOrders`. True when any active user order is on a
  //   wallet that isn't ready-to-tick AND has active matches (the combination
  //   means funds could get stuck). Drives the red banner above Open Orders.
  //   Note: the per-row `unready-user-order` CSS class (MP-38) is tracked
  //   separately in Section G and deferred to Batch 7+.
  // -------------------------------------------------------------------------
  const loaderMsgText = useMemo<string>(() => {
    if (!selected || !currentXc || !baseAsset || !quoteAsset || !bui || !qui) return ''
    const baseXcAsset = currentXc.assets[selected.baseID]
    const quoteXcAsset = currentXc.assets[selected.quoteID]
    if (!baseXcAsset || !quoteXcAsset) return ''
    const versions = (a: SupportedAsset): number[] =>
      (a.token ? a.token.supportedAssetVersions : a.info?.versions) ?? []
    const baseSupported = versions(baseAsset).includes(baseXcAsset.version)
    const quoteSupported = versions(quoteAsset).includes(quoteXcAsset.version)
    if (!baseSupported) {
      return t('VERSION_NOT_SUPPORTED', {
        asset: bui.conventional.unit,
        version: String(baseXcAsset.version)
      })
    }
    if (!quoteSupported) {
      // Note: vanilla passes `base.unitInfo.conventional.unit` here too — this
      // looks like a bug (should be `quote.unitInfo...`), but we preserve parity.
      return t('VERSION_NOT_SUPPORTED', {
        asset: bui.conventional.unit,
        version: String(quoteXcAsset.version)
      })
    }
    return ''
  }, [selected, currentXc, baseAsset, quoteAsset, bui, qui, t])

  const noWalletMsg = useMemo<string>(() => {
    if (!selected || !baseAsset || !quoteAsset) return ''
    const baseSym = baseSymbol
    const quoteSym = quoteSymbol
    const baseWallet = baseAsset.wallet
    const quoteWallet = quoteAsset.wallet
    if (!baseWallet && !quoteWallet) {
      return t('NO_WALLET_MSG', { asset1: baseSym, asset2: quoteSym })
    }
    if (!baseWallet) {
      return t('CREATE_ASSET_WALLET_MSG', { asset: baseSym })
    }
    if (!quoteWallet) {
      return t('CREATE_ASSET_WALLET_MSG', { asset: quoteSym })
    }
    if (baseWallet.disabled || !baseWallet.running) {
      return t('ENABLE_ASSET_WALLET_MSG', { asset: baseSym })
    }
    if (quoteWallet.disabled || !quoteWallet.running) {
      return t('ENABLE_ASSET_WALLET_MSG', { asset: quoteSym })
    }
    return ''
  }, [selected, baseAsset, quoteAsset, baseSymbol, quoteSymbol, t])

  const hasUnreadyOrders = useMemo<boolean>(() => {
    for (const ord of activeOrders) {
      if (!ord.readyToTick && hasActiveMatches(ord)) return true
    }
    return false
  }, [activeOrders])

  // MP-29..MP-32: Bond / registration status panel selector.
  // Mirrors vanilla `setRegistrationStatusVisibility` + `updateRegistrationStatusView`:
  //   1. effectiveTier >= 1   -> 'none'                 (already tradeable, hide all)
  //   2. viewOnly             -> 'notRegistered'        (MP-Ax, existing panel)
  //   3. targetTier>0 && penalties > penaltyComps
  //                           -> 'penaltyCompsRequired' (MP-31)
  //   4. hasPendingBonds      -> 'registrationStatus'   (MP-30, waiting for confs)
  //   5. targetTier > 0       -> 'bondCreationPending'  (MP-29)
  //   6. else                 -> 'bondRequired'         (MP-32, tier 0 + no target)
  // Vanilla also requires the DEX connection to be Connected before branching
  // (otherwise it short-circuits — the panel state from the last successful
  // connection remains). We mirror that: when disconnected we return 'none'
  // and let the existing chart overlay / loaderMsg surfaces communicate state.
  const statusPanel = useMemo<{
    kind: 'none' | 'notRegistered' | 'penaltyCompsRequired' | 'registrationStatus' | 'bondCreationPending' | 'bondRequired'
    penalties?: number
    penaltyComps?: number
    regStatusTitle?: string
    regStatusConfs?: string
    effectiveTier?: number
  }>(() => {
    if (!currentXc || !selected) return { kind: 'none' }
    if (currentXc.connectionStatus !== ConnectionStatus.Connected) return { kind: 'none' }
    const auth = currentXc.auth
    if (!auth) return { kind: 'none' }

    const effectiveTier = auth.effectiveTier ?? 0
    if (effectiveTier >= 1) return { kind: 'none' }

    if (currentXc.viewOnly) return { kind: 'notRegistered' }

    const targetTier = auth.targetTier ?? 0
    const penalties = auth.rep?.penalties ?? 0
    const penaltyComps = auth.penaltyComps ?? 0

    if (targetTier > 0 && penalties > penaltyComps) {
      return { kind: 'penaltyCompsRequired', penalties, penaltyComps }
    }

    // Vanilla `hasPendingBonds` was `Object.keys(auth.pendingBonds || []).length > 0`
    // — idiosyncratic but works because JS arrays expose numeric keys. Our type
    // declares `pendingBonds: PendingBondState[]`, so a direct length check is
    // both correct and clearer.
    const pendingBonds = auth.pendingBonds ?? []
    if (pendingBonds.length > 0) {
      // Vanilla `updateRegistrationStatusView`: when effectiveTier < 1 (the
      // branch we're on), title is WAITING_FOR_CONFS and confStatusMsg joins
      // "<confs> / <required>" per pending bond with ", ".
      const confStatuses = pendingBonds.map((pending) => {
        const required = currentXc.bondAssets?.[pending.symbol]?.confs ?? 0
        return `${pending.confs} / ${required}`
      })
      return {
        kind: 'registrationStatus',
        regStatusTitle: t('WAITING_FOR_CONFS'),
        regStatusConfs: confStatuses.join(', '),
      }
    }

    if (targetTier > 0) return { kind: 'bondCreationPending' }

    return { kind: 'bondRequired', effectiveTier }
  }, [currentXc, selected, t])

  // MP-27: Token approval panel state.
  // Mirrors vanilla `tokenAssetApprovalStatuses` (markets.ts L1030–1057) +
  // `setTokenApprovalVisibility` (L1063–1096). For each of base/quote, if the
  // asset is a token and its wallet has an `approved[<protocol_version>]`
  // entry, we use that — otherwise we default to `Approved`. Non-token assets
  // always read as `Approved`. The panel is visible when either side isn't
  // fully approved. The notice key switches over which side(s) need approval:
  //   - base NOT approved, quote approved → 'approval_required_sell'
  //   - base approved, quote NOT approved → 'approval_required_buy'
  //   - both NOT approved                  → 'approval_required_both'
  // MP-61 (token approval half): the memo recomputes automatically whenever
  // `assets` or `currentXc` change — and `handleWalletStateNote` in
  // `useMarketStore` bumps those by reference on every walletstate note — so
  // the panel auto-refreshes on wallet state changes without any explicit
  // subscription, matching vanilla's `handleWalletState` calling
  // `setTokenApprovalVisibility`. The `resolveOrderVsMMForm` half of MP-61
  // (form suppression when assets aren't approved) stays deferred to Batch 7+.
  const tokenApprovalStatus = useMemo<{
    visible: boolean
    baseStatus: ApprovalStatus
    quoteStatus: ApprovalStatus
    baseSymbolUpper: string
    quoteSymbolUpper: string
    noticeKey: 'approval_required_buy' | 'approval_required_sell' | 'approval_required_both' | null
  }>(() => {
    const empty = {
      visible: false,
      baseStatus: ApprovalStatus.Approved,
      quoteStatus: ApprovalStatus.Approved,
      baseSymbolUpper: '',
      quoteSymbolUpper: '',
      noticeKey: null,
    }
    if (!selected || !currentXc || !baseAsset || !quoteAsset) return empty

    let baseStatus = ApprovalStatus.Approved
    let quoteStatus = ApprovalStatus.Approved

    if (baseAsset.token && baseAsset.wallet?.approved) {
      const baseXcAsset = currentXc.assets[selected.baseID]
      const baseVersion = baseXcAsset?.version
      if (baseVersion !== undefined && baseAsset.wallet.approved[baseVersion] !== undefined) {
        baseStatus = baseAsset.wallet.approved[baseVersion]
      }
    }
    if (quoteAsset.token && quoteAsset.wallet?.approved) {
      const quoteXcAsset = currentXc.assets[selected.quoteID]
      const quoteVersion = quoteXcAsset?.version
      if (quoteVersion !== undefined && quoteAsset.wallet.approved[quoteVersion] !== undefined) {
        quoteStatus = quoteAsset.wallet.approved[quoteVersion]
      }
    }

    if (baseStatus === ApprovalStatus.Approved && quoteStatus === ApprovalStatus.Approved) return empty

    let noticeKey: 'approval_required_buy' | 'approval_required_sell' | 'approval_required_both' | null = null
    if (baseStatus !== ApprovalStatus.Approved && quoteStatus === ApprovalStatus.Approved) {
      noticeKey = 'approval_required_sell'
    } else if (baseStatus === ApprovalStatus.Approved && quoteStatus !== ApprovalStatus.Approved) {
      noticeKey = 'approval_required_buy'
    } else {
      noticeKey = 'approval_required_both'
    }

    return {
      visible: true,
      baseStatus,
      quoteStatus,
      baseSymbolUpper: baseAsset.symbol.toUpperCase(),
      quoteSymbolUpper: quoteAsset.symbol.toUpperCase(),
      noticeKey,
    }
  }, [selected, currentXc, baseAsset, quoteAsset])

  // Portal target: render market stats into the header slot.
  // Use state so the portal renders after the DOM element is committed.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderSlot(document.getElementById('headerSlot'))
    return () => setHeaderSlot(null)
  }, [])

  // MP-22: Browser tab title reflects mid-gap price and base/quote symbols.
  // Matches vanilla updateTitle: `<midGap> | <base>/<quote> | <ogTitle>` when
  // a mid-gap is available, else `<base>/<quote> | <ogTitle>`. Saves the
  // original title on mount and restores it on unmount. Formats the mid-gap
  // with `formatRateAtomToRateStep` so the title matches the rate-step
  // precision shown in the stats header and order forms.
  const ogTitleRef = useRef<string>('')
  useEffect(() => {
    ogTitleRef.current = document.title
    return () => { document.title = ogTitleRef.current }
  }, [])
  useEffect(() => {
    if (!selected) return
    const symPair = `${baseSymbol}/${quoteSymbol}`
    const og = ogTitleRef.current || 'Bison'
    if (midGap && bui && qui && currentMkt) {
      const midStr = formatRateAtomToRateStep(midGap, bui, qui, currentMkt.ratestep)
      document.title = `${midStr} | ${symPair} | ${og}`
    } else {
      document.title = `${symPair} | ${og}`
    }
  }, [midGap, baseSymbol, quoteSymbol, bui, qui, currentMkt, selected])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!user) {
    return <div className="p-3">Loading...</div>
  }

  return (
    <div data-handler="markets" className="main m-0 flex-nowrap">

      {/* ================================================================= */}
      {/* Market stats — portalled into the header bar */}
      {/* ================================================================= */}
      {selected && headerSlot && createPortal(
        <div id="marketStats" className="d-flex align-items-center px-2">
          <div
            className="flex-center pointer hoverbg px-2"
            onClick={() => setShowMarketList(prev => !prev)}
          >
            <div className="flex-center">
              <img className="small-icon" src={logoPath(baseSymbol)} alt="" />
              <img className="small-icon ms-1" src={logoPath(quoteSymbol)} alt="" />
            </div>
            <div className="d-flex align-items-end fs24 demi ms-1">
              <span>{baseSymbol}</span> / <span>{quoteSymbol}</span>
            </div>
          </div>

          <div className="d-flex flex-stretch-column ps-1 border-right">
            {/* MP-25: External price shown as the fiat ratio (quote-per-base),
                 rendered only when both fiat rates are available. Matches
                 vanilla `setCurrMarketPrice` which hides the pill when the
                 ratio is unknown. */}
            {externalPriceConv > 0 && bui && qui && currentMkt && (
              <div title="Price on external markets such as Binance" className="d-flex align-items-center border-bottom pe-2 fs18 text-warning">
                {formatRateToRateStep(externalPriceConv, bui, qui, currentMkt.ratestep)}
              </div>
            )}
            {/* MP-24: Bison price matches vanilla `setCurrMarketPrice`:
                  - source: `spot.rate` (last-trade price), NOT midGap — shows
                    `-` when no spot or no recent matches;
                  - color: derived from the most recent match side;
                  - rounding direction passed to the formatter also tracks
                    that side;
                  - no unit suffix — vanilla renders only the raw number. */}
            <div
              title="Price last trade executed at"
              className={`d-flex align-items-center pe-2 fs18${hasBisonPrice && mostRecentMatchIsBuy ? ' buycolor' : hasBisonPrice && mostRecentMatchIsBuy === false ? ' sellcolor' : ''}`}
            >
              {hasBisonPrice && bui && qui && currentMkt
                ? formatRateAtomToRateStep(spotRate, bui, qui, currentMkt.ratestep, !mostRecentMatchIsBuy)
                : '-'}
            </div>
          </div>

          <div className="statgrid">
            <span className="fs14 grey px-2 border-right border-bottom">{t('Change24')}</span>
            <span className="fs14 grey px-2 border-right border-bottom">{t('Volume24')}</span>
            <span className="fs14 grey px-2 border-right border-bottom">{t('High24')}</span>
            <span className="fs14 grey ps-2 border-bottom">{t('Low24')}</span>

            <div className={`px-2 fs14 border-right${change24 >= 0 ? '' : ' text-danger'}`}>
              {spot ? `${change24 >= 0 ? '+' : ''}${change24.toFixed(1)}%` : '-'}
            </div>
            {/* MP-23: 24h volume unit switches between USD (when a fiat rate
                 for the base asset is available) and the base asset's
                 conventional unit. Matches vanilla `setCurrMarketPrice`:
                 vol24 is in base atoms, so divide by the base conversion
                 factor; multiply by baseFiatRate when displaying USD. */}
            <div className="d-flex justify-content-start align-items-center px-2 border-right">
              <div className="fs14">
                {spot && buiConv
                  ? baseFiatRate > 0
                    ? formatBestWeCan(vol24 / buiConv.conversionFactor * baseFiatRate)
                    : formatBestWeCan(vol24 / buiConv.conversionFactor)
                  : '-'}
              </div>
              <div className="fs14 grey ms-1">
                {spot && buiConv && baseFiatRate > 0 ? 'USD' : (buiConv?.unit ?? 'USD')}
              </div>
            </div>
            <div className="px-2 fs14 border-right">
              {high24 > 0 && bui && qui && currentMkt
                ? formatRateAtomToRateStep(high24, bui, qui, currentMkt.ratestep)
                : '-'}
            </div>
            <div className="px-2 fs14">
              {low24 > 0 && bui && qui && currentMkt
                ? formatRateAtomToRateStep(low24, bui, qui, currentMkt.ratestep)
                : '-'}
            </div>
          </div>
        </div>,
        headerSlot
      )}

      <div className="flex-grow-1 position-relative">
        <div className="h-100 w-100 overflow-x-hidden flex-stretch-column">
          <div id="mainContent" className="d-flex flex-grow-1 flex-stretch-row">

            {/* ============================================================= */}
            {/* LEFTMOST SECTION: Market list + Order book */}
            {/* ============================================================= */}
            <section className="d-flex align-items-center">
              {/* Market list dock */}
              {showMarketList && (
                <div id="leftMarketDock" className="d-flex flex-stretch-column">
                  <div className="d-flex flex-stretch-column align-items-stretch border-bottom" style={{ height: 55 }}>
                    <form className="flex-grow-1 p-1 position-relative" autoComplete="off">
                      <input
                        type="text"
                        className="my-1 fs24"
                        placeholder=" "
                        spellCheck={false}
                        value={marketSearch}
                        onChange={e => setMarketSearch(e.target.value)}
                        style={{
                          position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
                          width: '100%', zIndex: 2, backgroundColor: 'transparent',
                          border: 'none', textAlign: 'center', textTransform: 'uppercase'
                        }}
                        autoFocus
                      />
                      {!marketSearch && <div className="ico-search fs24" style={{ position: 'absolute', zIndex: 1, left: '50%', top: '50%', transform: 'translateX(-50%) translateY(-50%)', opacity: 0.25 }}></div>}
                    </form>
                  </div>
                  <div className="flex-stretch-column overflow-y-hidden">
                    <div className="d-flex hoveronly overflow-x-hidden flex-stretch-column">
                      {filteredMarkets.map(m => {
                        const isSelected = selected?.host === m.host &&
                          selected?.baseID === m.baseID && selected?.quoteID === m.quoteID
                        // MP-07: disconnected icon when the DEX host for this row is down.
                        const xcForRow = exchanges[m.host]
                        const isDisconnected = xcForRow
                          ? xcForRow.connectionStatus !== ConnectionStatus.Connected
                          : false
                        return (
                          <div
                            key={`${m.host}-${m.baseID}-${m.quoteID}`}
                            className={`d-flex align-items-stretch p-2 border-bottom lh1 pointer hoverbg${isSelected ? ' selected' : ''}`}
                            style={isSelected ? { backgroundColor: 'var(--tertiary-bg)' } : undefined}
                            onClick={() => selectMarket(m.host, m.baseID, m.quoteID)}
                            onDoubleClick={() => {
                              // MP-08: dblclick selects AND collapses the dock in one action.
                              selectMarket(m.host, m.baseID, m.quoteID)
                              setShowMarketList(false)
                            }}
                          >
                            <div className="d-flex flex-column">
                              <div className="d-flex align-items-center justify-content-start flex-grow-1">
                                <img src={logoPath(m.baseSymbol)} alt="" className="small-icon" />
                                <img src={logoPath(m.quoteSymbol)} alt="" className="small-icon ms-1" />
                                {isDisconnected && (
                                  <span
                                    className="text-danger ico-disconnected fs11 ps-1"
                                    title="DEX host disconnected"
                                  />
                                )}
                              </div>
                            </div>
                            <div className="d-flex flex-column flex-grow-1 ps-1">
                              <span className="fs22 demi">
                                {m.baseSymbol.toUpperCase()} / {m.quoteSymbol.toUpperCase()}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Order book (shown when market list is hidden) */}
              {!showMarketList && (
              <div id="orderBook" className="d-flex flex-stretch-column">
                {/* Sell side (asks) - reversed so best ask at bottom */}
                <div className="hoveronly overflow-x-hidden flex-stretch-column ordertable-wrap reversible">
                  <table className="compact lh1">
                    <tbody id="sellRows">
                      {bui && qui && currentMkt && orderBookData.sells.map((row) => (
                        <OrderBookRow
                          key={row.key}
                          row={row}
                          sell
                          bui={bui}
                          qui={qui}
                          ratestep={currentMkt.ratestep}
                          lotsize={currentMkt.lotsize}
                          darkMode={darkMode}
                          onClick={() => fillRateFromBook(row.msgRate)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Spread / mid-gap + external price hint. MP-26 adds the
                     vanilla `obExternalPrice` inline under the mid-gap: when
                     both fiat rates are available, show the external reference
                     rate prefixed with `~`. */}
                <div id="obMidSection" className="d-flex flex-stretch-column align-items-center justify-content-center py-1 px-2">
                  {bui && qui && currentMkt && displayRate > 0 && (
                    <span className="text-warning fs17">
                      {formatRateFullPrecision(displayRate, bui, qui, currentMkt.ratestep)}
                    </span>
                  )}
                  {externalPriceConv > 0 && bui && qui && currentMkt && (
                    <span
                      title="Price on external markets such as Binance"
                      className="text-warning fs14"
                    >
                      ~{formatRateToRateStep(externalPriceConv, bui, qui, currentMkt.ratestep)}
                    </span>
                  )}
                </div>

                {/* Buy side (bids) */}
                <div className="hoveronly overflow-x-hidden flex-stretch-column ordertable-wrap">
                  <table className="compact buys lh1">
                    <tbody id="buyRows">
                      {bui && qui && currentMkt && orderBookData.buys.map((row) => (
                        <OrderBookRow
                          key={row.key}
                          row={row}
                          sell={false}
                          bui={bui}
                          qui={qui}
                          ratestep={currentMkt.ratestep}
                          lotsize={currentMkt.lotsize}
                          darkMode={darkMode}
                          onClick={() => fillRateFromBook(row.msgRate)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {!bookRef.current && (
                  <div className="text-center grey py-4 fs15">
                    {isConnected
                      ? 'Loading order book...'
                      : 'Connecting...'}
                  </div>
                )}
              </div>
              )}
            </section>

            {/* ============================================================= */}
            {/* MIDDLE SECTION: Chart + Buy/Sell forms */}
            {/* ============================================================= */}
            <section className="d-flex flex-stretch-column">
              {/* Candle chart */}
              <section className="d-flex flex-stretch-column">
                <div className="flex-grow-1 flex-stretch-column position-relative">
                  <div className="market-chart">
                    {/* MP-18: Disconnection / disabled overlay. Shown when the
                        exchange is disabled or the connection is down. Vanilla
                        maps this to the #chartErrMsg element and uses
                        CONNECTION_FAILED / DEX_DISABLED_MSG i18n keys. */}
                    {chartErrMsg && (
                      <div id="chartErrMsg" className="flex-center text-center fs18 p-3">
                        {chartErrMsg}
                      </div>
                    )}
                    {/* MP-21: Hide the duration buttons while candles are loading
                        (matches vanilla Doc.hide(page.candleDurBttnBox)). */}
                    {!candleLoading && !chartErrMsg && (
                      <div id="candleDurBttnBox">
                        {candleDurs.map(dur => (
                          <button
                            key={dur}
                            className={`candle-dur-bttn${candleDur === dur ? ' selected' : ''}`}
                            onClick={() => setCandleDur(dur)}
                          >
                            {dur}
                          </button>
                        ))}
                      </div>
                    )}
                    {candleLoading && !chartErrMsg && (
                      <Wave message={t('waiting for candlesticks')} backgroundColor={true} />
                    )}
                    {/* MP-21: Canvas is made `visibility: hidden` (not just
                        opacity 0) while loading so it doesn't intercept mouse
                        events or the legend readout. Matches vanilla's
                        `.invisible` class usage. */}
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        visibility: candleLoading || chartErrMsg ? 'hidden' : 'visible'
                      }}
                    >
                      <CandleChart
                        data={candleData}
                        market={currentMkt}
                        baseUnitInfo={bui}
                        quoteUnitInfo={qui}
                        mktId={currentMktId}
                        reporters={candleReporters}
                      />
                    </div>
                  </div>
                  {!chartErrMsg && mouseCandle && bui && qui && currentMkt && (
                    <div className="grey p-1 border-bottom border-start" style={{ position: 'absolute', top: 0, right: 0 }}>
                      <div className="d-flex align-items-center">
                        <span className="ico-target fs11 me-1"></span>
                        <span>
                          S: {formatRateAtomToRateStep(mouseCandle.startRate, bui, qui, currentMkt.ratestep)},
                          E: {formatRateAtomToRateStep(mouseCandle.endRate, bui, qui, currentMkt.ratestep)},
                          L: {formatRateAtomToRateStep(mouseCandle.lowRate, bui, qui, currentMkt.ratestep)},
                          H: {formatRateAtomToRateStep(mouseCandle.highRate, bui, qui, currentMkt.ratestep)},
                          V: {formatCoinValue(mouseCandle.matchVolume, bui)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Buy / Sell forms (side by side) */}
              <section className="d-flex flex-stretch-row">
                {selected && (
                  <>
                    <OrderForm
                      key={`buy-${selected.host}-${selected.baseID}-${selected.quoteID}`}
                      side="buy"
                      selected={selected}
                      currentMkt={currentMkt}
                      bui={bui}
                      qui={qui}
                      walletMap={walletMap}
                      baseSymbol={baseSymbol}
                      quoteSymbol={quoteSymbol}
                      baseFiatRate={baseFiatRate}
                      quoteFiatRate={quoteFiatRate}
                      bookRateAtom={bookRateAtom}
                      bookRateVersion={bookRateVersion}
                      onOrderSubmitted={() => setTimeout(() => loadActiveOrders(), 1000)}
                    />
                    <OrderForm
                      key={`sell-${selected.host}-${selected.baseID}-${selected.quoteID}`}
                      side="sell"
                      selected={selected}
                      currentMkt={currentMkt}
                      bui={bui}
                      qui={qui}
                      walletMap={walletMap}
                      baseSymbol={baseSymbol}
                      quoteSymbol={quoteSymbol}
                      baseFiatRate={baseFiatRate}
                      quoteFiatRate={quoteFiatRate}
                      bookRateAtom={bookRateAtom}
                      bookRateVersion={bookRateVersion}
                      onOrderSubmitted={() => setTimeout(() => loadActiveOrders(), 1000)}
                    />
                  </>
                )}

                {/* Not registered notice */}
                {!isRegistered && currentXc && (
                  <div className="p-3 flex-center fs17 grey">{t('create_account_to_trade')}</div>
                )}
              </section>
            </section>

            {/* ============================================================= */}
            {/* RIGHTMOST SECTION: Orders, reputation, matches */}
            {/* ============================================================= */}
            <section className="rightmost-panel pb-3 position-relative">
              {/* MP-37: Scroll container ref — `UserOrderRow`'s floater
                  menu listens for scrolls here to keep itself anchored to
                  its owning row. Matches vanilla's `page.orderScroller`. */}
              <div className="flex-stretch-column" ref={orderScrollerRef}>

                {/* MP-27: Token approval panel. Mirrors vanilla `#tokenApproval`
                    markup and the 5-way `setTokenApprovalVisibility` branching.
                    Appears ABOVE `loaderMsg` to match vanilla template order.
                    Buttons open the `approveTokenForm` modal via FormOverlay. */}
                {tokenApprovalStatus.visible && selected && (
                  <div className="fs15 pt-1 pb-3 text-center border-bottom">
                    {tokenApprovalStatus.noticeKey === 'approval_required_buy' && (
                      <span className="p-3 flex-center fs17 grey">{t('approval_required_buy')}</span>
                    )}
                    {tokenApprovalStatus.noticeKey === 'approval_required_sell' && (
                      <span className="p-3 flex-center fs17 grey">{t('approval_required_sell')}</span>
                    )}
                    {tokenApprovalStatus.noticeKey === 'approval_required_both' && (
                      <span className="p-3 flex-center fs17 grey">{t('approval_required_both')}</span>
                    )}
                    {tokenApprovalStatus.baseStatus === ApprovalStatus.NotApproved && (
                      <button
                        type="button"
                        className="go"
                        onClick={() => setApproveAssetID(selected.baseID)}
                      >
                        {t('Approve')} <span>{tokenApprovalStatus.baseSymbolUpper}</span>
                      </button>
                    )}
                    {tokenApprovalStatus.baseStatus === ApprovalStatus.Pending && (
                      <div className="flex-center position-relative py-2">
                        <span className="px-1">{tokenApprovalStatus.baseSymbolUpper}</span> {t('approval_change_pending')}
                        <div className="px-2 ico-spinner spinner fs15"></div>
                      </div>
                    )}
                    {tokenApprovalStatus.quoteStatus === ApprovalStatus.NotApproved && (
                      <button
                        type="button"
                        className="go"
                        onClick={() => setApproveAssetID(selected.quoteID)}
                      >
                        {t('Approve')} <span>{tokenApprovalStatus.quoteSymbolUpper}</span>
                      </button>
                    )}
                    {tokenApprovalStatus.quoteStatus === ApprovalStatus.Pending && (
                      <div className="flex-center position-relative py-2">
                        <span className="px-1">{tokenApprovalStatus.quoteSymbolUpper}</span> {t('approval_change_pending')}
                        <div className="px-2 ico-spinner spinner fs15"></div>
                      </div>
                    )}
                  </div>
                )}

                {/* MP-28: Unsupported-asset-version loader message.
                    Vanilla's `setLoaderMsgVisibility` also hides `notRegistered`
                    and `noWallet` (but NOT the 4 bond/registration status
                    panels — those can co-exist with the loaderMsg). */}
                {loaderMsgText && (
                  <div className="fs15 pt-3 text-center">{loaderMsgText}</div>
                )}

                {/* Not registered notice (viewOnly DEX). Gated on loaderMsgText
                    per vanilla. */}
                {!loaderMsgText && statusPanel.kind === 'notRegistered' && selected && (
                  <div>
                    <div className="p-3 flex-center fs17 grey">{t('create_account_to_trade')}</div>
                    <div className="border-top border-bottom flex-center p-2">
                      <p className="text-center fs14 p-2 m-0">{t('need_to_register_msg', { host: selected.host })}</p>
                      <button
                        type="button"
                        className="text-nowrap"
                        onClick={() => navigate(`/register?host=${encodeURIComponent(selected.host)}`)}
                      >
                        {t('Create Account')}
                      </button>
                    </div>
                  </div>
                )}

                {/* MP-29: Bond creation pending — posting bonds shortly. */}
                {statusPanel.kind === 'bondCreationPending' && selected && (
                  <div className="p-2 mt-2">
                    <div className="p-0 w-100">
                      <div className="d-flex flex-column justify-content-center align-items-center">
                        <p className="title">{t('posting_bonds_shortly')}</p>
                        <p>{t('bond_creation_pending_msg', { host: selected.host })}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* MP-30: Registration status — waiting for bond confirmations. */}
                {statusPanel.kind === 'registrationStatus' && selected && (
                  <div className="p-2 mt-2 waiting">
                    <div className="p-0 w-100">
                      <div className="d-flex flex-column justify-content-center align-items-center">
                        <span className="title">{statusPanel.regStatusTitle}</span>
                        <p>{t('reg_status_msg', { host: selected.host })}</p>
                        <span>{statusPanel.regStatusConfs}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* MP-31: Penalty-comps required to trade. */}
                {statusPanel.kind === 'penaltyCompsRequired' && selected && (
                  <div className="p-2 mt-2">
                    <div className="p-3 flex-center fs16 grey">{t('action_required_to_trade')}</div>
                    <div className="border-top border-bottom flex-center p-2">
                      <p className="text-center fs14 p-2 m-0">
                        {t('set_penalty_comps', {
                          penalties: statusPanel.penalties ?? 0,
                          penaltyComps: statusPanel.penaltyComps ?? 0,
                        })}{' '}
                        <a
                          className="fs15 hoverbg subtlelink pointer"
                          onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
                        >
                          {t('update_penalty_comps')}
                        </a>
                      </p>
                    </div>
                  </div>
                )}

                {/* MP-32: Bond required — tier 0, no target tier set. */}
                {statusPanel.kind === 'bondRequired' && selected && (
                  <div className="p-2 mt-2">
                    <div className="p-3 flex-center fs17 grey">{t('action_required_to_trade')}</div>
                    <div className="border-top border-bottom flex-center p-2">
                      <p className="text-center fs16 p-2 m-0">
                        {t('acct_tier_post_bond', { tier: statusPanel.effectiveTier ?? 0 })}{' '}
                        <a
                          className="fs16 hoverbg subtlelink pointer"
                          onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
                        >
                          {t('enable_bond_maintenance')}
                        </a>
                      </p>
                    </div>
                  </div>
                )}

                {/* MP-33: No-wallet CTA (missing / disabled / not-running) */}
                {!loaderMsgText && noWalletMsg && (
                  <div className="p-3 border-bottom flex-center fs17 grey">{noWalletMsg}</div>
                )}

                {/* Reputation & Trading Tier (collapsible)
                    MP-36: visible only when effectiveTier > 0 || pendingStrength > 0
                    MP-35: parcel size shown in BOTH base and quote amounts */}
                {selected && currentXc && isRegistered && tierData && tierData.visible && (
                  <div>
                    <div
                      className="p-2 grey fs15 hoverbg pointer"
                      onClick={() => setShowTradingTier(!showTradingTier)}
                    >
                      <span className={`ico-${showTradingTier ? 'minus' : 'plus'} fs10 me-2`}></span>
                      <span>{showTradingTier ? t('Hide trading tier info') : t('Show trading tier info')}</span>
                    </div>
                    {showTradingTier && (
                      <div className="d-flex flex-stretch-column fs15 mx-2 mb-2 border">
                        <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1 border-bottom">
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Parcel Size')}</span>
                            <span>{tierData.parcelSize} {t('lots')}</span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span></span>
                            <span>
                              {tierData.parcelSizeBaseStr} <span className="grey">{tierData.baseUnit}</span>
                            </span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span></span>
                            <span>
                              ~ {tierData.parcelSizeQuoteStr ?? '-'} <span className="grey">{tierData.quoteUnit}</span>
                            </span>
                          </div>
                        </div>
                        <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1">
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Trading Tier')}</span>
                            <span>{tierData.tier}</span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Trading Limit')}</span>
                            <span>{tierData.tradingLimitStr} {t('lots')}</span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Current Usage')}</span>
                            <span>{tierData.limitUsageStr}%</span>
                          </div>
                        </div>
                      </div>
                    )}
                    <div
                      className="p-2 grey fs15 hoverbg pointer"
                      onClick={() => setShowReputation(!showReputation)}
                    >
                      <span className={`ico-${showReputation ? 'minus' : 'plus'} fs10 me-2`}></span>
                      <span>{showReputation ? t('Hide reputation') : t('Show reputation')}</span>
                    </div>
                    {showReputation && (
                      <div className="px-3 mb-3 border-bottom">
                        <ReputationMeter host={selected.host} />
                      </div>
                    )}
                  </div>
                )}

                {/* Open Orders */}
                <div className="my-1 border-top">
                  <div className="text-center demi fs20 p-1">{t('Open Orders')}</div>
                  {/* MP-34: Unready-wallets warning — shown when any active
                      user order is on a wallet that isn't ready-to-tick and
                      has in-flight matches (funds could get stuck). */}
                  {hasUnreadyOrders && (
                    <div className="px-3 flex-center fs15 p-1 border-bottom text-danger">
                      {t('unready_wallets_msg')}
                    </div>
                  )}
                  {activeOrders.length === 0
                    ? <div className="flex-center fs15 pb-1 border-bottom grey">no recent activity</div>
                    : (
                      <div className="mb-1">
                        {activeOrders.map(ord => (
                          <UserOrderRow
                            key={ord.id || String(ord.stamp)}
                            order={ord}
                            bui={bui}
                            qui={qui}
                            mkt={currentMkt}
                            navigate={navigate}
                            cancelOrder={cancelOrder}
                            variant="active"
                            scrollRef={orderScrollerRef}
                          />
                        ))}
                      </div>
                    )}
                </div>

                {/* Completed Orders */}
                <div className="my-1 border-top">
                  <div className="text-center demi fs20 p-1">{t('Completed Orders')}</div>
                  <div id="completedOrderHistoryDurBttnBox" className="d-flex flex-stretch-row justify-content-between px-2 pb-2">
                    {COMPLETED_PERIODS.map(p => (
                      <button
                        key={p.key}
                        className={`completed-order-dur-bttn fs15 px-1 grey${completedPeriod === p.key ? ' selected' : ''}`}
                        onClick={() => setCompletedPeriod(p.key)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {completedPeriod !== 'hide' && completedOrders.length === 0 && (
                    <div className="flex-center fs15 pb-1 grey">no past history for this period</div>
                  )}
                  {completedPeriod !== 'hide' && completedOrders.length > 0 && (
                    <div className="mb-1">
                      {completedOrders.map(ord => (
                        <UserOrderRow
                          key={ord.id || String(ord.stamp)}
                          order={ord}
                          bui={bui}
                          qui={qui}
                          mkt={currentMkt}
                          navigate={navigate}
                          variant="completed"
                          scrollRef={orderScrollerRef}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent Matches — extracted into RecentMatchesTable so
                    its 1 Hz age ticker (MP-43/MP-49) only re-renders the
                    table, not the whole MarketsPage. Batch 8 implements
                    sorting (MP-45), 24h filter (MP-46), side colors
                    (MP-47), and symbol-suffixed headers (MP-48) inside
                    the component. */}
                <RecentMatchesTable
                  recentMatches={recentMatches}
                  bui={bui}
                  qui={qui}
                  currentMkt={currentMkt}
                  baseSymbol={baseAsset?.symbol ?? ''}
                  quoteSymbol={quoteAsset?.symbol ?? ''}
                />

              </div>
            </section>

          </div>{/* closes #mainContent */}
        </div>{/* closes h-100 w-100 */}
      </div>{/* closes flex-grow-1 position-relative */}

      {/* MP-59: Approve token form modal. Opens when `approveAssetID` is set
          (triggered by the approveBase / approveQuote buttons in MP-27 panel).
          `TokenApprovalForm` is already ported as a shared component and
          handles its own fee estimation, balance check, and submission flow. */}
      <FormOverlay show={approveAssetID !== null} onClose={() => setApproveAssetID(null)}>
        {approveAssetID !== null && selected && (
          <div className="form-panel bg-dark-2 p-3 border position-relative" style={{ maxWidth: 500 }}>
            <div className="form-closer" onClick={() => setApproveAssetID(null)}>
              <span className="ico-cross"></span>
            </div>
            <header className="fs20 mb-2">
              {t('Approve')}{' '}
              <span className="d-inline-block">
                {assets[approveAssetID]?.unitInfo.conventional.unit ?? ''}
              </span>
            </header>
            <TokenApprovalForm
              assetID={approveAssetID}
              host={selected.host}
              onSuccess={() => setApproveAssetID(null)}
            />
          </div>
        )}
      </FormOverlay>

    </div>
  )
}
