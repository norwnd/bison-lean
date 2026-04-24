import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { leftMarketDockLK, lastCandleDurationLK, lastMarketLK, fetchLocal, storeLocal } from '../../services/state'
import { useAuthStore, selectUnitInfo } from '../../stores/useAuthStore'
import { useShallow } from 'zustand/react/shallow'
import { useWebSocketStore } from '../../stores/useWebSocketStore'
import { useNotifications } from '../../hooks/useNotifications'
import OrderBook from '../../components/OrderBook'
import { HISTORY_BATCH_SIZE } from '../../components/charts/CandleChart'
import { formatRateAtomToRateStep, shortSymbol } from '../../hooks/useFormatters'
import { hasActiveMatches } from '../../components/AccountUtils'
import type {
  MiniOrder, MarketOrderBook, Order,
  OrderNote, MatchNote, EpochNote, BookUpdate,
  Candle, OrderFilter,
  ConnEventNote, BondNote, RemainderUpdate, SupportedAsset
} from '../../stores/types'
import {
  OrderTypeLimit, OrderTypeMarket, StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled,
  ImmediateTiF, ConnectionStatus,
  ApprovalStatus
} from '../../stores/types'

import {
  ORDER_BOOK_SIDE_MIN, ORDER_BOOK_MID_SECTION_PX, ORDER_BOOK_ROW_HEIGHT_PX,
  MAX_ACTIVE_ORDERS,
  CANDLE_DUR_24H, MAX_PRICE_DIVERGENCE,
  midGapRate, binOrdersByRateAndEpoch, collectMarkets, deriveWarmupState,
  useLatestRef,
  type OrderBookDisplayRow, type SelectedMarket
} from './helpers'

import { MarketPageProvider } from './MarketPageContext'
import { MarketStatsHeader } from './MarketStatsHeader'
import { ChartPanel } from './ChartPanel'
import { TradeForms } from './TradeForms'
import { OrderBookPanel } from './OrderBookPanel'
import { RightPanel } from './RightPanel'
import { tradePairWalletMsg } from '../../hooks/useWalletMsg'

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

