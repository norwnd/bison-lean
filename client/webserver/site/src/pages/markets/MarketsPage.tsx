import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { leftMarketDockLK, lastCandleDurationLK, lastMarketLK, fetchLocal, storeLocal } from '../../services/state'
import { useAuthStore } from '../../stores/useAuthStore'
import { useWebSocketStore } from '../../stores/useWebSocketStore'
import { useNotifications } from '../../hooks/useNotifications'
import OrderBook from '../../components/OrderBook'
import { formatRateAtomToRateStep } from '../../hooks/useFormatters'
import { hasActiveMatches } from '../../components/AccountUtils'
import type {
  MiniOrder, MarketOrderBook, Order,
  OrderNote, MatchNote, SpotPriceNote, BalanceNote, EpochNote, BookUpdate,
  Candle, OrderFilter,
  ConnEventNote, BondNote, WalletStateNote, RemainderUpdate, SupportedAsset
} from '../../stores/types'
import {
  OrderTypeLimit, OrderTypeMarket, StatusEpoch, StatusBooked, StatusExecuted,
  ImmediateTiF, ConnectionStatus,
  ApprovalStatus
} from '../../stores/types'

import {
  ORDER_BOOK_SIDE_MAX, MAX_ACTIVE_ORDERS,
  CANDLE_DUR_24H, MAX_PRICE_DIVERGENCE,
  midGapRate, binOrdersByRateAndEpoch, collectMarkets,
  type OrderBookDisplayRow, type SelectedMarket
} from './helpers'

