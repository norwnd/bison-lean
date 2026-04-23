import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import {
  formatCoinAtom, formatRateToRateStep,
  formatCoinAtomToLotSizeBaseCurrency, formatCoinAtomToLotSizeQuoteCurrency,
  conventionalRate, shortSymbol, logoPath
} from '../hooks/useFormatters'
import {
  filled, settled, isMarketBuy, averageRate, baseToQuote,
  isCancellable, canAccelerateOrder
} from '../components/AccountUtils'
import { explorerURL, formatCoinID } from '../components/CoinExplorers'
import { AccelerateOrderForm } from '../components/common/AccelerateOrderForm'
import { FormOverlay } from '../components/common/FormOverlay'
import type {
  Order, Match, Coin, OrderNote, MatchNote,
  UnitInfo
} from '../stores/types'
import {
  OrderTypeLimit, OrderTypeMarket, OrderTypeCancel,
  StatusEpoch, StatusBooked, StatusExecuted, StatusCanceled, StatusRevoked,
  MatchSideMaker, MatchSideTaker,
  NewlyMatched, MakerSwapCast, TakerSwapCast, MakerRedeemed, MatchComplete, MatchConfirmed,
  ImmediateTiF
} from '../stores/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// lockTimeMakerMs must match LockTimeMaker in bisonw.
const lockTimeMakerMs = 20 * 60 * 60 * 1000
// lockTimeTakerMs must match LockTimeTaker in bisonw.
const lockTimeTakerMs = 8 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageSince (ms: number): string {
  let dur = Date.now() - ms
  if (dur < 1000) return '0s'
  const units: [number, string][] = [
    [31536000000, 'y'],
    [2592000000, 'mo'],
    [86400000, 'd'],
    [3600000, 'h'],
    [60000, 'min'],
    [1000, 's']
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

// Shared "match-card timestamp" formatter. Used for both the
// per-match `matchTime` and the pending-refund `refundAfterStr`.
// Pinned to the user's preferred language list so dates render in
// their locale (e.g. "Apr 15, 2026").
function formatMatchDate (ms: number): string {
  return new Date(ms).toLocaleTimeString(navigator.languages as string[], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function statusString (order: Order, t: (k: string) => string): string {
  if (!order.id) return t('ORDER_SUBMITTING')
  const isLive = order.matches?.some(m => m.active) ?? false
  // OP-02: use named constants from `stores/types.ts` instead of
  // hardcoded numeric cases (`case 1:`, `case 4:`, `case 5:`).
  switch (order.status) {
    case StatusEpoch:
      // OP-05: an epoch order whose cancel POST has succeeded should
      // reflect "Canceling" immediately, not wait for the next WS
      // order note. `submitCancel` sets `cancelling: true` synchronously
      // after a successful `/api/cancel` response. Vanilla bypassed
      // `statusString()` entirely with `page.status.textContent =
      // intl.prep(intl.ID_CANCELING)`; React's data-driven equivalent
      // is to honor the `cancelling` flag in both cancellable status
      // cases (Epoch and Booked).
      if (order.cancelling) return t('CANCELING')
      return t('EPOCH')
    case StatusBooked:
      if (order.cancelling) return t('CANCELING')
      return isLive
        ? t('SETTLING')
        : t('BOOKED')
    case StatusExecuted:
      if (isLive) return t('SETTLING')
      if (filled(order) === 0 && order.type !== OrderTypeCancel) return t('NO_MATCH')
      return t('EXECUTED')
    case StatusCanceled:
      return isLive
        ? t('SETTLING')
        : t('CANCELED')
    case StatusRevoked:
      return isLive
        ? t('SETTLING')
        : t('REVOKED')
    default:
      return t('UNKNOWN')
  }
}

function typeString (ord: Order, t: (k: string) => string): string {
  if (ord.type === OrderTypeLimit) {
    return ord.tif === ImmediateTiF
      ? t('LIMIT_ORDER_IMMEDIATE_TIF')
      : t('LIMIT_ORDER')
  }
  return t('MARKET_ORDER')
}

function sellBuyString (ord: Order, t: (k: string) => string): string {
  return ord.sell
    ? t('SELL')
    : t('BUY')
}

// Coin resolution helpers for match display.
function makerSwapCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker
    ? m.swap
    : m.counterSwap
}

function takerSwapCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker
    ? m.counterSwap
    : m.swap
}

function makerRedeemCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker
    ? m.redeem
    : m.counterRedeem
}

function takerRedeemCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker
    ? m.counterRedeem
    : m.redeem
}

