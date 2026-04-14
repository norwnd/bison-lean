import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { leftMarketDockLK, fetchLocal, storeLocal } from '../services/state'
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
  formatRateAtomToRateStep, formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency,
  formatFourSigFigs,
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
  ConnEventNote, BondNote, WalletStateNote, RemainderUpdate
} from '../stores/types'
import {
  OrderTypeLimit, StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled, StatusRevoked, ImmediateTiF, ConnectionStatus
} from '../stores/types'

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

const COMPLETED_PERIODS: { key: string; label: string; ms: number }[] = [
  { key: 'hide', label: 'Hide', ms: 0 },
  { key: '1d', label: '1 Day', ms: 86400000 },
  { key: '1w', label: '1 Week', ms: 604800000 },
  { key: '1m', label: '1 Month', ms: 2592000000 },
  { key: '3m', label: '3 Months', ms: 7776000000 }
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

function typeString (ord: Order): string {
  if (ord.type === OrderTypeLimit) {
    return ord.tif === ImmediateTiF
      ? 'Limit (IOC)'
      : 'Limit'
  }
  return 'Market'
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
}

function UserOrderRow ({ order, bui, qui, mkt, navigate, cancelOrder }: UserOrderRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isBuy = !order.sell
  const filledPct = order.qty > 0 ? (filled(order) / order.qty * 100).toFixed(1) : '0.0'
  const settledPct = order.qty > 0 ? (settled(order) / order.qty * 100).toFixed(1) : '0.0'

  return (
    <div className="user-order border-top border-bottom">
      <div className="user-order-header pointer" onClick={() => setExpanded(!expanded)}>
        <div className={`side-indicator ${isBuy ? 'buy' : 'sell'}`}></div>
        <span className="fs16" style={{ color: isBuy ? 'var(--buy-color)' : 'var(--sell-color)' }}>
          {isBuy ? 'Buy' : 'Sell'}
        </span>
        <span className="ms-1 fs16">
          {bui && mkt ? formatCoinAtomToLotSizeBaseCurrency(order.qty, bui, mkt.lotsize) : ''}
        </span>
        <span className="ms-1 grey fs16">{mkt?.basesymbol?.toUpperCase() ?? ''}</span>
        <span className="ms-1 fs16">
          {bui && qui && mkt ? formatRateAtomToRateStep(order.rate, bui, qui, mkt.ratestep, order.sell) : ''}
        </span>
        <span className="flex-grow-1 d-flex align-items-center justify-content-end">
          <span className="fs16">{statusString(order)}</span>
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
            <span>{typeString(order)}</span>
          </div>
          <div className="user-order-datum fs15">
            <span>Side</span>
            <span>{isBuy ? 'Buy' : 'Sell'}</span>
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
            <span>{bui && qui && mkt ? formatRateAtomToRateStep(order.rate, bui, qui, mkt.ratestep, order.sell) : ''}</span>
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
  bookRateAtom: number
  bookRateVersion: number
  onOrderSubmitted: () => void
}

function OrderForm ({ side, selected, currentMkt, bui, qui, walletMap, baseSymbol, bookRateAtom, bookRateVersion, onOrderSubmitted }: OrderFormProps) {
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

  // Max estimation cache. Buy: keyed by rateAtom. Sell: keyed by 0.
  const maxCacheRef = useRef<Record<number, MaxOrderEstimate>>({})
  const maxReqIdRef = useRef(0)

  // Refs to the price/quantity input boxes so we can flash a red outline on
  // invalid submission. Matches the vanilla highlightOutlineRed animation.
  const priceBoxRef = useRef<HTMLDivElement | null>(null)
  const qtyBoxRef = useRef<HTMLDivElement | null>(null)
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
    if (isSell) {
      const cached = maxCacheRef.current[0]
      if (cached) return cached
      const baseWallet = walletMap[selected.baseID]
      if (!baseWallet?.running) return null
      const res = await postJSON('/api/maxsell', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID
      })
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
    if (!bui || !qui || !currentMkt || !rateAtomRef.current) return
    setRateInput(formatRateAtomToRateStep(rateAtomRef.current, bui, qui, currentMkt.ratestep, isSell))
  }, [bui, qui, currentMkt, isSell])

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
    if (!bui || !currentMkt || !qtyAtomRef.current) return
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, currentMkt.lotsize))
    syncSlider()
  }, [bui, currentMkt, syncSlider])

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
          {/* Price input */}
          <div ref={priceBoxRef} className="d-flex flex-stretch-row align-items-center order-form-input select m-1">
            <label className="form-label grey fs18 px-2">Price</label>
            <input
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
          {/* Quantity input */}
          <div ref={qtyBoxRef} className="d-flex flex-stretch-row align-items-center order-form-input select m-1">
            <label className="form-label grey fs18 px-2">Quantity</label>
            <input
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
          {submitMsg && <div className="m-1 fs14 text-center grey">{submitMsg}</div>}
          <button
            type="button"
            className={`flex-center border pointer hoverbg border-rounded3 m-1 submit fs18 text-center ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
            disabled={!submitEnabled}
            onClick={stepSubmit}
          >
            {isSell ? t('Sell') : t('Buy')} {baseSymbol}
          </button>
          {orderError && <div className="m-1 fs17 text-center text-danger text-break">{orderError}</div>}
        </form>
      </section>

      {/* Order verification modal */}
      <FormOverlay show={showVerify} onClose={() => setShowVerify(false)}>
        <form id="verifyForm" className="position-relative" autoComplete="off">
          <div className="form-closer" onClick={() => setShowVerify(false)}><span className="ico-cross"></span></div>
          <header className={`fs18 ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}>
            <span className="me-2">{isSell ? 'Sell' : 'Buy'}</span> <span>{baseSymbol}</span>
          </header>
          {verifiedOrderRef.current && bui && qui && currentMkt && (
            <>
              <div className="d-flex justify-content-between align-items-center fs14">
                <span className="grey">Limit Order</span>
                <span className="grey">{verifiedOrderRef.current.host}</span>
              </div>
              <div id="verifyLimit">
                <div className="d-flex align-items-center justify-content-between">
                  <span className="grey fs18 flex-grow-1 text-start">{t('Price')}</span>
                  <span className="fs18 demi">
                    {formatRateAtomToRateStep(verifiedOrderRef.current.rate, bui, qui, currentMkt.ratestep, isSell)}
                  </span>
                  <span className="grey fs18 ms-2">
                    <sup>{quiConv?.unit ?? ''}</sup>/<sub>{buiConv?.unit ?? ''}</sub>
                  </span>
                </div>
                <div className="d-flex align-items-center mt-1">
                  <span className="grey fs18 flex-grow-1 text-start">{t('You Spend')}</span>
                  <span className="fs18 demi">
                    {isSell
                      ? formatCoinAtomToLotSizeBaseCurrency(verifiedOrderRef.current.qty, bui, currentMkt.lotsize)
                      : formatCoinAtomToLotSizeQuoteCurrency(
                          baseToQuote(verifiedOrderRef.current.rate, verifiedOrderRef.current.qty),
                          bui, qui, currentMkt.lotsize, currentMkt.ratestep
                        )}
                  </span>
                  <span className="grey fs18 ms-2">{isSell ? buiConv?.unit : quiConv?.unit}</span>
                </div>
                <div className="d-flex align-items-center mt-1">
                  <span className="grey fs18 flex-grow-1 text-start">{t('You Get')}</span>
                  <span className="fs18 demi">
                    {isSell
                      ? formatCoinAtomToLotSizeQuoteCurrency(
                          baseToQuote(verifiedOrderRef.current.rate, verifiedOrderRef.current.qty),
                          bui, qui, currentMkt.lotsize, currentMkt.ratestep
                        )
                      : formatCoinAtomToLotSizeBaseCurrency(verifiedOrderRef.current.qty, bui, currentMkt.lotsize)}
                  </span>
                  <span className="grey fs18 ms-2">{isSell ? quiConv?.unit : buiConv?.unit}</span>
                </div>
              </div>
            </>
          )}
          <div className="flex-stretch-column">
            <button
              id="vSubmit" type="button"
              className={`justify-content-center fs18 go ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
              disabled={submitting}
              onClick={submitVerifiedOrder}
            >
              {submitting
                ? <div className="ico-spinner spinner"></div>
                : <><span>{isSell ? 'Sell' : 'Buy'}</span> <span>{baseSymbol}</span></>}
            </button>
          </div>
          {orderError && (
            <div className="fs17 p-3 text-center text-danger text-break">{orderError}</div>
          )}
        </form>
      </FormOverlay>
    </>
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
    const h = searchParams.get('host')
    const b = searchParams.get('baseID')
    const q = searchParams.get('quoteID')
    if (h && b && q) return { host: h, baseID: Number(b), quoteID: Number(q) }
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

  // -------------------------------------------------------------------------
  // Candle / chart state
  // -------------------------------------------------------------------------
  const [candleData, setCandleData] = useState<CandlesPayload | null>(null)
  const [candleDur, setCandleDur] = useState(CANDLE_DUR_24H)
  const [candleLoading, setCandleLoading] = useState(false)
  const [mouseCandle, setMouseCandle] = useState<Candle | null>(null)
  const candleCacheRef = useRef<Record<string, CandlesPayload>>({})
  const reqCandleDurRef = useRef(CANDLE_DUR_24H)

  // -------------------------------------------------------------------------
  // Trade form state (each OrderForm owns its own form state)
  // -------------------------------------------------------------------------
  const [showTradingTier, setShowTradingTier] = useState(false)
  const [showReputation, setShowReputation] = useState(false)
  const [bookRateAtom, setBookRateAtom] = useState(0)
  const [bookRateVersion, setBookRateVersion] = useState(0)

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

  // -------------------------------------------------------------------------
  // Default to first available market if none selected
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (selected || allMarkets.length === 0) return
    const first = allMarkets[0]
    setSelected({ host: first.host, baseID: first.baseID, quoteID: first.quoteID })
  }, [selected, allMarkets])

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
      if (reqCandleDurRef.current !== dur) return
      setCandleData({ ...cache })
    }

    const handleEpochMatchSummary = (data: BookUpdate) => {
      if (!data.payload?.matchSummaries) return
      setRecentMatches(prev => [...data.payload.matchSummaries, ...prev].slice(0, 50))
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
      loadActiveOrders()
    },
    match: (note: MatchNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      loadActiveOrders()
    },
    epoch: (note: EpochNote) => {
      if (!selected) return
      if (note.host !== selected.host || note.marketID !== currentMktId) return
      if (bookRef.current) bookRef.current.setEpoch(note.epoch)
      bumpBook()
    },
    balance: (_note: BalanceNote) => {
      // Max caches invalidated in each OrderForm via walletMap effect
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
      // Wallet state updated through auth store
    },
    conn: (note: ConnEventNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      fetchUser()
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

    const baseFiat = fiatRatesMap[selected.baseID] ?? 0
    const quoteFiat = fiatRatesMap[selected.quoteID] ?? 0
    const externalPrice = (baseFiat && quoteFiat) ? baseFiat / quoteFiat : 0

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
        if (externalPrice > 0 && firstOrder.rate > 0) {
          const priceDelta = sell
            ? ((firstOrder.rate - externalPrice) / externalPrice) * 100
            : ((externalPrice - firstOrder.rate) / externalPrice) * 100
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
  }, [bookVersion, bui, qui, currentMkt, selected, fiatRatesMap, activeOrders])

  // -------------------------------------------------------------------------
  // Computed market stats
  // -------------------------------------------------------------------------
  const spotRate = currentMkt?.spot?.rate ?? 0
  const midGap = midGapRate(bookRef.current)
  const displayRate = midGap || spotRate
  const spot = currentMkt?.spot
  const change24 = spot?.change24 ?? 0
  const vol24 = spot?.vol24 ?? 0
  const high24 = spot?.high24 ?? 0
  const low24 = spot?.low24 ?? 0
  // Fiat-based "external" price for the base asset (if available)
  const baseFiatRate = selected ? (fiatRatesMap[selected.baseID] ?? 0) : 0

  // -------------------------------------------------------------------------
  // Trading tier / reputation data
  // -------------------------------------------------------------------------
  const tierData = useMemo(() => {
    if (!selected || !currentXc || !currentMkt) return null
    const auth = currentXc.auth
    const tier = strongTier(auth)
    const [usedParcels, parcelLimit] = tradingLimits(exchanges, selected.host)
    return { tier, usedParcels, parcelLimit, parcelSize: currentMkt.parcelsize }
  }, [selected, currentXc, currentMkt, exchanges])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!user) {
    return <div className="p-3">Loading...</div>
  }

  const baseSymbol = baseAsset?.symbol?.toUpperCase() ?? ''
  const quoteSymbol = quoteAsset?.symbol?.toUpperCase() ?? ''
  const buiConv = bui?.conventional
  const quiConv = qui?.conventional

  // Portal target: render market stats into the header slot.
  // Use state so the portal renders after the DOM element is committed.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderSlot(document.getElementById('headerSlot'))
    return () => setHeaderSlot(null)
  }, [])

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
            {baseFiatRate > 0 && (
              <div title="Price on external markets" className="d-flex align-items-center border-bottom pe-2 fs18 text-warning">
                ${formatFourSigFigs(baseFiatRate)}
              </div>
            )}
            <div title="Bison price" className="d-flex align-items-center pe-2 fs18">
              {bui && qui && currentMkt && displayRate > 0
                ? formatRateAtomToRateStep(displayRate, bui, qui, currentMkt.ratestep)
                : '-'}
              {quiConv && <span className="grey ms-1 fs14">{quiConv.unit}</span>}
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
            <div className="d-flex justify-content-start align-items-center px-2 border-right">
              <div className="fs14">
                {spot && bui && qui && currentMkt
                  ? formatFourSigFigs(vol24)
                  : '-'}
              </div>
              <div className="fs14 grey ms-1">{quiConv?.unit ?? 'USD'}</div>
            </div>
            <div className="px-2 fs14 border-right">
              {spot && bui && qui && currentMkt
                ? formatRateAtomToRateStep(high24, bui, qui, currentMkt.ratestep)
                : '-'}
            </div>
            <div className="px-2 fs14">
              {spot && bui && qui && currentMkt
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

                {/* Spread / mid-gap */}
                <div className="d-flex align-items-center justify-content-center py-1 px-2">
                  {bui && qui && currentMkt && displayRate > 0 && (
                    <span className="text-warning fs17">
                      {formatRateFullPrecision(displayRate, bui, qui, currentMkt.ratestep)}
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
                    {candleLoading && (
                      <Wave message="Loading chart..." backgroundColor={true} />
                    )}
                    <div style={{ width: '100%', height: '100%', opacity: candleLoading ? 0 : 1 }}>
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
                  {mouseCandle && bui && qui && currentMkt && (
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
              <div className="flex-stretch-column">

                {/* Not registered notice */}
                {selected && currentXc && !isRegistered && (
                  <div>
                    <div className="p-3 flex-center fs17 grey">{t('create_account_to_trade')}</div>
                    <div className="border-top border-bottom flex-center p-2">
                      <p className="text-center fs14 p-2 m-0">{t('need_to_register_msg')}</p>
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

                {/* Reputation & Trading Tier (collapsible) */}
                {selected && currentXc && isRegistered && (
                  <div>
                    <div
                      className="p-2 grey fs15 hoverbg pointer"
                      onClick={() => setShowTradingTier(!showTradingTier)}
                    >
                      <span className={`ico-${showTradingTier ? 'minus' : 'plus'} fs10 me-2`}></span>
                      <span>{showTradingTier ? t('Hide trading tier info') : t('Show trading tier info')}</span>
                    </div>
                    {showTradingTier && tierData && (
                      <div className="d-flex flex-stretch-column fs15 mx-2 mb-2 border">
                        <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1 border-bottom">
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Parcel Size')}</span>
                            <span>{tierData.parcelSize} {t('lots')}</span>
                          </div>
                        </div>
                        <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1">
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Trading Tier')}</span>
                            <span>{tierData.tier}</span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Trading Limit')}</span>
                            <span>{tierData.parcelLimit} lots</span>
                          </div>
                          <div className="d-flex justify-content-between align-items-center">
                            <span>{t('Current Usage')}</span>
                            <span>
                              {tierData.parcelLimit > 0
                                ? (tierData.usedParcels / tierData.parcelLimit * 100).toFixed(1)
                                : '0'}%
                            </span>
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
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent Matches */}
                <div id="recentMatchesBox" className="flex-stretch-column my-1 border-top">
                  <div className="text-center demi fs20 p-1">{t('Recent Matches')}</div>
                  <table id="recentMatchesTable" className="row-border row-hover lh1 border-bottom">
                    <thead>
                      <tr className="pointer">
                        <th className="text-start text-nowrap grey">
                          <span>{quiConv?.unit ?? 'Price'}</span>
                        </th>
                        <th className="text-end text-nowrap grey">
                          <span>{buiConv?.unit ?? 'Qty'}</span>
                        </th>
                        <th className="text-end text-nowrap grey">
                          <span>Age</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentMatches.slice(0, 20).map((m, i) => (
                        <tr key={`${m.stamp}-${i}`}>
                          <td className="text-start fs17" style={{ color: m.sell ? 'var(--sell-color)' : 'var(--buy-color)' }}>
                            {bui && qui && currentMkt
                              ? formatRateAtomToRateStep(m.rate, bui, qui, currentMkt.ratestep, m.sell)
                              : ''}
                          </td>
                          <td className="text-end fs17">
                            {bui && currentMkt
                              ? formatCoinAtomToLotSizeBaseCurrency(m.qty, bui, currentMkt.lotsize)
                              : ''}
                          </td>
                          <td className="preserve-spaces text-end fs17">{ageSince(m.stamp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </div>
            </section>

          </div>{/* closes #mainContent */}
        </div>{/* closes h-100 w-100 */}
      </div>{/* closes flex-grow-1 position-relative */}

    </div>
  )
}