import { MarketPageProvider } from './MarketPageContext'
import { MarketStatsHeader } from './MarketStatsHeader'
import { ChartPanel } from './ChartPanel'
import { TradeForms } from './TradeForms'
import { OrderBookPanel } from './OrderBookPanel'
import { RightPanel } from './RightPanel'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MarketsPage () {
  const { t } = useTranslation()
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

  // -------------------------------------------------------------------------
  // Market selector state
  // -------------------------------------------------------------------------
  const allMarkets = useMemo(() => collectMarkets(exchanges), [exchanges])

  const [selected, setSelected] = useState<SelectedMarket | null>(() => {
    // Resolution priority mirrors vanilla `markets.ts` L572-588:
    //   1. URL params (deep link / nav with explicit market)
    //   2. `lastMarketLK` localStorage entry (last viewed market on this device)
    //   3. null -> falls through to the "default to first available market"
    //      effect below once `allMarkets` is populated by the auth store.
    // The `default to first` effect also doubles as a validator (MP-67):
    // if the resolved market doesn't actually exist in `allMarkets` (e.g.
    // user removed the DEX while a stale URL/lastMarketLK still points at
    // it), it falls back to the first market -- matching vanilla L580.
    const h = searchParams.get('host')
    const b = searchParams.get('baseID')
    const q = searchParams.get('quoteID')
    if (h && b && q) return { host: h, baseID: Number(b), quoteID: Number(q) }
    // MP-67: localStorage fallback. `lastMarketLK` is shared with the
    // services/state.ts schema. We persist `{host, baseID, quoteID}` in
    // the React format (vanilla used `{host, base, quote}` -- different
    // key names -- but this is a clean rewrite so we don't need to read
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
  const [candleData, setCandleData] = useState<import('../../stores/types').CandlesPayload | null>(null)
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
  const candleCacheRef = useRef<Record<string, import('../../stores/types').CandlesPayload>>({})
  // MP-20: bumped whenever the 5m candle cache changes so the high/low
  // fallback can reactively pick up new data. Scoped to the 5m dur because
  // that's the only cache entry the MP-20 fallback reads from -- bumping on
  // other durs would cost a re-render per candle_update for no benefit.
  const [candleCacheVersion, setCandleCacheVersion] = useState(0)
  const reqCandleDurRef = useRef(candleDur)

  // -------------------------------------------------------------------------
  // Trade form state
  // -------------------------------------------------------------------------
  const [bookRateAtom, setBookRateAtom] = useState(0)
  const [bookRateVersion, setBookRateVersion] = useState(0)

  // -------------------------------------------------------------------------
  // Active orders state (stays in MarketsPage -- written by note handlers)
  // -------------------------------------------------------------------------
  const [activeOrders, setActiveOrders] = useState<Order[]>([])

  // -------------------------------------------------------------------------
  // Recent matches
  // -------------------------------------------------------------------------
  const [recentMatches, setRecentMatches] = useState<import('../../stores/types').RecentMatch[]>([])

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
  // disabled, disconnected, or has no markets configured.
  const chartErrMsg = (() => {
    if (!selected || !currentXc) return ''
    if (currentXc.disabled) {
      return 'DEX server is disabled. Visit the settings page to enable and connect to this server.'
    }
    // MP-69: vanilla collapses both `!dex.markets` and `!Connected` into
    // ID_CONNECTION_FAILED.
    const noMarkets = !currentXc.markets || Object.keys(currentXc.markets).length === 0
    if (noMarkets || !isConnected) {
      return 'Connection to dex server failed. You can close bisonw and try again later or wait for it to reconnect.'
    }
    return ''
  })()

  // -------------------------------------------------------------------------
  // Default to first available market if none selected, plus MP-67 validation
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
  // are registered BEFORE the loadmarket request is sent)
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
      if (dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== dur) return
      setCandleData({ ...cache })
    }

    const handleEpochMatchSummary = (data: BookUpdate) => {
      if (!data.payload?.matchSummaries) return
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
  // Note handlers (order, match, epoch, balance, spots, bond, walletstate)
  // -------------------------------------------------------------------------
  const noteHandlers = useMemo(() => ({
    order: (note: OrderNote) => {
      if (!selected) return
      const ord = note.order
      if (ord.host !== selected.host) return
      if (ord.baseID !== selected.baseID || ord.quoteID !== selected.quoteID) return
      // MP-66: see original MarketsPage comments for full rationale.
      loadActiveOrders()
    },
    match: (note: MatchNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      // MP-65: see original MarketsPage comments for full rationale.
      loadActiveOrders()
    },
    epoch: (note: EpochNote) => {
      if (!selected) return
      if (note.host !== selected.host || note.marketID !== currentMktId) return
      if (bookRef.current) bookRef.current.setEpoch(note.epoch)
      bumpBook()
      // MP-62: optimistically advance user order statuses when the new
      // epoch index passes their epoch.
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
      // MP-63: covered reactively in React -- see original comments.
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
      // Wallet state updated through auth store.
    },
    conn: (note: ConnEventNote) => {
      if (!selected) return
      if (note.host !== selected.host) return
      // MP-64: mirror vanilla `handleConnNote`.
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
  const candleReporters = useMemo(() => ({
    mouse: (c: Candle | null) => setMouseCandle(c)
  }), [])

  // -------------------------------------------------------------------------
  // Fiat reference rates and derived external (non-Bison) price.
  // -------------------------------------------------------------------------
  const baseFiatRate = selected ? (fiatRatesMap[selected.baseID] ?? 0) : 0
  const quoteFiatRate = selected ? (fiatRatesMap[selected.quoteID] ?? 0) : 0
  const externalPriceConv = (baseFiatRate && quoteFiatRate) ? baseFiatRate / quoteFiatRate : 0

  // -------------------------------------------------------------------------
  // Order book display data (memoized from bookRef + bookVersion)
  // -------------------------------------------------------------------------
  const orderBookData = useMemo<{ buys: OrderBookDisplayRow[]; sells: OrderBookDisplayRow[] }>(() => {
    const book = bookRef.current
    if (!book || !bui || !qui || !currentMkt || !selected) return { buys: [], sells: [] }

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
      sells: buildSide(book.sells, true)
    }
  }, [bookVersion, bui, qui, currentMkt, selected, externalPriceConv, activeOrders])

  // -------------------------------------------------------------------------
  // Computed market stats
  // -------------------------------------------------------------------------
  const spotRate = currentMkt?.spot?.rate ?? 0
  const midGap = midGapRate(bookRef.current)
  const displayRate = midGap || spotRate
  const spot = currentMkt?.spot
  const change24 = spot?.change24 ?? 0
  const vol24 = spot?.vol24 ?? 0
  // MP-20: High/low prefer spot values; when missing, fall back to iterating
  // the 5m candle cache over the last 24h.
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
  // MP-24: Bison-price color and rounding direction derived from most recent match.
  const mostRecentMatchIsBuy = useMemo<boolean | null>(() => {
    if (recentMatches.length === 0) return null
    let latest = recentMatches[0]
    for (let i = 1; i < recentMatches.length; i++) {
      if (recentMatches[i].stamp > latest.stamp) latest = recentMatches[i]
    }
    return !latest.sell
  }, [recentMatches])
  const hasBisonPrice = !!(spot && spotRate > 0 && mostRecentMatchIsBuy !== null)

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------
  const baseSymbol = baseAsset?.symbol?.toUpperCase() ?? ''
  const quoteSymbol = quoteAsset?.symbol?.toUpperCase() ?? ''
  const buiConv = bui?.conventional

  // MP-61: "why can't the user trade right now" string. Computed directly
  // from auth store data (the full memos for each sub-condition now live
  // inside RightPanel; here we only need the boolean cascade for the
  // cannot-trade overlay on TradeForms).
  const cantTradeReason = useMemo<string | null>(() => {
    if (!selected || !currentMkt || !currentXc || !baseAsset || !quoteAsset || !bui || !qui) return null

    // 1. Asset version mismatch (loaderMsgText equivalent)
    const baseXcAsset = currentXc.assets[selected.baseID]
    const quoteXcAsset = currentXc.assets[selected.quoteID]
    if (baseXcAsset && quoteXcAsset) {
      const versions = (a: SupportedAsset): number[] =>
        (a.token ? a.token.supportedAssetVersions : a.info?.versions) ?? []
      if (!versions(baseAsset).includes(baseXcAsset.version)) {
        return t('VERSION_NOT_SUPPORTED', {
          asset: bui.conventional.unit,
          version: String(baseXcAsset.version)
        })
      }
      if (!versions(quoteAsset).includes(quoteXcAsset.version)) {
        return t('VERSION_NOT_SUPPORTED', {
          asset: bui.conventional.unit,
          version: String(quoteXcAsset.version)
        })
      }
    }

    // 2. Registration / bond status (statusPanel equivalent)
    if (currentXc.connectionStatus === ConnectionStatus.Connected) {
      const auth = currentXc.auth
      if (auth && (auth.effectiveTier ?? 0) < 1) {
        return t('create_account_to_trade')
      }
    }

    // 3. Missing / disabled wallet (noWalletMsg equivalent)
    const bw = baseAsset.wallet
    const qw = quoteAsset.wallet
    if (!bw && !qw) return t('NO_WALLET_MSG', { asset1: baseSymbol, asset2: quoteSymbol })
    if (!bw) return t('CREATE_ASSET_WALLET_MSG', { asset: baseSymbol })
    if (!qw) return t('CREATE_ASSET_WALLET_MSG', { asset: quoteSymbol })
    if (bw.disabled || !bw.running) return t('ENABLE_ASSET_WALLET_MSG', { asset: baseSymbol })
    if (qw.disabled || !qw.running) return t('ENABLE_ASSET_WALLET_MSG', { asset: quoteSymbol })

    // 4. Token approval (tokenApprovalStatus equivalent)
    const checkApproval = (assetID: number, asset: SupportedAsset) => {
      if (!asset.token || !asset.wallet?.approved) return ApprovalStatus.Approved
      const xcA = currentXc.assets[assetID]
      const ver = xcA?.version
      if (ver !== undefined && asset.wallet.approved[ver] !== undefined) {
        return asset.wallet.approved[ver]
      }
      return ApprovalStatus.Approved
    }
    const bStatus = checkApproval(selected.baseID, baseAsset)
    const qStatus = checkApproval(selected.quoteID, quoteAsset)
    if (bStatus !== ApprovalStatus.Approved && qStatus === ApprovalStatus.Approved) {
      return t('approval_required_sell')
    }
    if (bStatus === ApprovalStatus.Approved && qStatus !== ApprovalStatus.Approved) {
      return t('approval_required_buy')
    }
    if (bStatus !== ApprovalStatus.Approved && qStatus !== ApprovalStatus.Approved) {
      return t('approval_required_both')
    }

    return null
  }, [selected, currentMkt, currentXc, baseAsset, quoteAsset, bui, qui, baseSymbol, quoteSymbol, t])

  // Portal target: render market stats into the header slot.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderSlot(document.getElementById('headerSlot'))
    return () => setHeaderSlot(null)
  }, [])

  // MP-22: Browser tab title reflects mid-gap price and base/quote symbols.
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

  // Null guard: don't render sub-components until the context values are
  // resolved. The MarketPageProvider requires all four to be non-null.
  const ctxReady = selected && currentMkt && bui && qui

  return (
    <div data-handler="markets" className="main m-0 flex-nowrap">

      {/* ================================================================= */}
      {/* Market stats -- portalled into the header bar */}
      {/* ================================================================= */}
      {/* MarketStatsHeader renders in the global header bar via createPortal,
          outside the in-tree DOM. It needs its own MarketPageProvider because
          React context doesn't bridge portal boundaries. */}
      {ctxReady && headerSlot && createPortal(
        <MarketPageProvider value={{ selected, currentMkt, bui, qui }}>
          <MarketStatsHeader
            baseSymbol={baseSymbol}
            quoteSymbol={quoteSymbol}
            externalPriceConv={externalPriceConv}
            spotRate={spotRate}
            hasBisonPrice={hasBisonPrice}
            mostRecentMatchIsBuy={mostRecentMatchIsBuy}
            change24={change24}
            vol24={vol24}
            high24={high24}
            low24={low24}
            baseFiatRate={baseFiatRate}
            spot={spot}
            buiConv={buiConv}
            onToggleMarketList={() => setShowMarketList(prev => !prev)}
          />
        </MarketPageProvider>,
        headerSlot
      )}

      <div className="flex-grow-1 position-relative">
        <div className="h-100 w-100 overflow-x-hidden flex-stretch-column">
          {/* In-tree provider for all sub-components (OrderBookPanel,
              ChartPanel, TradeForms, RightPanel). */}
          {ctxReady && (
            <MarketPageProvider value={{ selected, currentMkt, bui, qui }}>
              <div id="mainContent" className="d-flex flex-grow-1 flex-stretch-row">

                {/* LEFTMOST SECTION: Market list + Order book */}
                <OrderBookPanel
                  showMarketList={showMarketList}
                  setShowMarketList={(v: boolean) => setShowMarketList(v)}
                  allMarkets={allMarkets}
                  exchanges={exchanges}
                  selected={selected}
                  selectMarket={selectMarket}
                  orderBookData={orderBookData}
                  displayRate={displayRate}
                  externalPriceConv={externalPriceConv}
                  fillRateFromBook={fillRateFromBook}
                  isConnected={isConnected}
                  hasBook={!!bookRef.current}
                />

                {/* MIDDLE SECTION: Chart + Buy/Sell forms */}
                <section className="d-flex flex-stretch-column">
                  <ChartPanel
                    candleData={candleData}
                    candleDurs={candleDurs}
                    candleDur={candleDur}
                    setCandleDur={setCandleDur}
                    candleLoading={candleLoading}
                    chartErrMsg={chartErrMsg}
                    mouseCandle={mouseCandle}
                    currentMktId={currentMktId}
                    candleReporters={candleReporters}
                  />
                  <TradeForms
                    walletMap={walletMap}
                    baseSymbol={baseSymbol}
                    quoteSymbol={quoteSymbol}
                    baseFiatRate={baseFiatRate}
                    quoteFiatRate={quoteFiatRate}
                    bookRateAtom={bookRateAtom}
                    bookRateVersion={bookRateVersion}
                    cantTradeReason={cantTradeReason}
                    onOrderSubmitted={() => setTimeout(() => loadActiveOrders(), 1000)}
                  />
                </section>

                {/* RIGHTMOST SECTION: Orders, reputation, matches */}
                <RightPanel
                  activeOrders={activeOrders}
                  recentMatches={recentMatches}
                  cancelOrder={cancelOrder}
                  isRegistered={isRegistered}
                  midGap={midGap}
                  spotRate={spotRate}
                  externalPriceConv={externalPriceConv}
                />

              </div>
            </MarketPageProvider>
          )}
          {!ctxReady && (
            <div id="mainContent" className="d-flex flex-grow-1 flex-stretch-row" />
          )}
        </div>
      </div>

    </div>
  )
}