function confirmationString (coin: Coin | undefined, t: (k: string) => string): string {
  if (!coin?.confs || coin.confs.required === 0) return ''
  return `${coin.confs.count} / ${coin.confs.required} ${t('CONFIRMATIONS')}`
}

function matchStatusString (m: Match, t: (k: string, opts?: Record<string, string>) => string): string {
  const revoked = (statusKey: string) =>
    t('MATCH_STATUS_REVOKED', { status: t(statusKey) })

  if (m.revoked) {
    if (m.active) {
      if (m.redeem) return revoked('MATCH_STATUS_REDEMPTION_SENT')
      if (m.side === MatchSideMaker) return revoked('MATCH_STATUS_REFUND_PENDING')
      if (m.counterRedeem) return revoked('MATCH_STATUS_REDEEM_PENDING')
      return revoked('MATCH_STATUS_REFUND_PENDING')
    }
    if (m.refund) return revoked('MATCH_STATUS_REFUNDED')
    if (m.redeem) return revoked('MATCH_REDEMPTION_CONFIRMED')
    return revoked('MATCH_STATUS_COMPLETE')
  }

  switch (m.status) {
    // OP-06 drive-by (low-severity from the audit): use the named
    // `NewlyMatched` constant instead of the hardcoded `0` to match
    // the rest of the switch's named cases.
    case NewlyMatched: return t('MATCH_STATUS_NEWLY_MATCHED')
    case MakerSwapCast: return t('MATCH_STATUS_MAKER_SWAP_CAST')
    case TakerSwapCast: return t('MATCH_STATUS_TAKER_SWAP_CAST')
    case MakerRedeemed:
      return m.side === MatchSideMaker
        ? t('MATCH_STATUS_REDEMPTION_SENT')
        : t('MATCH_STATUS_MAKER_REDEEMED')
    case MatchComplete: return t('MATCH_STATUS_REDEMPTION_SENT')
    case MatchConfirmed: return t('MATCH_REDEMPTION_CONFIRMED')
    default: return t('UNKNOWN')
  }
}

// ---------------------------------------------------------------------------
// TimeAgo
// ---------------------------------------------------------------------------