// CL-MP-FLASH-INVESTIGATE Fix 2: structural equality on the numeric fields
// of a `Candle`. Used by `handleCandleUpdate` to skip no-op in-place
// updates from `candle_update` WS messages. The server re-emits the
// current candle for every cached duration on every epoch boundary
// (~15s) regardless of trade activity; on idle epochs the incoming
// candle is byte-identical to what we already have cached, and blindly
// calling `setCandleData({ ...cache })` on those would burn a full
// MarketsPage re-render (chart + book + forms all re-paint) every
// epoch even though nothing changed visually.
const candlesEqual = (a: Candle, b: Candle): boolean =>
  a.startStamp === b.startStamp &&
  a.endStamp === b.endStamp &&
  a.matchVolume === b.matchVolume &&
  a.quoteVolume === b.quoteVolume &&
  a.highRate === b.highRate &&
  a.lowRate === b.lowRate &&
  a.startRate === b.startRate &&
  a.endRate === b.endRate

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
  const walletMap = useAuthStore(s => s.walletMap)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const authFailed = useAuthStore(s => s.authFailed)
  // CL-MP-NARROW-SELECTOR (Fix A): the broad `exchanges` subscription used
  // to live here. It was the dominant render multiplier on MarketsPage:
  // `handleSpotPriceNote` replaces the exchanges map on every spot note
  // (one note per market per ~15s wave, ~7 markets × ~5 hosts typical),
  // and subscribing to the full map forced the entire page to re-render
  // on each one even though the user is only viewing one market. We now
  // subscribe to two narrower signals instead:
  //   1. `marketKeysSignal` — a shallow-compared sorted list of
  //      `host|marketName` identifiers. Fires only when markets are
  //      added/removed; spot updates don't touch the list. Used to
  //      trigger the "default to first market" validation effect below.
  //   2. `currentXc` — a per-host selector declared after `selected` is
  //      in scope. Fires only when the SELECTED host's entry changes
  //      identity; notes about other hosts are invisible here.
  // The remaining consumer of the full `exchanges` map — the market-list
  // dock in `OrderBookPanel` — now subscribes to it directly inside that
  // component, which keeps its re-renders contained to the leaf.
  const marketKeysSignal = useAuthStore(useShallow(s => {
    const keys: string[] = []
    for (const host of Object.keys(s.exchanges).sort()) {
      const mkts = s.exchanges[host]?.markets
      if (!mkts) continue
      for (const m of Object.keys(mkts).sort()) keys.push(`${host}|${m}`)
    }
    return keys
  }))

  // -------------------------------------------------------------------------
  // Market selector state
  // -------------------------------------------------------------------------
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
  // Tracks whether the auto-fill "seed rate" has already run for the current
  // market. The auto-fill (`fillRateFromBook` call inside `handleBook`) is
  // strictly an initial seed — mirrors vanilla `reInitOrderForms`. Without
  // this guard, every subsequent `book` WS snapshot (reconnects,
  // server-initiated re-sync) would re-seed the rate and clobber whatever
  // the user has typed into the OrderForm's price input.
  //
  // Reset is intentionally done in a separate `[selected]`-only effect
  // (below) rather than inside the main subscribe useEffect: that effect
  // also re-runs on WS reconnect (`isWsConnected` in its deps), and we
  // want a reconnect to leave the flag alone so the next book snapshot
  // doesn't re-seed the rate. Only a real market switch re-arms the seed.
  const initialRateFilledRef = useRef(false)
  useEffect(() => {
    initialRateFilledRef.current = false
  }, [selected])

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
  // Durations with an outstanding `loadcandles` request. Set by the
  // market-load prefetch and by the on-demand loadCandles fallback; cleared
  // in handleCandles when the response lands. Used to de-dupe the two
  // request paths so a duration-click during prefetch doesn't fire a
  // duplicate request — the click just flips the spinner on and waits for
  // the in-flight response.
  const candlesInFlightRef = useRef<Set<string>>(new Set())
  // Per-duration history pagination state. `inFlight` prevents concurrent
  // loadoldercandles requests for the same dur; `floorReached` latches
  // true once the server returns fewer candles than we asked for, which
  // means we've reached the start of the archive. Reset on market change.
  const candleHistoryRef = useRef<Record<string, { inFlight: boolean; floorReached: boolean }>>({})
  // MP-20: bumped whenever the 5m candle cache changes so the high/low
  // fallback can reactively pick up new data. Scoped to the 5m dur because
  // that's the only cache entry the MP-20 fallback reads from -- bumping on
  // other durs would cost a re-render per candle_update for no benefit.
  const [candleCacheVersion, setCandleCacheVersion] = useState(0)
  const reqCandleDurRef = useRef(candleDur)
  // Ref-stable access to `candleDur` for the market-setup effect, which
  // deliberately omits `candleDur` from its deps (we don't want to re-run
  // the loadmarket / handler-subscribe pipeline when only the duration
  // changes). The prefetch loop reads this to fire the selected dur first.
  const candleDurRef = useLatestRef(candleDur)

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
  // CL-MP-NARROW-SELECTOR (Fix A): per-host selector. Subscribes ONLY to
  // the selected host's entry in the exchanges map; spot notes targeting
  // OTHER hosts are invisible here (handleSpotPriceNote preserves the
  // identity of untouched host entries via `...exchanges`). Combined
  // with the `marketKeysSignal` above, MarketsPage no longer re-renders
  // on background spot notes for other DEX connections. Coalescing
  // same-host rapid-fire notes into a single render is Fix C's job.
  const currentXc = useAuthStore(s =>
    selected ? (s.exchanges[selected.host] ?? null) : null
  )
  // CL-MP-RERENDER-CASCADE (Fix B): ref-stable access to `currentXc` for
  // WS handlers and the loadCandles callback. Before this fix, having
  // `currentXc` in the deps of the market-subscribe effect and in
  // `loadCandles` caused both to re-run on every spot note targeting
  // the selected host (handleSpotPriceNote in useMarketStore.ts rebuilds
  // `exchanges[host]` identity on every tick even though only `.markets`
  // is touched). The handlers actually only need `currentXc` for a null
  // check and `.assets[id]` lookups — both ref-stable across spot notes
  // — so reading through a ref lets them see the freshest value without
  // forcing the effect to re-run. Measured impact: a 9-spot-note cluster
  // dropped from ~23 MP renders + 18ms async tail to 9 renders with no
  // tail.
  const currentXcRef = useLatestRef(currentXc)
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
  // CL-MP-RERENDER-CASCADE (Fix B): direct narrow selectors, not memos on
  // `currentXc`. `unitInfo` objects are ref-stable across spot notes and
  // balance notes (neither handler touches `.assets[id].unitInfo`), so
  // returning the same ref from the selector lets Zustand's default
  // `Object.is` equality short-circuit — no MarketsPage re-render for
  // these specifically. The old `useMemo(..., [currentXc])` deps churned
  // every spot note because `currentXc` identity changed.
  const bui = useAuthStore(s =>
    selected ? selectUnitInfo(s, selected.host, selected.baseID) : null
  )
  const qui = useAuthStore(s =>
    selected ? selectUnitInfo(s, selected.host, selected.quoteID) : null
  )

  const candleDurs = currentXc?.candleDurs ?? []
  const isRegistered = currentXc
    ? !currentXc.viewOnly && currentXc.acctID !== ''
    : false
  const isConnected = currentXc?.connectionStatus === ConnectionStatus.Connected
  // UI-AUTH: derive the login-warmup triple via the shared helper so
  // RightPanel stays in lockstep. `warmupMsg` is non-empty exactly
  // when the DEX is in the warmup window (not view-only, not
  // disabled, not yet authed, not auth-failed) and picks the specific
  // sub-state label ("Connecting..." pre-WS vs "Authenticating..."
  // post-WS/pre-auth). `authFailedMsg` takes precedence -- overlays
  // and status panels render it instead of the spinner.
  const { authFailedMsg, warmupMsg } = deriveWarmupState(currentXc, authFailed, t)
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
  // CL-MP-NARROW-SELECTOR (Fix A): the old dep was `allMarkets` — a derived
  // array that churned identity on every spot note, causing this effect to
  // re-run (harmlessly) on every tick. `marketKeysSignal` narrows the
  // trigger to actual membership changes (markets added / removed). The
  // full exchanges snapshot is read non-reactively via `getState()` inside
  // the effect, so the "first market by vol24" pick is still based on
  // current data. Reuses `collectMarkets` (sorted vol24-desc) so the
  // "first market" semantics stay identical to OrderBookPanel's dock.
  useEffect(() => {
    const all = collectMarkets(useAuthStore.getState().exchanges)
    if (all.length === 0) return
    if (selected) {
      const exists = all.some(m =>
        m.host === selected.host &&
        m.baseID === selected.baseID &&
        m.quoteID === selected.quoteID
      )
      if (exists) return
    }
    const first = all[0]
    setSelected({ host: first.host, baseID: first.baseID, quoteID: first.quoteID })
  }, [selected, marketKeysSignal])

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
  // Book/order WS wiring + loadmarket subscription.
  //
  // Handlers are registered BEFORE the loadmarket request is sent so the
  // first `book` notification has somewhere to land.
  //
  // CL-MP-RERENDER-CASCADE (Fix B): `currentXc` deliberately NOT in deps.
  // Handlers read it via `currentXcRef.current` so spot-note-driven
  // identity changes don't tear down + re-subscribe WS handlers and
  // re-request `loadmarket` on every tick. Pre-fix this effect was
  // firing ~9× per spot-note cluster, amplifying 9 notes into ~23
  // MarketsPage renders (plus an 18ms async tail from the server
  // responding to the rapid-fire unmarket/loadmarket round-trips).
  // Post-fix: 1:1 renders, no tail. The sibling candle effect below
  // observes the same discipline.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selected) return

    // Reset book/match state for the new market. NOTE:
    // `initialRateFilledRef` is reset in its own `[selected]`-only effect
    // above — we don't want WS reconnect (which re-fires this effect) to
    // clobber the flag and re-seed the user's rate input.
    bookRef.current = null
    setRecentMatches([])
    bumpBook()

    const handleBook = (data: BookUpdate) => {
      const mktBook: MarketOrderBook = data.payload
      // CL-MP-RERENDER-CASCADE (Fix B): read `currentXc` through the ref
      // so the enclosing effect doesn't have to re-run on every spot
      // note. `.assets[baseID]` identity is stable across spot notes —
      // spot notes only rebuild `.markets`, never `.assets` (see
      // `handleSpotPriceNote` in useMarketStore.ts).
      const xc = currentXcRef.current
      if (!xc) return
      const baseCfg = xc.assets[selected.baseID]
      const quoteCfg = xc.assets[selected.quoteID]
      if (!baseCfg || !quoteCfg) return
      if (mktBook.base !== baseCfg.id || mktBook.quote !== quoteCfg.id || data.host !== selected.host) return

      const book = new OrderBook(mktBook, baseCfg.symbol, quoteCfg.symbol, bumpBook)
      for (const order of (mktBook.book.epoch || [])) {
        if (order.rate > 0) book.add(order)
      }
      bookRef.current = book
      setRecentMatches(mktBook.book.recentMatches ?? [])
      bumpBook()

      // Auto-fill initial rate into order forms (mirrors vanilla
      // reInitOrderForms). This is a one-shot seed — subsequent `book`
      // snapshots (reconnects, server-initiated re-syncs) must NOT re-fire
      // the auto-fill or they'd clobber whatever the user has typed into
      // the price input. The flag is reset only on market switch via its
      // dedicated `[selected]`-only effect near the ref declaration; WS
      // reconnects re-run this outer effect but leave the flag alone. An
      // empty book (no bids/asks) leaves the flag false so the next
      // non-empty snapshot can still seed.
      if (!initialRateFilledRef.current) {
        const bestBuy = book.bestBuyRateAtom()
        const bestSell = book.bestSellRateAtom()
        const initRate = (bestBuy && bestSell)
          ? Math.round((bestBuy + bestSell) / 2)
          : (bestBuy || bestSell)
        if (initRate) {
          initialRateFilledRef.current = true
          fillRateFromBook(initRate)
        }
      }
    }

    const handleBookOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const order = data.payload as MiniOrder
      if (order.rate > 0 && bookRef.current) bookRef.current.add(order)
      // MP-OO-WS: advance the corresponding user order to Booked when the
      // book confirms it (Epoch -> Booked). Never regress status.
      setActiveOrders(prev => {
        const idx = prev.findIndex(o => o.id === order.id)
        if (idx < 0) return prev
        const existing = prev[idx]
        if (existing.status >= StatusBooked) return prev
        const next = prev.slice()
        next[idx] = { ...existing, status: StatusBooked }
        return next
      })
    }

    const handleUnbookOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const id = data.payload.id
      if (bookRef.current) bookRef.current.remove(id)
      // MP-OO-WS: when a user order leaves the book, finalize its status
      // locally. `cancelling` means the cancel landed; otherwise the book
      // exit means the order was fully matched. Drop it unless there are
      // still active matches settling.
      setActiveOrders(prev => {
        const idx = prev.findIndex(o => o.id === id)
        if (idx < 0) return prev
        const existing = prev[idx]
        const newStatus = existing.cancelling ? StatusCanceled : StatusExecuted
        const merged: Order = { ...existing, status: newStatus }
        if (!hasActiveMatches(merged)) {
          return prev.filter(o => o.id !== id)
        }
        const next = prev.slice()
        next[idx] = merged
        return next
      })
    }

    const handleUpdateRemaining = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const update: RemainderUpdate = data.payload
      if (bookRef.current) bookRef.current.updateRemaining(update.id, update.qty, update.qtyAtomic)
    }

    const handleEpochOrder = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const order = data.payload as MiniOrder
      if (order.msgRate > 0 && bookRef.current) bookRef.current.add(order)
    }

    const handleEpochMatchSummary = (data: BookUpdate) => {
      // CL-MP-FLASH-INVESTIGATE Fix 1: bail on empty arrays too, not just
      // null. The server sends `epoch_match_summary` on every epoch
      // boundary (every ~15s) regardless of trade activity; on an idle
      // epoch `matchSummaries` comes through as `[]`. The old guard
      // `!data.payload?.matchSummaries` is falsy only for null/undefined
      // (an empty array is truthy), so every idle epoch was triggering
      // a no-op `setRecentMatches` with a fresh array identity and
      // forcing a MarketsPage re-render every 15s.
      if (!data.payload?.matchSummaries?.length) return
      setRecentMatches(prev => [...data.payload.matchSummaries, ...prev].slice(0, 100))
    }

    wsSubscribe('book', handleBook)
    wsSubscribe('book_order', handleBookOrder)
    wsSubscribe('unbook_order', handleUnbookOrder)
    wsSubscribe('update_remaining', handleUpdateRemaining)
    wsSubscribe('epoch_order', handleEpochOrder)
    wsSubscribe('epoch_match_summary', handleEpochMatchSummary)

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
      wsUnsubscribe('epoch_match_summary')
      wsRequest('unmarket', {})
    }
  }, [selected, isWsConnected, currentMktId, wsSubscribe, wsUnsubscribe, wsRequest, bumpBook])

  // -------------------------------------------------------------------------
  // Candle WS wiring + prefetch for every UI-exposed duration.
  //
  // Each response is routed to `handleCandles` and populates
  // `candleCacheRef`; only the currently-selected dur (gated by
  // `reqCandleDurRef`) flips the spinner off and renders. A duration-click
  // after the prefetch is pure "display intent" — it's either an instant
  // cache hit, or the spinner waits for the in-flight prefetch response.
  //
  // Sibling of the book effect above; same `currentXc`-not-in-deps
  // discipline applies. `wsLoadCandles` on the server side idempotently
  // calls `loadMarket`, so this effect doesn't depend on the sibling's
  // `loadmarket` landing first.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selected) return

    setCandleData(null)
    candleCacheRef.current = {}
    candlesInFlightRef.current = new Set()
    candleHistoryRef.current = {}
    setCandleCacheVersion(0)

    const handleCandles = (data: BookUpdate) => {
      if (data.host !== selected.host) return
      if (!data.payload?.candles) return
      const dur = data.payload.dur
      candleCacheRef.current[dur] = data.payload
      candlesInFlightRef.current.delete(dur)
      // MP-20: notify the high/low fallback only when the 5m cache changes.
      if (dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== dur) return
      setCandleData(data.payload)
      setCandleLoading(false)
    }

    const handleOlderCandles = (data: BookUpdate) => {
      if (data.host !== selected.host || data.marketID !== currentMktId) return
      const payload = data.payload as {
        dur: string
        candles: Candle[] | null
      }
      const received = payload.candles ?? []
      const state = candleHistoryRef.current[payload.dur] ?? { inFlight: false, floorReached: false }
      state.inFlight = false
      // Short response means we hit the start of server-side history for
      // this duration. Latch so we stop asking for more.
      if (received.length < HISTORY_BATCH_SIZE) state.floorReached = true
      candleHistoryRef.current[payload.dur] = state
      if (received.length === 0) return
      const cache = candleCacheRef.current[payload.dur]
      if (!cache) return
      // Defensive de-dupe: the server returns `end_stamp < before`, so in
      // normal operation every incoming candle is strictly older than the
      // oldest cached candle. Guard anyway in case a retry crosses wires.
      const oldest = cache.candles[0]
      const older = oldest
        ? received.filter(c => c.endStamp < oldest.endStamp)
        : received
      // Nothing new after de-dupe means the server is returning overlap
      // (e.g. a stock server that ignores `before` and re-sends the newest
      // cache). Latch so we stop asking; otherwise the chart would keep
      // triggering loads that can never advance the cache edge.
      if (older.length === 0) {
        state.floorReached = true
        candleHistoryRef.current[payload.dur] = state
        return
      }
      cache.candles = [...older, ...cache.candles]
      if (payload.dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== payload.dur) return
      setCandleData({ ...cache })
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
        if (last.startStamp === candle.startStamp) {
          // CL-MP-FLASH-INVESTIGATE Fix 2: skip no-op in-place updates.
          // On idle epochs the server re-sends the same candle fields
          // every epoch (~15s) for every cached duration; mutating the
          // cache element and bumping state here would burn a full chart
          // repaint every epoch for nothing.
          if (candlesEqual(last, candle)) return
          candles[candles.length - 1] = candle
        } else {
          candles.push(candle)
        }
      }
      // MP-20: live-update the high/low fallback when the 5m cache mutates
      if (dur === '5m') setCandleCacheVersion(v => v + 1)
      if (reqCandleDurRef.current !== dur) return
      setCandleData({ ...cache })
    }

    wsSubscribe('candles', handleCandles)
    wsSubscribe('candle_update', handleCandleUpdate)
    wsSubscribe('older_candles', handleOlderCandles)

    // Fire the prefetch in parallel. Selected dur first so its response
    // isn't queued behind the others on the WS pipeline.
    const xc = currentXcRef.current
    const durs = xc?.candleDurs ?? []
    const selectedDur = candleDurRef.current
    const ordered = (selectedDur && durs.includes(selectedDur))
      ? [selectedDur, ...durs.filter(d => d !== selectedDur)]
      : durs
    for (const dur of ordered) {
      if (candlesInFlightRef.current.has(dur)) continue
      candlesInFlightRef.current.add(dur)
      wsRequest('loadcandles', {
        host: selected.host,
        base: selected.baseID,
        quote: selected.quoteID,
        dur
      })
    }

    return () => {
      wsUnsubscribe('candles')
      wsUnsubscribe('candle_update')
      wsUnsubscribe('older_candles')
    }
  }, [selected, isWsConnected, currentMktId, wsSubscribe, wsUnsubscribe, wsRequest])

  // -------------------------------------------------------------------------
  // Load candles when market or duration changes
  // -------------------------------------------------------------------------
  const loadCandles = useCallback(() => {
    // CL-MP-RERENDER-CASCADE (Fix B): null-check `currentXc` via the ref so
    // spot-note-driven identity changes don't give this callback a new
    // identity on every tick (which would cascade into EFF-5).
    if (!selected || !currentXcRef.current) return
    // Sync the requested-duration guard on every call -- not only when we
    // issue a WS fetch. Cache-hit paths otherwise leave `reqCandleDurRef`
    // pointing at a prior request, so a late response for that prior
    // duration passes `handleCandles`' stale-check and overwrites the chart
    // while the button UI still reflects the user's latest selection.
    reqCandleDurRef.current = candleDur
    const cache = candleCacheRef.current[candleDur]
    if (cache) {
      setCandleData(cache)
      setCandleLoading(false)
      return
    }
    setCandleLoading(true)
    // The market-load prefetch usually has this request already in flight —
    // a duration-click should be a pure "display intent", not a "fetch
    // intent". Only fire on cache-and-prefetch miss (e.g. a dur that
    // wasn't in `xc.candleDurs`, or fired before the xc was populated).
    if (!candlesInFlightRef.current.has(candleDur)) {
      candlesInFlightRef.current.add(candleDur)
      wsRequest('loadcandles', {
        host: selected.host,
        base: selected.baseID,
        quote: selected.quoteID,
        dur: candleDur
      })
    }
  }, [selected, candleDur, wsRequest])

  useEffect(() => {
    loadCandles()
  }, [loadCandles])

  // -------------------------------------------------------------------------
  // Snapshot active orders from the server. Used for initial market load and
  // reconnect only -- after that, `activeOrders` is maintained by the WS
  // handlers (book_order, unbook_order, order note, match note, epoch note).
  // -------------------------------------------------------------------------
  const snapshotActiveOrders = useCallback(async () => {
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
    // Clear previous market's orders so they don't briefly render against
    // the new market's book (e.g. mis-attributed "own-order" dots).
    setActiveOrders([])
    snapshotActiveOrders()
  }, [snapshotActiveOrders])

  // -------------------------------------------------------------------------
  // Note handlers (order, match, epoch, bondpost, conn)
  //
  // `balance`, `spots`, `walletstate` (and `walletconfig`, `walletsync`,
  // `fiatrateupdate`, `createwallet`) are dispatched globally by
  // `AppLayout.tsx` to `useMarketStore`, which rebuilds the affected slices
  // of `useAuthStore` with new top-level refs (see the comment block at the
  // top of `useMarketStore.ts`). MarketsPage's `useAuthStore` selectors
  // re-fire on those setState calls, so no per-page receiver is needed for
  // any of them.
  // -------------------------------------------------------------------------
  const noteHandlers = useMemo(() => ({
    order: (note: OrderNote) => {
      if (!selected) return
      const ord = note.order
      // `TopicAsyncOrderSubmitted` fires from `/api/tradeasync` before the
      // order has a DEX-assigned id (see core.go `newOrderNoteWithTempID`).
      // We skip it -- the follow-up `TopicYoloPlaced` note carries the real
      // id and is what we merge into `activeOrders`. Without this guard we
      // would insert a duplicate "Submitting..." row that never reconciles
      // with the real-id row.
      if (!ord.id) return
      if (ord.host !== selected.host) return
      if (ord.baseID !== selected.baseID || ord.quoteID !== selected.quoteID) return
      // MP-OO-WS: merge the note into local state instead of refetching.
      // Never regress status -- a stale note arriving after an optimistic
      // book_order / epoch advance must not drag the row backward.
      setActiveOrders(prev => {
        const idx = prev.findIndex(o => o.id === ord.id)
        if (idx < 0) {
          const active = ord.status < StatusExecuted || hasActiveMatches(ord)
          if (!active) return prev
          return [ord, ...prev].slice(0, MAX_ACTIVE_ORDERS)
        }
        const existing = prev[idx]
        const merged: Order = {
          ...ord,
          // Never regress status -- a stale note must not drag a row back
          // from Booked to Epoch.
          status: Math.max(existing.status, ord.status),
          // `cancelling` is sticky-true: once we (or the server) have
          // flagged a cancel in flight, a subsequent note arriving with
          // `cancelling: false` (because the server hasn't yet committed
          // the cancel) must not clear it. The flag is cleared only via
          // the explicit rollback in `cancelOrder` or when the status
          // advances past Booked.
          cancelling: existing.cancelling || ord.cancelling
        }
        if (!(merged.status < StatusExecuted || hasActiveMatches(merged))) {
          return prev.filter(o => o.id !== ord.id)
        }
        const next = prev.slice()
        next[idx] = merged
        return next
      })
    },
    match: (note: MatchNote) => {
      if (!selected) return
      if (note.host !== selected.host || note.marketID !== currentMktId) return
      // MP-OO-WS: patch the specific match into the specific order's
      // matches[] instead of refetching. Drop the order if it is no
      // longer active after the patch.
      setActiveOrders(prev => {
        const idx = prev.findIndex(o => o.id === note.orderID)
        if (idx < 0) return prev
        const existing = prev[idx]
        const matches = existing.matches ? existing.matches.slice() : []
        const mi = matches.findIndex(m => m.matchID === note.match.matchID)
        if (mi >= 0) matches[mi] = note.match
        else matches.push(note.match)
        const merged: Order = { ...existing, matches }
        if (!(merged.status < StatusExecuted || hasActiveMatches(merged))) {
          return prev.filter(o => o.id !== note.orderID)
        }
        const next = prev.slice()
        next[idx] = merged
        return next
      })
    },
    epoch: (note: EpochNote) => {
      if (!selected) return
      if (note.host !== selected.host || note.marketID !== currentMktId) return
      if (bookRef.current) bookRef.current.setEpoch(note.epoch)
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
    bondpost: (note: BondNote) => {
      if (!selected) return
      if (note.dex !== selected.host) return
      fetchUser()
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
        snapshotActiveOrders()
      }
    }
  }), [selected, currentMktId, snapshotActiveOrders, fetchUser])

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

  // Set the rate in both OrderForm instances. Called from two places:
  //   1. `handleBook` inside the market-subscribe effect — auto-seeds the
  //      rate from the book midpoint ONCE per market. Guarded by
  //      `initialRateFilledRef` so reconnects and re-syncs don't clobber
  //      the user's typed rate.
  //   2. User clicks in `OrderBookPanel` — always fires (user intent to
  //      override the current rate). Intentionally NOT gated by any flag.
  const fillRateFromBook = useCallback((msgRate: number) => {
    setBookRateAtom(msgRate)
    setBookRateVersion(v => v + 1)
  }, [])

  // Cancel order. Flip `cancelling: true` locally BEFORE the POST so
  // `handleUnbookOrder` sees the flag even in the micro-race where the
  // DEX dispatches `unbook_order` before the HTTP response returns.
  // On POST failure, re-sync from server truth instead of blindly
  // clearing `cancelling: false`. When the second cancel of the same
  // order within an epoch is rejected with "only one cancel order can
  // be submitted per order per epoch", the cancel-order from the first
  // POST is STILL pending on the server -- the row must stay
  // Canceling. Server's `Order.Cancelling` is set from the linked
  // cancel-order (core/types.go), so the snapshot reflects the correct
  // state for both "already cancelling" (stays true) and real failures
  // (cleared to false).
  const cancelOrder = useCallback(async (orderID: string) => {
    setActiveOrders(prev => prev.map(o =>
      o.id === orderID ? { ...o, cancelling: true } : o
    ))
    const res = await postJSON('/api/cancel', { orderID })
    if (!checkResponse(res)) {
      snapshotActiveOrders()
    }
  }, [snapshotActiveOrders])

  // -------------------------------------------------------------------------
  // Candle chart reporters
  // -------------------------------------------------------------------------
  const requestOlderHistory = useCallback(() => {
    if (!selected) return
    const dur = reqCandleDurRef.current
    const cache = candleCacheRef.current[dur]
    if (!cache || cache.candles.length === 0) return
    const state = candleHistoryRef.current[dur] ?? { inFlight: false, floorReached: false }
    if (state.inFlight || state.floorReached) return
    state.inFlight = true
    candleHistoryRef.current[dur] = state
    wsRequest('loadoldercandles', {
      host: selected.host,
      base: selected.baseID,
      quote: selected.quoteID,
      dur,
      before: cache.candles[0].endStamp,
      n: HISTORY_BATCH_SIZE
    })
  }, [selected, wsRequest])
  const candleReporters = useMemo(() => ({
    mouse: (c: Candle | null) => setMouseCandle(c),
    requestOlderHistory
  }), [requestOlderHistory])

  // -------------------------------------------------------------------------
  // Fiat reference rates and derived external (non-Bison) price.
  // -------------------------------------------------------------------------
  const baseFiatRate = selected ? (fiatRatesMap[selected.baseID] ?? 0) : 0
  const quoteFiatRate = selected ? (fiatRatesMap[selected.quoteID] ?? 0) : 0
  const externalPriceConv = (baseFiatRate && quoteFiatRate) ? baseFiatRate / quoteFiatRate : 0

  // -------------------------------------------------------------------------
  // Order book display data (memoized from bookRef + bookVersion)
  // -------------------------------------------------------------------------
  // Viewport-aware per-side row cap. OrderBookPanel reports its
  // `#orderBook` container element through a callback ref; we observe
  // its size and raise the cap so taller viewports show more rows.
  // Small viewports stay at ORDER_BOOK_SIDE_MIN (13) — same as before.
  const [orderBookEl, setOrderBookEl] = useState<HTMLDivElement | null>(null)
  const [orderBookSideMax, setOrderBookSideMax] = useState<number>(ORDER_BOOK_SIDE_MIN)
  useEffect(() => {
    if (!orderBookEl) return
    const recompute = () => {
      const h = orderBookEl.clientHeight
      if (h <= 0) return
      const perSide = (h - ORDER_BOOK_MID_SECTION_PX) / 2
      const count = Math.max(ORDER_BOOK_SIDE_MIN, Math.floor(perSide / ORDER_BOOK_ROW_HEIGHT_PX))
      setOrderBookSideMax(prev => (prev === count ? prev : count))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(orderBookEl)
    return () => ro.disconnect()
  }, [orderBookEl])

  const orderBookData = useMemo<{ buys: OrderBookDisplayRow[]; sells: OrderBookDisplayRow[] }>(() => {
    const book = bookRef.current
    if (!book || !bui || !qui || !currentMkt || !selected) return { buys: [], sells: [] }

    const userOrderIds = new Set(activeOrders.map(o => o.id))

    const buildSide = (orders: MiniOrder[], sell: boolean): OrderBookDisplayRow[] => {
      const bestOrder = book.bestOrder(sell)
      const heaviestOrder = book.heaviestOrder(sell, MAX_PRICE_DIVERGENCE)
      if (!bestOrder || !heaviestOrder) return []

      const allBins = binOrdersByRateAndEpoch(orders)
      const bins = allBins.slice(0, orderBookSideMax)

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
  }, [bookVersion, bui, qui, currentMkt, selected, externalPriceConv, activeOrders, orderBookSideMax])

  // -------------------------------------------------------------------------
  // Computed market stats
  // -------------------------------------------------------------------------
  const spotRate = currentMkt?.spot?.rate ?? 0
  const midGap = midGapRate(bookRef.current)
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
  const baseSymbol = baseAsset?.symbol ?? ''
  const quoteSymbol = quoteAsset?.symbol ?? ''
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
      // UI-AUTH: during the login-warmup window (WS connected but
      // Core's background authDEX goroutine hasn't flipped `authed`
      // yet), return null so the TradeForms spinner overlay handles
      // the message. Without this short-circuit, auth.effectiveTier
      // is 0 and the "Create an account" branch below would fire,
      // misleading users during normal login.
      if (!currentXc.authed && !currentXc.viewOnly) return null
      const auth = currentXc.auth
      if (auth && (auth.effectiveTier ?? 0) < 1) {
        return t('CREATE_ACCOUNT_TO_TRADE')
      }
    }

    // 3. Missing / disabled / connecting wallet (noWalletMsg equivalent).
    // See `tradePairWalletMsg` for the canonical priority cascade.
    const walletMsg = tradePairWalletMsg(t, baseAsset.wallet, quoteAsset.wallet, baseSymbol, quoteSymbol)
    if (walletMsg) return walletMsg

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
      return t('APPROVAL_REQUIRED_SELL')
    }
    if (bStatus === ApprovalStatus.Approved && qStatus !== ApprovalStatus.Approved) {
      return t('APPROVAL_REQUIRED_BUY')
    }
    if (bStatus !== ApprovalStatus.Approved && qStatus !== ApprovalStatus.Approved) {
      return t('APPROVAL_REQUIRED_BOTH')
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
    const symPair = `${shortSymbol(baseSymbol)}/${shortSymbol(quoteSymbol)}`
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
              <div id="mainContent" className="d-flex flex-grow-1">

                {/* LEFTMOST SECTION: Market list + Order book */}
                {/* CL-MP-NARROW-SELECTOR (Fix A): `allMarkets` and
                    `exchanges` are no longer passed down — OrderBookPanel
                    subscribes to the store itself. This keeps the broad
                    `exchanges` re-subscription contained to the leaf
                    component that actually needs the full map for its
                    per-row connection-status display. */}
                <OrderBookPanel
                  showMarketList={showMarketList}
                  setShowMarketList={(v: boolean) => setShowMarketList(v)}
                  selected={selected}
                  selectMarket={selectMarket}
                  orderBookData={orderBookData}
                  externalPriceConv={externalPriceConv}
                  fillRateFromBook={fillRateFromBook}
                  isConnected={isConnected}
                  hasBook={!!bookRef.current}
                  orderBookRef={setOrderBookEl}
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
                    warmupMsg={warmupMsg}
                    authFailedMsg={authFailedMsg}
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
            <div id="mainContent" className="d-flex flex-grow-1" />
          )}
        </div>
      </div>

    </div>
  )
}
