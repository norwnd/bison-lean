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
  isMarketBuy, averageRate, baseToQuote,
  isCancellable, canAccelerateOrder
} from '../components/AccountUtils'
import { coinExplorerURL, formatCoinID } from '../components/CoinExplorers'
import { AccelerateOrderForm } from '../components/common/AccelerateOrderForm'
import { FormOverlay } from '../components/common/FormOverlay'
import {
  type LaneColor, MATCH_STAGE_COUNT,
  matchStageLabels, matchStageColored, matchCurStageIdx,
  matchLaneColor, matchStageHrefs,
  makerSwapCoin, takerSwapCoin, makerRedeemCoin, takerRedeemCoin,
} from '../components/MatchStages'
import {
  ORDER_STAGE_COUNT,
  orderStageLabels, orderStageColored, orderReachedStageIdx,
  orderLaneColor,
} from '../components/OrderStages'
import type {
  Order, Match, Coin, OrderNote, MatchNote,
  UnitInfo
} from '../stores/types'
import {
  OrderTypeLimit, OrderTypeMarket,
  RateEncodingFactor,
  MatchSideMaker, MatchSideTaker,
  MakerSwapCast, TakerSwapCast, MakerRedeemed, MatchComplete, MatchConfirmed,
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

function confirmationString (coin: Coin | undefined, t: (k: string) => string): string {
  if (!coin?.confs || coin.confs.required === 0) return ''
  return `${coin.confs.count} / ${coin.confs.required} ${t('CONFIRMATIONS')}`
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
// StatusDiagram
// ---------------------------------------------------------------------------

// Match-lifecycle and order-lifecycle stage helpers live in
// ../components/MatchStages and ../components/OrderStages so the
// /markets page and any other status-displaying UI can reuse the
// same mappings.

function Stage ({
  label, colored, connectorColored, href,
}: {
  label: string,
  colored: boolean,
  // connectorColored is undefined for the last stage in a lane (no
  // outgoing connector). true draws the connector in the lane color;
  // false draws it in the default grey.
  connectorColored?: boolean,
  // If provided, the stage label becomes an external explorer link.
  // Used by the match lane for the swap/redeem stages once the
  // corresponding on-chain coin is known.
  href?: string,
}) {
  const connectorAttr = connectorColored === undefined
    ? 'none'
    : connectorColored ? 'colored' : 'uncolored'
  const labelInner = href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
    : label
  return (
    <div
      className={`diagram-stage${colored ? ' colored' : ''}`}
      data-connector={connectorAttr}
    >
      <div className="diagram-dot" />
      <div className="diagram-stage-label">{labelInner}</div>
    </div>
  )
}

function MiniCard ({
  from, to, expanded, onClick,
}: {
  from: { amt: string, icon: string },
  to: { amt: string, icon: string },
  // Match mini-cards are clickable (click to expand). Pass `onClick`
  // undefined for non-interactive cards (e.g. the order-level card,
  // which has no expanded form since the /order page IS the detail
  // view). `expanded` is ignored when `onClick` is undefined.
  expanded?: boolean,
  onClick?: () => void,
}) {
  const body = (
    <>
      <span className="amount-with-icon">
        <span>{from.amt}</span>
        <img src={from.icon} alt="" className="micro-icon" />
      </span>
      <span className="mini-arrow">{'\u2192'}</span>
      <span className="amount-with-icon">
        <span>{to.amt}</span>
        <img src={to.icon} alt="" className="micro-icon" />
      </span>
    </>
  )
  if (onClick === undefined) {
    return <div className="mini-match-card readonly">{body}</div>
  }
  return (
    <button
      type="button"
      className={`mini-match-card${expanded ? ' expanded' : ''}`}
      onClick={onClick}
    >
      {body}
    </button>
  )
}

function LaneStages ({ labels, colored, hrefs }: {
  labels: readonly string[],
  colored: boolean[],
  // Per-stage explorer URLs. Same length as `labels`; entries are
  // undefined when no link applies to that stage. Omit the prop
  // entirely for lanes where no stage is ever clickable (e.g. the
  // order lane).
  hrefs?: (string | undefined)[],
}) {
  return (
    <div
      className="lane-stages"
      style={{ gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}
    >
      {labels.map((label, i) => {
        // A connector belongs to the lane color iff both of the stages
        // it joins are colored — so the colored region is visually
        // contiguous and stops exactly at the "current" stage.
        const connectorColored = i < labels.length - 1
          ? colored[i] && colored[i + 1]
          : undefined
        return (
          <Stage
            key={i}
            label={label}
            colored={colored[i]}
            connectorColored={connectorColored}
            href={hrefs?.[i]}
          />
        )
      })}
    </div>
  )
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
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null)

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

  // Cancel matches are bookkeeping entries tied to cancel orders, not
  // real swaps — they have no counterparty exchange and no progression
  // through the swap lifecycle. We filter them out of the lane
  // diagram entirely; the order's Canceled status (shown on the order
  // lane's terminal stage) already communicates the outcome.
  const regularMatches = [...(order.matches ?? [])]
    .filter(m => !m.isCancel)
    .sort((a, b) => a.stamp - b.stamp)

  const baseIcon = logoPath(order.baseSymbol)
  const quoteIcon = logoPath(order.quoteSymbol)

  // matchFromTo returns the pay/receive sides for a regular (non-cancel)
  // match in the user's perspective: `from` is what the user pays, `to`
  // is what the user receives. Shared between the mini-card in the
  // status diagram and the expanded match card's From/To metrics.
  const matchFromTo = (m: Match): {
    from: { amt: string, icon: string },
    to: { amt: string, icon: string },
  } => {
    const baseAmt = fmtBase(m.qty)
    const quoteAmt = fmtQuote(baseToQuote(m.rate, m.qty))
    if (order.sell) {
      return {
        from: { amt: baseAmt, icon: baseIcon },
        to: { amt: quoteAmt, icon: quoteIcon },
      }
    }
    return {
      from: { amt: quoteAmt, icon: quoteIcon },
      to: { amt: baseAmt, icon: baseIcon },
    }
  }

  // Portion of the overall order a match accounts for. Market buys
  // have qty in quote units so we compute the quote portion; otherwise
  // it's base-unit qty / order base qty.
  const matchPortionPct = (m: Match): string => {
    if (order.qty <= 0) return '0.0'
    const num = isMarketBuy(order) ? baseToQuote(m.rate, m.qty) : m.qty
    return ((num / order.qty) * 100).toFixed(1)
  }

  // Order-level mini card: shows the total order as From→To. For
  // market buys we estimate the base amount via the matches' average
  // rate once any match exists; before then the base side is unknown
  // and renders as "?".
  const orderMini = (): { from: { amt: string, icon: string }, to: { amt: string, icon: string } } => {
    const marketBuy = isMarketBuy(order)
    const orderRate = order.rate > 0 ? order.rate : averageRate(order)
    let baseAmtStr: string
    let quoteAmtStr: string
    if (marketBuy) {
      quoteAmtStr = fmtQuote(order.qty)
      baseAmtStr = orderRate > 0
        ? fmtBase(order.qty * RateEncodingFactor / orderRate)
        : '-'
    } else {
      baseAmtStr = fmtBase(order.qty)
      quoteAmtStr = orderRate > 0 ? fmtQuote(baseToQuote(orderRate, order.qty)) : '-'
    }
    if (order.sell) {
      return {
        from: { amt: baseAmtStr, icon: baseIcon },
        to: { amt: quoteAmtStr, icon: quoteIcon },
      }
    }
    return {
      from: { amt: quoteAmtStr, icon: quoteIcon },
      to: { amt: baseAmtStr, icon: baseIcon },
    }
  }

  const orderColored: boolean[] = Array.from(
    { length: ORDER_STAGE_COUNT },
    (_, i) => orderStageColored(order, i)
  )
  const orderLabels = orderStageLabels(order, t)
  const orderCurIdx = orderReachedStageIdx(order)
  const orderColor: LaneColor = orderLaneColor(order)

  // ---------------------------------------------------------------------------
  // Match card rendering
  // ---------------------------------------------------------------------------

  const renderCoinLink = (coin: Coin | undefined, pendingText: string) => {
    if (!coin) {
      return <span className="pending-placeholder">{pendingText}</span>
    }
    const parts = formatCoinID(coin.stringID)
    const href = coinExplorerURL(coin, net)
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

  // swapAssetLabels returns the short-symbol asset labels for a
  // match's swap, redeem, and refund steps from the user's
  // perspective. The maker always swaps what the seller is selling,
  // so the side-aware permutation is driven by whether the maker of
  // THIS match is the seller.
  const swapAssetLabels = (m: Match): {
    makerSwap: string,
    takerSwap: string,
    makerRedeem: string,
    takerRedeem: string,
    refund: string,
  } => {
    const isMakerSell = (m.side === MatchSideMaker && order.sell) ||
      (m.side === MatchSideTaker && !order.sell)
    const base = shortSymbol(bUnit)
    const quote = shortSymbol(qUnit)
    return {
      makerSwap: isMakerSell ? base : quote,
      takerSwap: isMakerSell ? quote : base,
      makerRedeem: isMakerSell ? quote : base,
      takerRedeem: isMakerSell ? base : quote,
      refund: order.sell ? base : quote,
    }
  }

  const renderMatchCard = (m: Match) => {
    const vis = stepVisibility(m)
    const confMsg = renderConfirmationMsg(m)
    const convRate = conventionalRate(order.baseID, order.quoteID, m.rate, allAssets)

    const matchTime = formatMatchDate(m.stamp)
    const { from, to } = matchFromTo(m)
    const assetLabels = swapAssetLabels(m)

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
            <div className="label">{t('Rate')}</div>
            <div className="value">{fmtRate(convRate)} {shortSymbol(bUnit)}/{shortSymbol(qUnit)}</div>
          </div>
          <div className="metric">
            <div className="label">{t('Portion')}</div>
            <div className="value">{matchPortionPct(m)}%</div>
          </div>
        </div>

        <div className="flow-row">
          <div className="metric">
            <div className="label">{t('From')}</div>
            <span className="amount-with-icon value">
              <span>{from.amt}</span>
              <img src={from.icon} alt="" className="micro-icon" />
            </span>
          </div>
          <div className="metric">
            <div className="label">{t('To')}</div>
            <span className="amount-with-icon value">
              <span>{to.amt}</span>
              <img src={to.icon} alt="" className="micro-icon" />
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
                {' '}({assetLabels.makerSwap}):
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
                {' '}({assetLabels.takerSwap}):
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
                {' '}({assetLabels.makerRedeem}):
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
                {' '}({assetLabels.takerRedeem}):
              </span>
              {renderCoinLink(takerRedeemCoin(m), t('PENDING'))}
            </div>
          )}
          {vis.refund && (
            <div className="match-step">
              <span className="match-step-label">{t('Refund')} ({assetLabels.refund}):</span>
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

      <div className="status-diagram">
        {/* Order lane: 4 stages (Created / Active-filled / Active-
            settled / Completed). Stage 2 splits out the settlement
            phase so an Executed-but-still-settling order stays
            visually in-progress until every match wraps up. The
            terminal label morphs to Canceled/Revoked/Completed. */}
        <div className={`lane order-lane lane-${orderColor}`}>
          <div className="lane-header">
            <span className="lane-label">{t('Order')}</span>
          </div>
          <LaneStages labels={orderLabels} colored={orderColored} />
          <div
            className="lane-card-row"
            style={{ gridTemplateColumns: `repeat(${ORDER_STAGE_COUNT}, 1fr)` }}
          >
            <div
              className="lane-card-cell"
              style={{ gridColumn: orderCurIdx + 1 }}
            >
              <MiniCard {...orderMini()} />
            </div>
          </div>
        </div>

        {/* Match lanes — one per regular match, in stamp order.
            The mini-card under the current stage is the user's entry
            point into the full match card (click to expand inline).
            Revoked matches render a Refund divert stage directly below
            the revocation column, colored once the refund coin lands. */}
        {regularMatches.map(m => {
          const labels = matchStageLabels(m, t)
          const colored = labels.map((_, i) => matchStageColored(m, i))
          const hrefs = matchStageHrefs(m, net)
          const curIdx = matchCurStageIdx(m)
          const mini = matchFromTo(m)
          const expanded = expandedMatchId === m.matchID
          const laneColor = matchLaneColor(m)
          const gridCols = { gridTemplateColumns: `repeat(${MATCH_STAGE_COUNT}, 1fr)` }
          return (
            <div key={m.matchID} className={`lane match-lane lane-${laneColor}`}>
              <LaneStages labels={labels} colored={colored} hrefs={hrefs} />
              <div className="lane-card-row" style={gridCols}>
                <div
                  className="lane-card-cell"
                  style={{ gridColumn: curIdx + 1 }}
                >
                  <MiniCard
                    {...mini}
                    expanded={expanded}
                    onClick={() => setExpandedMatchId(expanded ? null : m.matchID)}
                  />
                </div>
              </div>
              {m.revoked && (
                <div className="lane-divert-row" style={gridCols}>
                  <div
                    className="lane-divert-cell"
                    style={{ gridColumn: curIdx + 1 }}
                  >
                    <div className={`lane-divert-connector${m.refund ? ' colored' : ''}`} />
                    <Stage
                      label={t('Refund')}
                      colored={Boolean(m.refund)}
                      href={coinExplorerURL(m.refund, net)}
                    />
                  </div>
                </div>
              )}
              {expanded && (
                <div className="expanded-match-wrap">
                  {renderMatchCard(m)}
                </div>
              )}
            </div>
          )
        })}
      </div>

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