// Self-ticking "X ago" span. Kept as its own component so the tick
// interval only re-renders the tiny timestamp text instead of the
// whole OrderPage every 10 seconds.
function TimeAgo ({ ms }: { ms: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick(n => n + 1), 10000)
    return () => clearInterval(interval)
  }, [])
  return <>{ageSince(ms)}</>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OrderPage () {
  const { t } = useTranslation()
  const { oid } = useParams<{ oid: string }>()

  const assets = useAuthStore(s => s.assets)
  const walletMap = useAuthStore(s => s.walletMap)
  const user = useAuthStore(s => s.user)
  const net = user?.net ?? 0

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelError, setCancelError] = useState('')
  const [showAccelerate, setShowAccelerate] = useState(false)

  // Narrow store subscriptions to just the per-order fields we need for
  // formatting. Subscribing to the whole `exchanges` object would cause
  // re-renders on every spot-price WS update (handleSpotPriceNote replaces
  // the exchanges object immutably). These selectors return stable values
  // across spot updates: xc.assets is preserved by the spread, and
  // lotsize/ratestep are primitives that don't change.
  const xcAssets = useAuthStore(s => order ? s.exchanges[order.host]?.assets : undefined)
  const lotsize = useAuthStore(s => order ? s.exchanges[order.host]?.markets?.[order.market]?.lotsize : undefined)
  const ratestep = useAuthStore(s => order ? s.exchanges[order.host]?.markets?.[order.market]?.ratestep : undefined)

  // Try to find the order among active orders in exchanges. Uses
  // getState() so this callback's identity doesn't change on every
  // exchanges update, which would re-trigger the initial-load effect
  // and flash the loading spinner.
  const findActiveOrder = useCallback((): Order | undefined => {
    const { exchanges } = useAuthStore.getState()
    for (const xc of Object.values(exchanges)) {
      for (const mkt of Object.values(xc.markets)) {
        for (const o of (mkt.orders ?? [])) {
          if (o.id === oid) return o
        }
        for (const o of (mkt.inflight ?? [])) {
          if (o.id === oid) return o
        }
      }
    }
    return undefined
  }, [oid])

  // Fetch order from API.
  const fetchOrder = useCallback(async (): Promise<Order | null> => {
    const res = await postJSON('/api/order', oid)
    if (!checkResponse(res)) return null
    return res.order ?? null
  }, [oid])

  // Initial load.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const active = findActiveOrder()
      if (active) {
        setOrder(active)
        setLoading(false)
        return
      }
      const fetched = await fetchOrder()
      if (!cancelled) {
        setOrder(fetched)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [findActiveOrder, fetchOrder])

  // WebSocket note handlers.
  const noteHandlers = useMemo(() => ({
    order: (note: unknown) => {
      const orderNote = note as OrderNote
      if (orderNote.order.id !== oid) return
      setOrder(orderNote.order)
    },
    match: (note: unknown) => {
      const matchNote = note as MatchNote
      if (matchNote.orderID !== oid) return
      setOrder(prev => {
        if (!prev) return prev
        const matches = [...(prev.matches ?? [])]
        const idx = matches.findIndex(m => m.matchID === matchNote.match.matchID)
        if (idx >= 0) {
          matches[idx] = matchNote.match
        } else {
          matches.push(matchNote.match)
        }
        return { ...prev, matches }
      })
    },
  }), [oid])

  useNotifications(noteHandlers)

  // Cancel order.
  const submitCancel = useCallback(async () => {
    setCancelError('')
    const res = await postJSON('/api/cancel', { orderID: oid })
    if (!checkResponse(res)) {
      setCancelError(res.msg)
      return
    }
    setOrder(prev =>
      prev
        ? { ...prev, cancelling: true }
        : prev
    )
  }, [oid])

  // Accelerate success handler.
  // OP-08: refresh the order data immediately rather than waiting for
  // the next WS note. Vanilla relied on its global note dispatcher to
  // update the order via `handleOrderNote()`, but if the user closed
  // the form before the next note arrived they'd see stale match
  // confs. The refetch closes that gap with a single round trip and
  // keeps the Accelerate button visibility in sync with the new
  // (likely now-confirmed) swap state.
  const handleAccelerateSuccess = useCallback(async () => {
    setShowAccelerate(false)
    const fresh = await fetchOrder()
    if (fresh) setOrder(fresh)
  }, [fetchOrder])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="order-page loading-box">
        <span className="ico-spinner spinner" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="order-page not-found-box">
        <div className="text-danger">{t('ORDER_NOT_FOUND')}</div>
      </div>
    )
  }

  const allAssets: Record<number, { unitInfo: UnitInfo }> = { ...assets, ...(xcAssets ?? {}) }
  const baseUnitInfo: UnitInfo | undefined = allAssets[order.baseID]?.unitInfo
  const quoteUnitInfo: UnitInfo | undefined = allAssets[order.quoteID]?.unitInfo
  const bUnit = baseUnitInfo?.conventional.unit ?? ''
  const qUnit = quoteUnitInfo?.conventional.unit ?? ''
  // lotsize/ratestep are used to format rates/qtys at market precision.
  // For historical orders whose exchange/market is no longer configured,
  // the helpers fall back to `formatCoinValueAtom`.
  const fmtBase = (atoms: number): string => {
    if (!baseUnitInfo) return '-'
    if (lotsize != null) return formatCoinAtomToLotSizeBaseCurrency(atoms, baseUnitInfo, lotsize)
    return formatCoinAtom(atoms, baseUnitInfo)
  }
  const fmtQuote = (atoms: number): string => {
    if (!quoteUnitInfo) return '-'
    if (baseUnitInfo && lotsize != null && ratestep != null) return formatCoinAtomToLotSizeQuoteCurrency(atoms, baseUnitInfo, quoteUnitInfo, lotsize, ratestep)
    return formatCoinAtom(atoms, quoteUnitInfo)
  }
  const fmtRate = (rateConv: number): string =>
    baseUnitInfo && quoteUnitInfo && ratestep != null
      ? formatRateToRateStep(rateConv, baseUnitInfo, quoteUnitInfo, ratestep)
      : '-'

  const canCancel = isCancellable(order)
  // OP-01: full vanilla parity for the Accelerate button. Previously
  // used `hasActiveMatches()` which only checked whether ANY match
  // was still active -- it returned true even for matches well past
  // the swap step and for orders whose "from" wallet didn't support
  // acceleration. `canAccelerateOrder` (in `AccountUtils.ts`) checks
  // wallet trait + has-unconfirmed-swap, mirroring vanilla `app.ts`
  // `canAccelerateOrder()` (L1517-1532).
  const canAccelerate = canAccelerateOrder(order, walletMap)

  const filledPct = order.qty > 0
    ? (filled(order) / order.qty * 100).toFixed(1)
    : '0.0'
  const settledPct = order.qty > 0
    ? (settled(order) / order.qty * 100).toFixed(1)
    : '0.0'

  const typeStr = `${typeString(order, t)} ${sellBuyString(order, t)}`

  let rateStr: string
  let rateUnit: string | null = null
  const rateUnitLabel = `${shortSymbol(bUnit)}/${shortSymbol(qUnit)}`
  if (order.type === OrderTypeMarket) {
    if (!order.matches?.length) {
      rateStr = t('MARKET_ORDER')
    } else {
      const avg = averageRate(order)
      const convRate = conventionalRate(order.baseID, order.quoteID, avg, allAssets)
      rateStr = order.matches.length > 1
        ? `~ ${fmtRate(convRate)}`
        : fmtRate(convRate)
      rateUnit = rateUnitLabel
    }
  } else {
    rateStr = fmtRate(conventionalRate(order.baseID, order.quoteID, order.rate, allAssets))
    rateUnit = rateUnitLabel
  }

  const sortedMatches = [...(order.matches ?? [])].sort((a, b) => a.stamp - b.stamp)

  // ---------------------------------------------------------------------------
  // Match card rendering
  // ---------------------------------------------------------------------------

  const renderCoinLink = (coin: Coin | undefined, pendingText: string) => {
    if (!coin) {
      return <span className="pending-placeholder">{pendingText}</span>
    }
    const parts = formatCoinID(coin.stringID)
    const href = explorerURL(coin.assetID, coin.stringID, net)
    const inner = parts.map((p, i) => (
      <span key={i}>
        {p}
        {i < parts.length - 1 && <br />}
      </span>
    ))
    return href
      ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="match-coin-link">
          {inner}
        </a>
      )
      : (
        <span className="match-coin-link">
          {inner}
        </span>
      )
  }

  const renderConfirmationMsg = (m: Match): string | null => {
    if (m.status === MakerSwapCast && !m.revoked && !m.refund) {
      return confirmationString(makerSwapCoin(m), t)
    }
    if (m.status === TakerSwapCast && !m.revoked && !m.refund) {
      return confirmationString(takerSwapCoin(m), t)
    }
    if (m.status < MatchConfirmed && m.side === MatchSideMaker && m.status >= MakerRedeemed && !m.revoked && !m.refund) {
      return confirmationString(m.redeem, t)
    }
    if (m.status < MatchConfirmed && m.side === MatchSideTaker && m.status >= MatchComplete && !m.revoked && !m.refund) {
      return confirmationString(m.redeem, t)
    }
    if (m.status < MatchConfirmed && m.refund && m.refund.confs.count <= m.refund.confs.required) {
      return confirmationString(m.refund, t)
    }
    return null
  }

  const renderRefund = (m: Match) => {
    if (m.refund) {
      return renderCoinLink(m.refund, '')
    }
    // Pending refund messaging.
    const lockTime = m.side === MatchSideTaker
      ? lockTimeTakerMs
      : lockTimeMakerMs
    const refundAfter = new Date(m.stamp + lockTime)
    if (Date.now() > refundAfter.getTime()) {
      return <span className="refund-imminent">{t('REFUND_IMMINENT')}</span>
    }
    const refundAfterStr = formatMatchDate(refundAfter.getTime())
    return (
      <span className="refund-pending">
        {t('REFUND_WILL_HAPPEN_AFTER', { refundAfterTime: refundAfterStr })}
      </span>
    )
  }

  // Visibility logic for match swap/redeem/refund steps, ported from
  // setMutableMatchCardElements in the vanilla order.ts.
  const stepVisibility = (m: Match) => {
    const mSwap = makerSwapCoin(m)
    const tSwap = takerSwapCoin(m)
    const mRedeem = makerRedeemCoin(m)
    const tRedeem = takerRedeemCoin(m)

    if (!m.revoked) {
      return {
        makerSwap: Boolean(mSwap) || m.active,
        takerSwap: Boolean(tSwap) || m.active,
        makerRedeem: Boolean(mRedeem) || m.active,
        takerRedeem: Boolean(tRedeem) || m.active,
        refund: Boolean(m.refund),
      }
    }

    // Revoked path.
    const takerRefundsAfter = new Date(m.stamp + lockTimeTakerMs)
    const takerLockTimeExpired = Date.now() > takerRefundsAfter.getTime()

    let expectingRefund = Boolean(tSwap) // as taker
    if (m.side === MatchSideMaker) {
      expectingRefund = Boolean(mSwap)
      if (tSwap) {
        expectingRefund = expectingRefund && takerLockTimeExpired
      }
    }

    return {
      makerSwap: Boolean(mSwap),
      takerSwap: Boolean(tSwap),
      makerRedeem: Boolean(mRedeem) || (Boolean(tSwap) && m.active && !m.refund && !takerLockTimeExpired),
      takerRedeem: Boolean(tRedeem) || (Boolean(mRedeem) && m.active && !m.refund),
      refund: Boolean(m.refund) || (m.active && !m.redeem && !m.counterRedeem && expectingRefund),
    }
  }

  const renderMatchCard = (m: Match) => {
    if (m.isCancel) {
      // Cancel match: simplified display.
      const cancelQty = order.sell
        ? fmtBase(m.qty)
        : fmtQuote(baseToQuote(m.rate, m.qty))
      const cancelIcon = order.sell
        ? logoPath(order.baseSymbol)
        : logoPath(order.quoteSymbol)
      const portion = isMarketBuy(order)
        ? ((baseToQuote(m.rate, m.qty) / order.qty) * 100).toFixed(1)
        : ((m.qty / order.qty) * 100).toFixed(1)

      return (
        <div key={m.matchID} className="match-card">
          <div className="match-top">
            <span className="match-id">{m.matchID}</span>
          </div>
          <div className="cancel-portion">
            {t('Cancel')} - {portion}%
          </div>
          <span className="amount-with-icon">
            <span>{cancelQty}</span>
            <img src={cancelIcon} alt="" className="micro-icon" />
          </span>
        </div>
      )
    }

    const quoteAmount = baseToQuote(m.rate, m.qty)
    const vis = stepVisibility(m)
    const confMsg = renderConfirmationMsg(m)
    const convRate = conventionalRate(order.baseID, order.quoteID, m.rate, allAssets)

    const matchTime = formatMatchDate(m.stamp)

    const portion = isMarketBuy(order)
      ? ((baseToQuote(m.rate, m.qty) / order.qty) * 100).toFixed(1)
      : ((m.qty / order.qty) * 100).toFixed(1)

    // From/To display.
    let fromAmt: string
    let fromIcon: string
    let toAmt: string
    let toIcon: string
    if (order.sell) {
      fromAmt = fmtBase(m.qty)
      fromIcon = logoPath(order.baseSymbol)
      toAmt = fmtQuote(quoteAmount)
      toIcon = logoPath(order.quoteSymbol)
    } else {
      fromAmt = fmtQuote(quoteAmount)
      fromIcon = logoPath(order.quoteSymbol)
      toAmt = fmtBase(m.qty)
      toIcon = logoPath(order.baseSymbol)
    }

    // Swap/redeem asset labels per side.
    const isMakerSell = (m.side === MatchSideMaker && order.sell) ||
      (m.side === MatchSideTaker && !order.sell)
    const makerSwapAsset = isMakerSell
      ? shortSymbol(bUnit)
      : shortSymbol(qUnit)
    const takerSwapAsset = isMakerSell
      ? shortSymbol(qUnit)
      : shortSymbol(bUnit)
    const makerRedeemAsset = isMakerSell
      ? shortSymbol(qUnit)
      : shortSymbol(bUnit)
    const takerRedeemAsset = isMakerSell
      ? shortSymbol(bUnit)
      : shortSymbol(qUnit)
    const refundAsset = order.sell
      ? shortSymbol(bUnit)
      : shortSymbol(qUnit)

    const sideLabel = m.side === MatchSideMaker
      ? t('MAKER')
      : t('TAKER')
    return (
      <div key={m.matchID} className="match-card">
        <div className="match-top">
          <div>
            <div className="match-id">{m.matchID}</div>
            <div className="match-time">
              {matchTime} (<TimeAgo ms={m.stamp} /> ago)
            </div>
          </div>
          <span className="match-side-badge">{sideLabel}</span>
        </div>

        <div className="match-metrics">
          <div className="metric">
            <div className="label">{t('Status')}</div>
            <div className="value">{matchStatusString(m, t)}</div>
          </div>
          <div className="metric">
            <div className="label">{t('Rate')}</div>
            <div className="value">{fmtRate(convRate)} {shortSymbol(bUnit)}/{shortSymbol(qUnit)}</div>
          </div>
          <div className="metric">
            <div className="label">{t('Portion')}</div>
            <div className="value">{portion}%</div>
          </div>
        </div>

        <div className="flow-row">
          <div className="metric">
            <div className="label">{t('From')}</div>
            <span className="amount-with-icon value">
              <span>{fromAmt}</span>
              <img src={fromIcon} alt="" className="micro-icon" />
            </span>
          </div>
          <div className="metric">
            <div className="label">{t('To')}</div>
            <span className="amount-with-icon value">
              <span>{toAmt}</span>
              <img src={toIcon} alt="" className="micro-icon" />
            </span>
          </div>
        </div>

        {confMsg && (
          <div className="confirmation-msg">{confMsg}</div>
        )}

        <div className="match-steps">
          {vis.makerSwap && (
            <div className="match-step">
              <span className="match-step-label">
                {m.side === MatchSideMaker
                  ? t('YOUR_SWAP')
                  : t('THEIR_SWAP')}
                {' '}({makerSwapAsset}):
              </span>
              {renderCoinLink(makerSwapCoin(m), t('PENDING'))}
            </div>
          )}
          {vis.takerSwap && (
            <div className="match-step">
              <span className="match-step-label">
                {m.side === MatchSideTaker
                  ? t('YOUR_SWAP')
                  : t('THEIR_SWAP')}
                {' '}({takerSwapAsset}):
              </span>
              {renderCoinLink(takerSwapCoin(m), t('PENDING'))}
            </div>
          )}
          {vis.makerRedeem && (
            <div className="match-step">
              <span className="match-step-label">
                {m.side === MatchSideMaker
                  ? t('YOUR_REDEEM')
                  : t('THEIR_REDEEM')}
                {' '}({makerRedeemAsset}):
              </span>
              {renderCoinLink(makerRedeemCoin(m), t('PENDING'))}
            </div>
          )}
          {vis.takerRedeem && (
            <div className="match-step">
              <span className="match-step-label">
                {m.side === MatchSideTaker
                  ? t('YOUR_REDEEM')
                  : t('THEIR_REDEEM')}
                {' '}({takerRedeemAsset}):
              </span>
              {renderCoinLink(takerRedeemCoin(m), t('PENDING'))}
            </div>
          )}
          {vis.refund && (
            <div className="match-step">
              <span className="match-step-label">{t('Refund')} ({refundAsset}):</span>
              {renderRefund(m)}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

  return (
    <div className="order-page">
      <div className="order-header">
        {order.id && <div className="order-id">{order.id}</div>}
        <div className="market-host">
          {shortSymbol(bUnit)}/{shortSymbol(qUnit)} @ {order.host}
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-cell">
          <div className="label">{t('Type')}</div>
          <div className={`value ${order.sell ? 'text-danger' : 'text-success'}`}>{typeStr}</div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Status')}</div>
          <div className="value">{statusString(order, t)}</div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Rate')}</div>
          <div className="value">
            {rateStr}{rateUnit && ` ${rateUnit}`}
          </div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Quantity')}</div>
          <div className="value">{fmtBase(order.qty)} {shortSymbol(bUnit)}</div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Filled')}</div>
          <div className="value">{filledPct}%</div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Settled')}</div>
          <div className="value">{settledPct}%</div>
        </div>
        <div className="summary-cell">
          <div className="label">{t('Age')}</div>
          <div className="value" title={new Date(order.submitTime).toLocaleString()}>
            <TimeAgo ms={order.submitTime} /> ago
          </div>
        </div>
      </div>

      {(canCancel || canAccelerate) && (
        <div className="action-bar">
          {canCancel && (
            <button className="danger" onClick={submitCancel}>
              {t('CANCEL_ORDER_LABEL')}
            </button>
          )}
          {canAccelerate && (
            <button onClick={() => setShowAccelerate(true)}>
              {t('ACCELERATE_ORDER')}
            </button>
          )}
        </div>
      )}

      {cancelError && (
        <div className="cancel-error">{cancelError}</div>
      )}

      {sortedMatches.length > 0 && (
        <div className="matches-section">
          <h6 className="matches-heading">{t('Matches')} ({sortedMatches.length})</h6>
          {sortedMatches.map(renderMatchCard)}
        </div>
      )}

      {sortedMatches.length === 0 && !loading && (
        <div className="no-matches">{t('NO_MATCHES')}</div>
      )}

      {/* Accelerate form overlay */}
      {/* OP-04: slide-in animation. Wrap the form card in
          `overflow-hidden` to clip the off-screen `translateX(100%)`
          start state so the `slide-in-from-right` keyframe (defined
          in `utilities.scss`) doesn't leak into the surrounding
          modal layout. CSS animation replays automatically on each
          mount because `FormOverlay` returns null when `show` is
          false. Mirrors the same pattern applied in B-L3 to the
          Proposals/Proposal forms. */}
      <FormOverlay bare show={showAccelerate} onClose={() => setShowAccelerate(false)}>
        <div className="overflow-hidden">
          <div className="bg-body border rounded p-3 slide-in-from-right" style={{ minWidth: 420 }}>
            {order && (
              <AccelerateOrderForm
                order={order}
                onSuccess={handleAccelerateSuccess}
              />
            )}
          </div>
        </div>
      </FormOverlay>
    </div>
  )
}
