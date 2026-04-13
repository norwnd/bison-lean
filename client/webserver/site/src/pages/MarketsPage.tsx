import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useWebSocketStore } from '../stores/useWebSocketStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { ReputationMeter } from '../components/common/ReputationMeter'
import { CandleChart, CandleReporters } from '../components/charts/CandleChart'
import { Wave } from '../components/charts/Wave'
import OrderBook from '../components/OrderBook'
import {
  formatCoinValue, formatRateFullPrecision, formatFourSigFigs,
  formatRateAtomToRateStep, formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency, formatFiatConversion,
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
  let s = symbol.split('.')[0]
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
// Component
// ---------------------------------------------------------------------------

export default function MarketsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const ws = useWebSocketStore()

  // Auth store
  const user = useAuthStore(s => s.user)
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const walletMap = useAuthStore(s => s.walletMap)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const fetchUser = useAuthStore(s => s.fetchUser)

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
  const [showMarketList, setShowMarketList] = useState(false)

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
  // Trade form state
  // -------------------------------------------------------------------------
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy')
  const [rateInput, setRateInput] = useState('')
  const [qtyInput, setQtyInput] = useState('')
  const [sliderValue, setSliderValue] = useState(0)
  const rateAtomRef = useRef(0)
  const qtyAtomRef = useRef(0)
  const [submitEnabled, setSubmitEnabled] = useState(false)
  const [submitMsg, setSubmitMsg] = useState('')
  const [orderError, setOrderError] = useState('')
  const [showVerify, setShowVerify] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const verifiedOrderRef = useRef<any>(null)

  // Max estimation caches
  const maxBuyCacheRef = useRef<Record<number, MaxOrderEstimate>>({})
  const maxSellCacheRef = useRef<MaxOrderEstimate | null>(null)
  const maxReqIdRef = useRef(0)

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
  // Market subscription: subscribe/unsubscribe on market change
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selected || !isConnected) return
    // Reset state for new market
    bookRef.current = null
    setCandleData(null)
    candleCacheRef.current = {}
    maxBuyCacheRef.current = {}
    maxSellCacheRef.current = null
    setRecentMatches([])
    bumpBook()

    // Subscribe to market
    ws.request('loadmarket', {
      host: selected.host,
      base: selected.baseID,
      quote: selected.quoteID
    })

    return () => {
      ws.request('unmarket', {})
    }
  }, [selected, isConnected])

  // -------------------------------------------------------------------------
  // Load candles when market or duration changes
  // -------------------------------------------------------------------------
  const loadCandles = useCallback(() => {
    if (!selected || !isConnected || !currentXc) return
    const cache = candleCacheRef.current[candleDur]
    if (cache) {
      setCandleData(cache)
      setCandleLoading(false)
      return
    }
    reqCandleDurRef.current = candleDur
    setCandleLoading(true)
    ws.request('loadcandles', {
      host: selected.host,
      base: selected.baseID,
      quote: selected.quoteID,
      dur: candleDur
    })
  }, [selected, isConnected, currentXc, candleDur, ws])

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
  // WS route handlers
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selected) return

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

    ws.subscribe('book', handleBook)
    ws.subscribe('book_order', handleBookOrder)
    ws.subscribe('unbook_order', handleUnbookOrder)
    ws.subscribe('update_remaining', handleUpdateRemaining)
    ws.subscribe('epoch_order', handleEpochOrder)
    ws.subscribe('candles', handleCandles)
    ws.subscribe('candle_update', handleCandleUpdate)
    ws.subscribe('epoch_match_summary', handleEpochMatchSummary)

    return () => {
      ws.unsubscribe('book')
      ws.unsubscribe('book_order')
      ws.unsubscribe('unbook_order')
      ws.unsubscribe('update_remaining')
      ws.unsubscribe('epoch_order')
      ws.unsubscribe('candles')
      ws.unsubscribe('candle_update')
      ws.unsubscribe('epoch_match_summary')
    }
  }, [selected, currentXc, currentMktId, ws, bumpBook])

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
      // Invalidate max caches when balances change
      maxBuyCacheRef.current = {}
      maxSellCacheRef.current = null
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
    setShowMarketList(false)
    setRateInput('')
    setQtyInput('')
    setSliderValue(0)
    rateAtomRef.current = 0
    qtyAtomRef.current = 0
    setSubmitEnabled(false)
    setOrderError('')
  }, [setSearchParams])

  // -------------------------------------------------------------------------
  // Trade form logic
  // -------------------------------------------------------------------------
  const isSell = tradeSide === 'sell'

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
    // Invalidate buy cache when rate changes (buy depends on rate)
    if (!isSell) maxBuyCacheRef.current = {}
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
    if (!isSell) maxBuyCacheRef.current = {}
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
  }, [bui, currentMkt])

  const handleQtyBlur = useCallback(() => {
    if (!bui || !currentMkt || !qtyAtomRef.current) return
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, currentMkt.lotsize))
  }, [bui, currentMkt])

  const handleQtyStep = useCallback((direction: 1 | -1) => {
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    let current = qtyAtomRef.current || 0
    current += lotsize * direction
    if (current < lotsize) current = lotsize
    const lots = Math.floor(current / lotsize)
    qtyAtomRef.current = lots * lotsize
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, lotsize))
  }, [bui, currentMkt])

  // Slider handler
  const handleSlider = useCallback((value: number) => {
    setSliderValue(value)
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    let maxLots = 0
    if (isSell) {
      const ms = maxSellCacheRef.current
      if (ms) maxLots = ms.swap.lots
    } else {
      const mb = maxBuyCacheRef.current[rateAtomRef.current]
      if (mb) maxLots = mb.swap.lots
    }
    if (maxLots <= 0) return
    const lots = Math.max(1, Math.floor(maxLots * value))
    const adjQty = lots * lotsize
    qtyAtomRef.current = adjQty
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(adjQty, bui, lotsize))
  }, [bui, currentMkt, isSell])

  // Max estimate: buy
  const requestMaxBuy = useCallback(async () => {
    if (!selected || !currentMkt || !bui || !qui) return
    const rateAtom = rateAtomRef.current
    if (!rateAtom) return
    const cached = maxBuyCacheRef.current[rateAtom]
    if (cached) return cached

    const quoteWallet = walletMap[selected.quoteID]
    if (!quoteWallet?.running) return null

    const res = await postJSON('/api/maxbuy', {
      host: selected.host, base: selected.baseID, quote: selected.quoteID, rate: rateAtom
    })
    if (!checkResponse(res) || !res.maxBuy) return null
    maxBuyCacheRef.current[rateAtom] = res.maxBuy
    return res.maxBuy as MaxOrderEstimate
  }, [selected, currentMkt, bui, qui, walletMap])

  // Max estimate: sell
  const requestMaxSell = useCallback(async () => {
    if (!selected || !currentMkt) return
    if (maxSellCacheRef.current) return maxSellCacheRef.current

    const baseWallet = walletMap[selected.baseID]
    if (!baseWallet?.running) return null

    const res = await postJSON('/api/maxsell', {
      host: selected.host, base: selected.baseID, quote: selected.quoteID
    })
    if (!checkResponse(res) || !res.maxSell) return null
    maxSellCacheRef.current = res.maxSell
    return res.maxSell as MaxOrderEstimate
  }, [selected, currentMkt, walletMap])

  // Validate and update submit button on each render cycle when inputs change
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

      if (isSell) {
        const maxSell = await requestMaxSell()
        if (cancelled || reqId !== maxReqIdRef.current) return
        if (!maxSell || qtyAtom > maxSell.swap.value) {
          setSubmitEnabled(false)
          setSubmitMsg('Insufficient balance')
          return
        }
      } else {
        const maxBuy = await requestMaxBuy()
        if (cancelled || reqId !== maxReqIdRef.current) return
        if (!maxBuy || qtyAtom > maxBuy.swap.lots * currentMkt.lotsize) {
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
  }, [selected, currentMkt, bui, qui, isSell, rateInput, qtyInput, requestMaxBuy, requestMaxSell])

  // Fill rate from order book click
  const fillRateFromBook = useCallback((msgRate: number) => {
    if (!bui || !qui || !currentMkt) return
    const adjusted = isSell
      ? adjRateAtomsSell(msgRate, currentMkt.ratestep)
      : adjRateAtomsBuy(msgRate, currentMkt.ratestep)
    rateAtomRef.current = adjusted
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, currentMkt.ratestep, isSell))
    if (!isSell) maxBuyCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell])

  // Submit order: step 1 - validate and show confirmation
  const stepSubmit = useCallback(async () => {
    if (!selected || !currentMkt || !bui || !qui) return
    setOrderError('')
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom) {
      setOrderError('Rate is required')
      return
    }
    if (rateAtom < currentMkt.minimumRate) {
      setOrderError('Rate below market minimum')
      return
    }
    if (!qtyAtom) {
      setOrderError('Quantity is required')
      return
    }
    const baseWallet = walletMap[selected.baseID]
    const quoteWallet = walletMap[selected.quoteID]
    if (!baseWallet || !quoteWallet) {
      setOrderError('Missing wallet')
      return
    }
    verifiedOrderRef.current = {
      host: selected.host,
      isLimit: true,
      sell: isSell,
      base: selected.baseID,
      quote: selected.quoteID,
      qty: qtyAtom,
      rate: rateAtom,
      tifnow: false,
      options: {}
    }
    setShowVerify(true)
  }, [selected, currentMkt, bui, qui, walletMap, isSell])

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
    // Reset form
    qtyAtomRef.current = currentMkt?.lotsize ?? 0
    if (bui && currentMkt) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(currentMkt.lotsize, bui, currentMkt.lotsize))
    }
    setSliderValue(0)
    maxBuyCacheRef.current = {}
    maxSellCacheRef.current = null
    // Reload active orders after brief delay
    setTimeout(() => loadActiveOrders(), 1000)
  }, [currentMkt, bui, loadActiveOrders])

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
  // -------------------------------------------------------------------------
  const orderBookData = useMemo(() => {
    const book = bookRef.current
    if (!book || !bui || !qui || !currentMkt) return { buys: [] as any[], sells: [] as any[] }

    const mapSide = (orders: MiniOrder[]) => {
      const rows: { rate: number; qty: number; cumQty: number; msgRate: number }[] = []
      let cumQty = 0
      const slice = orders.slice(0, ORDER_BOOK_SIDE_MAX)
      for (const ord of slice) {
        cumQty += ord.qtyAtomic
        rows.push({ rate: ord.msgRate, qty: ord.qtyAtomic, cumQty, msgRate: ord.msgRate })
      }
      return rows
    }

    return {
      buys: mapSide(book.buys),
      sells: mapSide(book.sells).reverse()
    }
  }, [bookVersion, bui, qui, currentMkt])

  // Compute max cumulative for gradient backgrounds
  const maxCumBuy = orderBookData.buys.length > 0
    ? orderBookData.buys[orderBookData.buys.length - 1]?.cumQty ?? 1
    : 1
  const maxCumSell = orderBookData.sells.length > 0
    ? orderBookData.sells[0]?.cumQty ?? 1
    : 1

  // -------------------------------------------------------------------------
  // Computed market stats
  // -------------------------------------------------------------------------
  const spotRate = currentMkt?.spot?.rate ?? 0
  const spot24Change = currentMkt?.spot?.change24 ?? 0
  const spot24Vol = currentMkt?.spot?.vol24 ?? 0
  const midGap = midGapRate(bookRef.current)
  const displayRate = midGap || spotRate

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

  // Preview total for trade form
  const previewTotal = useMemo(() => {
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom || !qtyAtom || !bui || !qui || !currentMkt) return ''
    const total = baseToQuote(rateAtom, qtyAtom)
    return formatCoinAtomToLotSizeQuoteCurrency(total, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
  }, [rateInput, qtyInput, bui, qui, currentMkt])

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

  return (
    <div className="page-wrapper d-flex flex-column" style={{ height: '100%', overflow: 'hidden' }}>
      {/* ================================================================= */}
      {/* Market stats bar */}
      {/* ================================================================= */}
      <div className="d-flex align-items-center gap-3 px-3 py-2 border-bottom fs14" style={{ minHeight: 44, flexShrink: 0 }}>
        <button
          className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          onClick={() => setShowMarketList(!showMarketList)}
        >
          {baseSymbol && (
            <img src={logoPath(baseAsset?.symbol ?? '')} alt="" className="micro-icon" />
          )}
          <span className="fw-bold">{baseSymbol || '---'}/{quoteSymbol || '---'}</span>
        </button>
        {displayRate > 0 && bui && qui && currentMkt && (
          <span className="fw-bold">
            {formatRateFullPrecision(displayRate, bui, qui, currentMkt.ratestep)}
          </span>
        )}
        {spot24Change !== 0 && (
          <span style={{ color: spot24Change >= 0 ? '#2e9f67' : '#d10e0e' }}>
            {spot24Change >= 0 ? '+' : ''}{(spot24Change * 100).toFixed(2)}%
          </span>
        )}
        {spot24Vol > 0 && bui && (
          <span className="text-secondary">
            24h Vol: {formatCoinValue(spot24Vol, bui)} {buiConv?.unit ?? ''}
          </span>
        )}
        {selected && fiatRatesMap[selected.baseID] > 0 && displayRate > 0 && bui && qui && (
          <span className="text-secondary ms-auto">
            ${formatFiatConversion(displayRate, fiatRatesMap[selected.quoteID], qui)}
          </span>
        )}
      </div>

      {/* ================================================================= */}
      {/* Main grid */}
      {/* ================================================================= */}
      <div className="d-flex flex-grow-1" style={{ overflow: 'hidden', minHeight: 0 }}>
        {/* --------------------------------------------------------------- */}
        {/* Market list sidebar */}
        {/* --------------------------------------------------------------- */}
        {showMarketList && (
          <div className="border-end d-flex flex-column" style={{ width: 260, flexShrink: 0, overflow: 'hidden' }}>
            <div className="p-2">
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder={t('Search markets...')}
                value={marketSearch}
                onChange={e => setMarketSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex-grow-1 overflow-y-auto">
              {filteredMarkets.map(m => {
                const isSelected = selected?.host === m.host &&
                  selected?.baseID === m.baseID && selected?.quoteID === m.quoteID
                return (
                  <div
                    key={`${m.host}-${m.baseID}-${m.quoteID}`}
                    className={`d-flex align-items-center gap-2 px-2 py-1 cursor-pointer fs13${isSelected ? ' bg-primary bg-opacity-10' : ''}`}
                    style={{ borderLeft: isSelected ? '3px solid var(--bs-primary)' : '3px solid transparent' }}
                    onClick={() => selectMarket(m.host, m.baseID, m.quoteID)}
                  >
                    <img src={logoPath(m.baseSymbol)} alt="" className="micro-icon" />
                    <span className="fw-bold">{m.baseSymbol.toUpperCase()}/{m.quoteSymbol.toUpperCase()}</span>
                    {m.spot && m.spot.vol24 > 0 && (
                      <span className="text-secondary ms-auto fs12">
                        {formatFourSigFigs(m.spot.vol24 / (assets[m.baseID]?.unitInfo?.conventional?.conversionFactor ?? 1e8))}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Left column: Order book + Trade form */}
        {/* --------------------------------------------------------------- */}
        <div className="d-flex flex-column border-end" style={{ width: 320, flexShrink: 0, overflow: 'hidden' }}>
          {/* Order book */}
          <div className="flex-grow-1 overflow-y-auto d-flex flex-column" style={{ minHeight: 0 }}>
            {/* Sell side (asks) - reversed so best ask at bottom */}
            <div className="flex-grow-1 d-flex flex-column justify-content-end" style={{ minHeight: 0 }}>
              {bui && qui && currentMkt && orderBookData.sells.map((row, i) => {
                const pct = (row.cumQty / maxCumSell) * 100
                return (
                  <div
                    key={`s-${i}`}
                    className="d-flex px-2 py-0 cursor-pointer fs13 position-relative"
                    style={{ lineHeight: '20px' }}
                    onClick={() => fillRateFromBook(row.msgRate)}
                  >
                    <div
                      className="position-absolute"
                      style={{ right: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: 'rgba(209,14,14,0.08)' }}
                    />
                    <span className="position-relative" style={{ width: '40%', color: '#d10e0e' }}>
                      {formatRateAtomToRateStep(row.rate, bui, qui, currentMkt.ratestep, true)}
                    </span>
                    <span className="position-relative text-end" style={{ width: '30%' }}>
                      {formatCoinAtomToLotSizeBaseCurrency(row.qty, bui, currentMkt.lotsize)}
                    </span>
                    <span className="position-relative text-end text-secondary" style={{ width: '30%' }}>
                      {formatCoinAtomToLotSizeBaseCurrency(row.cumQty, bui, currentMkt.lotsize)}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Spread / mid-gap */}
            {bui && qui && currentMkt && displayRate > 0 && (
              <div className="d-flex align-items-center justify-content-center py-1 border-top border-bottom fs14 fw-bold">
                {formatRateFullPrecision(displayRate, bui, qui, currentMkt.ratestep)}
                <span className="ms-1 text-secondary fs12">{quiConv?.unit ?? ''}</span>
              </div>
            )}

            {/* Buy side (bids) */}
            <div style={{ minHeight: 0 }}>
              {bui && qui && currentMkt && orderBookData.buys.map((row, i) => {
                const pct = (row.cumQty / maxCumBuy) * 100
                return (
                  <div
                    key={`b-${i}`}
                    className="d-flex px-2 py-0 cursor-pointer fs13 position-relative"
                    style={{ lineHeight: '20px' }}
                    onClick={() => fillRateFromBook(row.msgRate)}
                  >
                    <div
                      className="position-absolute"
                      style={{ right: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: 'rgba(46,159,103,0.08)' }}
                    />
                    <span className="position-relative" style={{ width: '40%', color: '#2e9f67' }}>
                      {formatRateAtomToRateStep(row.rate, bui, qui, currentMkt.ratestep)}
                    </span>
                    <span className="position-relative text-end" style={{ width: '30%' }}>
                      {formatCoinAtomToLotSizeBaseCurrency(row.qty, bui, currentMkt.lotsize)}
                    </span>
                    <span className="position-relative text-end text-secondary" style={{ width: '30%' }}>
                      {formatCoinAtomToLotSizeBaseCurrency(row.cumQty, bui, currentMkt.lotsize)}
                    </span>
                  </div>
                )
              })}
            </div>

            {!bookRef.current && (
              <div className="text-center text-secondary py-4 fs13">
                {isConnected
                  ? 'Loading order book...'
                  : 'Connecting...'}
              </div>
            )}
          </div>

          {/* --------------------------------------------------------------- */}
          {/* Trade form */}
          {/* --------------------------------------------------------------- */}
          <div className="border-top p-2" style={{ flexShrink: 0 }}>
            {/* Buy/Sell tabs */}
            <div className="d-flex mb-2">
              <button
                className={`btn btn-sm flex-fill${tradeSide === 'buy' ? ' buygreen-bg text-white' : ' btn-outline-secondary'}`}
                onClick={() => { setTradeSide('buy'); setOrderError('') }}
              >
                {t('BUY')}
              </button>
              <button
                className={`btn btn-sm flex-fill ms-1${tradeSide === 'sell' ? ' sellred-bg text-white' : ' btn-outline-secondary'}`}
                onClick={() => { setTradeSide('sell'); setOrderError('') }}
              >
                {t('SELL')}
              </button>
            </div>

            {!isRegistered && currentXc && (
              <div className="text-center text-warning fs13 mb-2">
                View only - not registered on {selected?.host}
              </div>
            )}

            {isRegistered && currentMkt && bui && qui && (
              <>
                {/* Rate input */}
                <div className="mb-2">
                  <label className="fs12 text-secondary">Price ({quiConv?.unit ?? ''})</label>
                  <div className="d-flex align-items-center">
                    <input
                      type="text"
                      className="form-control form-control-sm flex-grow-1"
                      value={rateInput}
                      onChange={e => handleRateChange(e.target.value)}
                      onBlur={handleRateBlur}
                      onKeyDown={e => {
                        if (e.key === 'ArrowUp') { e.preventDefault(); handleRateStep(1) }
                        if (e.key === 'ArrowDown') { e.preventDefault(); handleRateStep(-1) }
                      }}
                      placeholder="0"
                    />
                    <div className="d-flex flex-column ms-1">
                      <button className="btn btn-sm p-0 lh-1" onClick={() => handleRateStep(1)} style={{ fontSize: 10 }}>&#9650;</button>
                      <button className="btn btn-sm p-0 lh-1" onClick={() => handleRateStep(-1)} style={{ fontSize: 10 }}>&#9660;</button>
                    </div>
                  </div>
                </div>

                {/* Quantity input */}
                <div className="mb-2">
                  <label className="fs12 text-secondary">Amount ({buiConv?.unit ?? ''})</label>
                  <div className="d-flex align-items-center">
                    <input
                      type="text"
                      className="form-control form-control-sm flex-grow-1"
                      value={qtyInput}
                      onChange={e => handleQtyChange(e.target.value)}
                      onBlur={handleQtyBlur}
                      onKeyDown={e => {
                        if (e.key === 'ArrowUp') { e.preventDefault(); handleQtyStep(1) }
                        if (e.key === 'ArrowDown') { e.preventDefault(); handleQtyStep(-1) }
                      }}
                      placeholder="0"
                    />
                    <div className="d-flex flex-column ms-1">
                      <button className="btn btn-sm p-0 lh-1" onClick={() => handleQtyStep(1)} style={{ fontSize: 10 }}>&#9650;</button>
                      <button className="btn btn-sm p-0 lh-1" onClick={() => handleQtyStep(-1)} style={{ fontSize: 10 }}>&#9660;</button>
                    </div>
                  </div>
                </div>

                {/* Quantity slider */}
                <div className="mb-2">
                  <input
                    type="range"
                    className="form-range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={sliderValue}
                    onChange={e => handleSlider(parseFloat(e.target.value))}
                  />
                  <div className="d-flex justify-content-between fs11 text-secondary">
                    <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
                  </div>
                </div>

                {/* Preview total */}
                {previewTotal && (
                  <div className="d-flex justify-content-between fs13 mb-2">
                    <span className="text-secondary">Total</span>
                    <span>{previewTotal} {quiConv?.unit ?? ''}</span>
                  </div>
                )}

                {submitMsg && (
                  <div className="fs12 text-secondary text-center mb-1">{submitMsg}</div>
                )}
                {orderError && (
                  <div className="fs12 text-danger text-center mb-1">{orderError}</div>
                )}

                {/* Submit button */}
                <button
                  className={`btn btn-sm w-100${isSell ? ' sellred-bg' : ' buygreen-bg'} text-white`}
                  disabled={!submitEnabled}
                  onClick={stepSubmit}
                >
                  {isSell
                    ? `Sell ${baseSymbol}`
                    : `Buy ${baseSymbol}`}
                </button>
              </>
            )}
          </div>
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Center + right: Chart, orders, matches */}
        {/* --------------------------------------------------------------- */}
        <div className="flex-grow-1 d-flex flex-column" style={{ overflow: 'hidden', minHeight: 0 }}>
          {/* --------------------------------------------------------------- */}
          {/* Chart panel */}
          {/* --------------------------------------------------------------- */}
          <div className="border-bottom position-relative" style={{ height: '45%', minHeight: 200, flexShrink: 0 }}>
            {/* Duration buttons */}
            <div className="d-flex gap-1 position-absolute" style={{ top: 4, left: 8, zIndex: 10 }}>
              {candleDurs.map(dur => (
                <button
                  key={dur}
                  className={`btn btn-sm px-2 py-0 fs12${candleDur === dur ? ' btn-primary' : ' btn-outline-secondary'}`}
                  onClick={() => setCandleDur(dur)}
                >
                  {dur}
                </button>
              ))}
            </div>

            {/* Candle legend on hover */}
            {mouseCandle && bui && qui && currentMkt && (
              <div className="d-flex gap-3 position-absolute fs12" style={{ top: 4, right: 8, zIndex: 10 }}>
                <span>O: {formatRateAtomToRateStep(mouseCandle.startRate, bui, qui, currentMkt.ratestep)}</span>
                <span>H: {formatRateAtomToRateStep(mouseCandle.highRate, bui, qui, currentMkt.ratestep)}</span>
                <span>L: {formatRateAtomToRateStep(mouseCandle.lowRate, bui, qui, currentMkt.ratestep)}</span>
                <span>C: {formatRateAtomToRateStep(mouseCandle.endRate, bui, qui, currentMkt.ratestep)}</span>
                <span>Vol: {formatCoinValue(mouseCandle.matchVolume, bui)}</span>
              </div>
            )}

            {/* Loading animation */}
            {candleLoading && (
              <Wave message="Loading chart..." backgroundColor={true} />
            )}

            {/* Chart canvas */}
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

          {/* --------------------------------------------------------------- */}
          {/* Bottom panels: Orders + Matches + Registration */}
          {/* --------------------------------------------------------------- */}
          <div className="flex-grow-1 overflow-y-auto" style={{ minHeight: 0 }}>
            {/* --------------------------------------------------------------- */}
            {/* Registration / Reputation status */}
            {/* --------------------------------------------------------------- */}
            {selected && currentXc && (
              <div className="border-bottom px-3 py-2">
                {!isRegistered
                  ? (
                    <div className="d-flex align-items-center gap-2 fs13">
                      <span className="text-warning">Not registered on {selected.host}</span>
                      <button
                        className="btn btn-sm btn-outline-primary"
                        onClick={() => navigate(`/register?host=${encodeURIComponent(selected.host)}`)}
                      >
                        Register
                      </button>
                    </div>
                  )
                  : (
                    <div>
                      <div className="d-flex align-items-center gap-3 fs13 mb-1">
                        {tierData && (
                          <>
                            <span>Tier: <strong>{tierData.tier}</strong></span>
                            <span>
                              Parcel Limit: <strong>{(tierData.parcelLimit * tierData.parcelSize).toFixed(1)}</strong>
                            </span>
                            <span>
                              Usage: <strong>
                                {tierData.parcelLimit > 0
                                  ? (tierData.usedParcels / tierData.parcelLimit * 100).toFixed(1)
                                  : '0'}%
                              </strong>
                            </span>
                          </>
                        )}
                      </div>
                      <ReputationMeter host={selected.host} />
                    </div>
                  )}
              </div>
            )}

            {/* --------------------------------------------------------------- */}
            {/* Active orders */}
            {/* --------------------------------------------------------------- */}
            <div className="border-bottom px-3 py-2">
              <div className="fs14 fw-bold mb-1">Active Orders</div>
              {activeOrders.length === 0
                ? (
                  <div className="fs13 text-secondary">No active orders</div>
                )
                : (
                  <table className="table table-sm table-hover mb-0 fs13">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Side</th>
                        <th>Rate</th>
                        <th>Qty</th>
                        <th>Filled</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeOrders.map(ord => {
                        const filledPct = ord.qty > 0
                          ? (filled(ord) / ord.qty * 100).toFixed(1)
                          : '0.0'
                        return (
                          <tr
                            key={ord.id || String(ord.stamp)}
                            className="cursor-pointer"
                            onClick={() => ord.id && navigate(orderPath(ord.id))}
                          >
                            <td>{typeString(ord)}</td>
                            <td style={{ color: ord.sell ? '#d10e0e' : '#2e9f67' }}>
                              {ord.sell
                                ? 'Sell'
                                : 'Buy'}
                            </td>
                            <td>
                              {bui && qui && currentMkt
                                ? formatRateAtomToRateStep(ord.rate, bui, qui, currentMkt.ratestep, ord.sell)
                                : ''}
                            </td>
                            <td>
                              {bui && currentMkt
                                ? formatCoinAtomToLotSizeBaseCurrency(ord.qty, bui, currentMkt.lotsize)
                                : ''}
                            </td>
                            <td>{filledPct}%</td>
                            <td>{statusString(ord)}</td>
                            <td>
                              {isCancellable(ord) && (
                                <button
                                  className="btn btn-sm btn-outline-danger py-0 px-1 fs12"
                                  onClick={e => { e.stopPropagation(); cancelOrder(ord.id) }}
                                >
                                  Cancel
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
            </div>

            {/* --------------------------------------------------------------- */}
            {/* Completed orders */}
            {/* --------------------------------------------------------------- */}
            <div className="border-bottom px-3 py-2">
              <div className="d-flex align-items-center gap-2 mb-1">
                <span className="fs14 fw-bold">Completed Orders</span>
                <div className="d-flex gap-1">
                  {COMPLETED_PERIODS.map(p => (
                    <button
                      key={p.key}
                      className={`btn btn-sm px-2 py-0 fs12${completedPeriod === p.key ? ' btn-primary' : ' btn-outline-secondary'}`}
                      onClick={() => setCompletedPeriod(p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {completedPeriod !== 'hide' && completedOrders.length === 0 && (
                <div className="fs13 text-secondary">No completed orders</div>
              )}
              {completedPeriod !== 'hide' && completedOrders.length > 0 && (
                <table className="table table-sm table-hover mb-0 fs13">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Rate</th>
                      <th>Qty</th>
                      <th>Filled</th>
                      <th>Settled</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedOrders.map(ord => {
                      const filledPct = ord.qty > 0
                        ? (filled(ord) / ord.qty * 100).toFixed(1)
                        : '0.0'
                      const settledPct = ord.qty > 0
                        ? (settled(ord) / ord.qty * 100).toFixed(1)
                        : '0.0'
                      return (
                        <tr
                          key={ord.id}
                          className="cursor-pointer"
                          onClick={() => navigate(orderPath(ord.id))}
                        >
                          <td style={{ color: ord.sell ? '#d10e0e' : '#2e9f67' }}>
                            {typeString(ord)} {ord.sell
                              ? 'Sell'
                              : 'Buy'}
                          </td>
                          <td>
                            {bui && qui && currentMkt
                              ? formatRateAtomToRateStep(ord.rate, bui, qui, currentMkt.ratestep, ord.sell)
                              : ''}
                          </td>
                          <td>
                            {bui && currentMkt
                              ? formatCoinAtomToLotSizeBaseCurrency(ord.qty, bui, currentMkt.lotsize)
                              : ''}
                          </td>
                          <td>{filledPct}%</td>
                          <td>{settledPct}%</td>
                          <td title={new Date(ord.submitTime).toLocaleString()}>
                            {ageSince(ord.submitTime)} ago
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* --------------------------------------------------------------- */}
            {/* Recent matches */}
            {/* --------------------------------------------------------------- */}
            <div className="px-3 py-2">
              <div className="fs14 fw-bold mb-1">Recent Matches</div>
              {recentMatches.length === 0
                ? (
                  <div className="fs13 text-secondary">No recent matches</div>
                )
                : (
                  <table className="table table-sm mb-0 fs13">
                    <thead>
                      <tr>
                        <th>Price</th>
                        <th>Size</th>
                        <th>Side</th>
                        <th>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentMatches.slice(0, 20).map((m, i) => (
                        <tr key={`${m.stamp}-${i}`}>
                          <td style={{ color: m.sell ? '#d10e0e' : '#2e9f67' }}>
                            {bui && qui && currentMkt
                              ? formatRateAtomToRateStep(m.rate, bui, qui, currentMkt.ratestep, m.sell)
                              : ''}
                          </td>
                          <td>
                            {bui && currentMkt
                              ? formatCoinAtomToLotSizeBaseCurrency(m.qty, bui, currentMkt.lotsize)
                              : ''}
                          </td>
                          <td style={{ color: m.sell ? '#d10e0e' : '#2e9f67' }}>
                            {m.sell
                              ? 'Sell'
                              : 'Buy'}
                          </td>
                          <td className="text-secondary">{ageSince(m.stamp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* Order verification modal */}
      {/* ================================================================= */}
      <FormOverlay show={showVerify} onClose={() => setShowVerify(false)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380, maxWidth: 460 }}>
          <div className="fs18 mb-3">Confirm Order</div>

          {verifiedOrderRef.current && bui && qui && currentMkt && (
            <div className="fs14">
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Side</span>
                <span
                  className="fw-bold"
                  style={{ color: verifiedOrderRef.current.sell ? '#d10e0e' : '#2e9f67' }}
                >
                  {verifiedOrderRef.current.sell
                    ? 'Sell'
                    : 'Buy'}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Type</span>
                <span>Limit Order</span>
              </div>
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Host</span>
                <span>{verifiedOrderRef.current.host}</span>
              </div>
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Rate</span>
                <span>
                  {formatRateAtomToRateStep(
                    verifiedOrderRef.current.rate, bui, qui, currentMkt.ratestep, verifiedOrderRef.current.sell
                  )} {quiConv?.unit ?? ''}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Quantity</span>
                <span>
                  {formatCoinAtomToLotSizeBaseCurrency(
                    verifiedOrderRef.current.qty, bui, currentMkt.lotsize
                  )} {buiConv?.unit ?? ''}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-1">
                <span className="text-secondary">Total</span>
                <span>
                  {formatCoinAtomToLotSizeQuoteCurrency(
                    baseToQuote(verifiedOrderRef.current.rate, verifiedOrderRef.current.qty),
                    bui, qui, currentMkt.lotsize, currentMkt.ratestep
                  )} {quiConv?.unit ?? ''}
                </span>
              </div>
              {fiatRatesMap[selected!.quoteID] > 0 && (
                <div className="d-flex justify-content-between mb-1">
                  <span className="text-secondary">Fiat Value</span>
                  <span>
                    ~${formatFiatConversion(
                      baseToQuote(verifiedOrderRef.current.rate, verifiedOrderRef.current.qty),
                      fiatRatesMap[selected!.quoteID], qui
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          {orderError && (
            <div className="text-danger fs13 mt-2">{orderError}</div>
          )}

          <div className="d-flex gap-2 mt-3">
            <button
              className={`btn btn-sm flex-fill text-white${verifiedOrderRef.current?.sell ? ' sellred-bg' : ' buygreen-bg'}`}
              disabled={submitting}
              onClick={submitVerifiedOrder}
            >
              {submitting
                ? <span className="spinner-border spinner-border-sm" />
                : `Submit ${verifiedOrderRef.current?.sell ? 'Sell' : 'Buy'} Order`}
            </button>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowVerify(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </FormOverlay>
    </div>
  )
}
