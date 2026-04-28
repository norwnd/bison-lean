import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import {
  formatCoinAtom, formatRateToRateStep,
  formatCoinAtomToLotSizeBaseCurrency, formatCoinAtomToLotSizeQuoteCurrency,
  conventionalRate, shortSymbol, logoPath, ageSince
} from '../hooks/useFormatters'
import {
  isMarketBuy, averageRate, baseToQuote,
  isCancellable, canAccelerateOrder, matchPortion
} from '../components/AccountUtils'
import { coinExplorerURL, formatCoinID } from '../components/CoinExplorers'
import { AccelerateOrderForm } from '../components/common/AccelerateOrderForm'
import { FormOverlay } from '../components/common/FormOverlay'
import {
  type StageCoinView, type StagePaint,
  matchStageCount, matchStageLabels, matchStagePaint, matchConnectorPaint,
  matchConnectorFill, matchCurStageIdx, matchLaneColor,
  matchStageHrefs, matchStageCoinViews,
  makerSwapCoin, takerSwapCoin, makerRedeemCoin, takerRedeemCoin,
  yourSwapStageIdx, refundTrackConnectorPaint, swapUnlockFill,
  refundConnectorFill, swapUnlockDotPaint, refundDotPaint,
  swapUnlockAtMs, takerSwapUnlockAtMs,
} from '../components/MatchStages'
import { orderDisplayStatus } from '../components/OrderStages'
import { buildOrderSegments } from '../components/OrderProgress'
import { OrderProgressBar } from '../components/OrderProgressBar'
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
// Helpers
// ---------------------------------------------------------------------------

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
// Ticking helpers
// ---------------------------------------------------------------------------

// useTick triggers a re-render every `intervalMs` ms while `enabled`
// is true. Components call it to refresh time-derived displays
// (elapsed "X ago" strings, lockTime fill %, etc.) without wiring a
// page-wide clock. Bumping the interval or flipping `enabled`
// reconciles the timer cleanly via useEffect deps — no stale closure
// and no stray setInterval after the component unmounts.
function useTick (intervalMs: number, enabled = true) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setTick(n => n + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
}

// Self-ticking "X ago" span. Kept as its own component so the tick
// interval only re-renders the tiny timestamp text instead of the
// whole OrderPage every 10 seconds.
function TimeAgo ({ ms }: { ms: number }) {
  useTick(10000)
  return <>{ageSince(ms)}</>
}

// cssVars packs standard camelCase style keys together with
// hyphenated CSS custom properties (`'--foo'`) into a
// React.CSSProperties — `--*` vars aren't typed in React's style type
// so inline objects that mix both need a cast. Undefined values are
// dropped so callers can pass optional props through without
// emitting `--foo: undefined;` to the rendered style attribute.
function cssVars (vars: Record<string, string | number | undefined>): React.CSSProperties {
  const out: Record<string, string | number> = {}
  for (const k of Object.keys(vars)) {
    const v = vars[k]
    if (v !== undefined) out[k] = v
  }
  return out as React.CSSProperties
}

// ---------------------------------------------------------------------------
// StatusDiagram
// ---------------------------------------------------------------------------

// Match-lifecycle and order-lifecycle stage helpers live in
// ../components/MatchStages and ../components/OrderStages so the
// /markets page and any other status-displaying UI can reuse the
// same mappings.

// StageCoin is the display-layer bundle for a stage's coin pill —
// the amount string, its asset icon, the UI sentiment that decorates
// the amount (sign + color: 'bad' = "-" debit, 'good' = "+" credit,
// 'neutral' = plain), and an optional explorer URL. When `href` is
// undefined the pill renders non-clickable (no border/background) —
// used for the in-progress stage to preview the pending amount
// before the coin is broadcast. Absent entirely when the stage has
// no on-chain coin (Match / Completed).
type StageCoin = {
  amt: string,
  icon: string,
  href?: string,
  sentiment: StageCoinView['sentiment'],
}

// Stage renders a single dot + label, plus an optional outgoing
// horizontal connector as a CSS ::after gradient. `paint` colors the
// dot; `connectorPaint` + `connectorFill` drive the connector's
// gradient (the left `fill`% is drawn in `paint`, the remainder stays
// neutral). Passing `connectorPaint` undefined suppresses the
// connector entirely — used for the last stage of every lane, and
// for bare divert-track dots. `gridColumn` / `gridRow` let callers
// place the stage at an explicit grid cell (used by the refund
// track, which anchors Swap Unlock / Refund to specific main-track
// columns); LaneStages leaves them undefined and relies on
// sequential grid flow.
function Stage ({
  label, paint, connectorPaint, connectorFill, ageMs, gridColumn, gridRow,
}: {
  label: string,
  paint: StagePaint,
  connectorPaint?: StagePaint,
  connectorFill?: number,
  // ageMs, when defined, appends a live "(X ago)" to the label.
  ageMs?: number,
  gridColumn?: number | string,
  gridRow?: number | string,
}) {
  const style = cssVars({
    'gridColumn': gridColumn,
    'gridRow': gridRow,
    '--conn-color': connectorPaint !== undefined
      ? `var(--indicator-${connectorPaint})`
      : undefined,
    '--conn-fill': connectorPaint !== undefined
      ? `${connectorFill ?? 100}%`
      : undefined,
  })
  return (
    <div
      className={`diagram-stage paint-${paint}`}
      data-connector={connectorPaint !== undefined ? 'on' : undefined}
      data-conn-paint={connectorPaint}
      style={style}
    >
      <div className="diagram-dot" />
      <div className="diagram-stage-label">
        {label}
        {ageMs !== undefined && <> (<TimeAgo ms={ageMs} /> ago)</>}
      </div>
    </div>
  )
}

// StageCoinButton renders a single stage's coin as a compact pill
// (amount + asset icon). Used inside `.lane-card-row` so the pills
// share the same grid row as the mini-match-card — both sit on a
// single horizontal line under the stages strip. The amount is
// decorated with a sign + color driven by the coin's sentiment so a
// glance shows whether this leg is user-debit ("-" bad), user-credit
// ("+" good), or neutral observation (no prefix). When a `href` is
// provided the pill is clickable (explorer link, new tab); otherwise
// it renders as a non-interactive readonly preview (no border /
// background) — used to project the current stage's pending amount
// before the coin is broadcast.
function StageCoinButton ({ coin }: { coin: StageCoin }) {
  const prefix = coin.sentiment === 'bad' ? '-' : coin.sentiment === 'good' ? '+' : ''
  const body = (
    <>
      <span className={`stage-coin-amt stage-coin-${coin.sentiment}`}>
        {prefix}{coin.amt}
      </span>
      <img src={coin.icon} alt="" className="micro-icon" />
    </>
  )
  if (!coin.href) {
    return <span className="stage-coin-button readonly">{body}</span>
  }
  return (
    <a
      className="stage-coin-button"
      href={coin.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {body}
    </a>
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

// StageInfo is the per-stage bundle a LaneStages caller computes
// in a single pass: the label, the dot's paint, and (for all but
// the terminal stage) the outgoing connector's paint + fill. `ageMs`
// opts the stage into a live "(X ago)" suffix. Colocating every
// stage's inputs in one object lets each lane type's derivation
// read as a single map() body instead of three parallel array
// builds.
type StageInfo = {
  label: string,
  paint: StagePaint,
  connectorPaint?: StagePaint,
  connectorFill?: number,
  ageMs?: number,
}

// LaneStages renders the horizontal main-track strip for a lane.
// Callers build one StageInfo per stage and hand it in directly.
function LaneStages ({ stages }: { stages: StageInfo[] }) {
  return (
    <div className="lane-stages">
      {stages.map((s, i) => (
        <Stage
          key={i}
          label={s.label}
          paint={s.paint}
          connectorPaint={s.connectorPaint}
          connectorFill={s.connectorFill}
          ageMs={s.ageMs}
        />
      ))}
    </div>
  )
}

// Refund-divert column offsets, measured from the `Your Swap` stage
// column (1-indexed, so `yourSwapIdx + STUB_COL_OFFSET` is the
// stub's grid-column). The stub drops straight below Your Swap,
// Swap Unlock sits one column to the right, and Refund aligns with
// Your Redeem another column further — independent of maker/taker
// perspective because both lanes put Your Swap immediately before
// the pair (Their Redeem | Your Redeem) for the taker or simply
// before Your Redeem for the maker.
const STUB_COL_OFFSET = 1
const SWAP_UNLOCK_COL_OFFSET = 2
const REFUND_COL_OFFSET = 3

// RefundTrack renders the refund divert for a single match lane.
// Layout (compact horizontal):
//
//   Main track row:   … [Your Swap] … [Their/Your Redeem] [Your Redeem]
//                              │
//   Divert row 1:              └───────── [Swap Unlock] ─── [Refund]
//   Divert row 2:                                                │
//                                                          [refund pill]
//
// Column anchoring (independent of maker/taker side):
//   stub       → Your Swap column (L-shape reaches right to Swap Unlock)
//   Swap Unlock → column preceding "Your Redeem"
//   Refund     → Your Redeem column
// Math reduces to yourSwapIdx+1 / yourSwapIdx+2 / yourSwapIdx+3 —
// the stub sits below Your Swap, Swap Unlock one column to the
// right, Refund another column further.
//
// The track is always rendered (not gated on m.revoked) so the happy
// and refund outcomes sit side-by-side from the first render. For
// terminal matches, exactly one of the two post-divergence paths
// (main-track redeem stages vs this divert) paints `good`; the other
// stays `neutral`. While active the connectors show granular
// progress: the L-stub fills with elapsed lockTime, the horizontal
// Swap Unlock→Refund connector fills with refund-coin confirmations.
// The component self-ticks every 10s so the lockTime fill advances
// in real time; the tick is gated on `m.active` so terminal matches
// carry zero timers.
function RefundTrack ({ m, yourSwapIdx, refundCoin, t }: {
  m: Match,
  yourSwapIdx: number,
  refundCoin?: StageCoin,
  t: (k: string) => string,
}) {
  // Gate ticks on `m.active` — terminal matches are frozen so they
  // don't need to wake the component every 10s.
  useTick(10000, m.active)
  const now = Date.now()
  const connPaint = refundTrackConnectorPaint(m)
  const stubCol = yourSwapIdx + STUB_COL_OFFSET
  const swapUnlockCol = yourSwapIdx + SWAP_UNLOCK_COL_OFFSET
  const refundCol = yourSwapIdx + REFUND_COL_OFFSET
  return (
    <div className="lane-divert-row">
      {/* L-shape connector dropping from the Your Swap column and
          reaching across to the Swap Unlock dot. The vertical and
          horizontal arms are drawn as ::before / ::after pseudo-
          elements on the stub wrapper — both inherit `--conn-color`
          / `--conn-fill` set here so they paint uniformly. Fill
          animates with elapsed lockTime while the match is active;
          on a terminal match the L flips to good (refund path) or
          neutral (happy path). */}
      <div
        className="lane-divert-stub"
        data-conn-paint={connPaint}
        style={cssVars({
          'gridColumn': stubCol,
          'gridRow': 1,
          '--conn-color': `var(--indicator-${connPaint})`,
          '--conn-fill': `${swapUnlockFill(m, now)}%`,
        })}
      />
      {/* Swap Unlock — the horizontal ::after reaches across to
          Refund and fills with refund-coin confirmations (0 until a
          refund is broadcast). */}
      <Stage
        label={t('STAGE_SWAP_UNLOCK')}
        paint={swapUnlockDotPaint(m, now)}
        connectorPaint={connPaint}
        connectorFill={refundConnectorFill(m)}
        gridColumn={swapUnlockCol}
        gridRow={1}
      />
      {/* Refund — terminal stage of the divert, no outgoing
          connector. */}
      <Stage
        label={t('REFUND')}
        paint={refundDotPaint(m)}
        gridColumn={refundCol}
        gridRow={1}
      />
      {/* Refund coin pill stacked below the Refund stage (row 2,
          same column), mirroring how redeem coin pills sit below
          their main-track stage in .lane-card-row. */}
      {refundCoin && (
        <div
          className="lane-divert-pill-slot"
          style={{ gridColumn: refundCol, gridRow: 2 }}
        >
          <StageCoinButton coin={refundCoin} />
        </div>
      )}
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
  // cancelSubmitting blocks a second cancel click while the POST is
  // in flight (prevents the "only one cancel order per epoch" server
  // error on double-tap). Reset on rejection so the user can retry;
  // once the server accepts, `order.cancelling` flips true and the
  // button stays rendered in its pressed/disabled state until the
  // order exits `isCancellable` (status >= StatusExecuted).
  const [cancelSubmitting, setCancelSubmitting] = useState(false)
  const [showAccelerate, setShowAccelerate] = useState(false)
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null)

  // Progress-bar ↔ match-lane interactions.
  //
  // `hoveredMatchID` drives the persistent cross-lane hover tint: when
  // the pointer is over a progress-bar segment, the corresponding
  // match-lane gets `.highlighted` (subtle lane-color bg wash).
  //
  // `flash` triggers a brief pulse on the match-lane when a segment
  // is clicked. The `tick` counter ensures repeat clicks on the same
  // match re-run the animation — React reads the tick as the overlay
  // element's key, so a new tick unmounts+remounts the overlay and
  // restarts the keyframe from the first frame.
  //
  // `matchLaneRefs` is a ref map keyed by matchID so a segment click
  // can `scrollIntoView` the corresponding lane without the
  // progress-bar needing to know anything about the DOM structure
  // below it.
  const [hoveredMatchID, setHoveredMatchID] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string, tick: number } | null>(null)
  const matchLaneRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const handleSegmentClick = useCallback((matchID: string) => {
    const el = matchLaneRefs.current[matchID]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlash(prev => ({ id: matchID, tick: (prev?.tick ?? 0) + 1 }))
  }, [])

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
    setCancelSubmitting(true)
    const res = await postJSON('/api/cancel', { orderID: oid })
    if (!checkResponse(res)) {
      setCancelError(res.msg)
      setCancelSubmitting(false)
      return
    }
    setOrder(prev =>
      prev
        ? { ...prev, cancelling: true }
        : prev
    )
    setCancelSubmitting(false)
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
  // The button stays visible while a cancel is in flight (local POST
  // round trip) or already accepted by the server (`order.cancelling`
  // flips true before the order's status progresses off Booked). In
  // both cases the button renders in the `.submit-pressed` state:
  // disabled, desaturated, scaled down — same pattern the Buy/Sell
  // submit button uses while waiting for its own round trip. The
  // button hides only when the order ages out of `isCancellable`
  // (status >= StatusExecuted or non-standing TiF).
  const cancelPressed = cancelSubmitting || order.cancelling
  // OP-01: full vanilla parity for the Accelerate button. Previously
  // used `hasActiveMatches()` which only checked whether ANY match
  // was still active -- it returned true even for matches well past
  // the swap step and for orders whose "from" wallet didn't support
  // acceleration. `canAccelerateOrder` (in `AccountUtils.ts`) checks
  // wallet trait + has-unconfirmed-swap, mirroring vanilla `app.ts`
  // `canAccelerateOrder()` (L1517-1532).
  const canAccelerate = canAccelerateOrder(order, walletMap)

  const typeStr = `${typeString(order, t)} ${sellBuyString(order, t)}`

  // Header rate display. Limit orders carry their rate on the order
  // itself; market orders derive one from `averageRate` once any
  // regular match has landed. Until a market order gets a
  // computable rate (no matches yet, or all matches still zero qty),
  // show '?' as a placeholder — the unit label ("DCR/POL") stays so
  // the visual slot reads as "{unknown} DCR/POL" rather than a bare
  // question mark.
  let rateStr: string
  const rateUnit = `${shortSymbol(bUnit)}/${shortSymbol(qUnit)}`
  if (order.type === OrderTypeMarket) {
    const avg = averageRate(order)
    if (avg > 0) {
      const convRate = conventionalRate(order.baseID, order.quoteID, avg, allAssets)
      // Multiple matches → average is approximate; prefix with '~'
      // so the user reads the rate as a blend rather than a precise
      // fill. Single match → it IS the fill rate, no prefix needed.
      rateStr = (order.matches?.length ?? 0) > 1
        ? `~ ${fmtRate(convRate)}`
        : fmtRate(convRate)
    } else {
      rateStr = '?'
    }
  } else {
    rateStr = fmtRate(conventionalRate(order.baseID, order.quoteID, order.rate, allAssets))
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

  // Portion of the overall order a match accounts for, formatted to
  // one decimal for the match-card "Portion" metric. Same math drives
  // the order-progress-lane progress-bar segment widths — both go through
  // `matchPortion` so the unit-conversion + zero-guard logic lives in
  // exactly one place (see AccountUtils).
  const matchPortionPct = (m: Match): string => matchPortion(order, m).toFixed(1)

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

  // Header status summary. Paints the dot beside the status word
  // and (via `color !== 'warning'`) tells the progress bar whether
  // it should paint an unfilled remainder as neutral (finalized) or
  // leave the vessel partially empty (still-active, more matches
  // might come).
  const status = orderDisplayStatus(order)

  // Per-match segments for the order-progress-lane progress bar. Shape +
  // ordering rules live in `buildOrderSegments` (see OrderProgress.ts)
  // so this page stays focused on UI wiring.
  const orderSegments = buildOrderSegments(order)

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
    // Pending refund messaging. `swapUnlockAtMs` shares the lockTime
    // lookup with the Refund-track's Swap Unlock connector so the
    // two UI surfaces stay in sync.
    const refundAfterMs = swapUnlockAtMs(m)
    if (Date.now() > refundAfterMs) {
      return <span className="refund-imminent">{t('REFUND_IMMINENT')}</span>
    }
    return (
      <span className="refund-pending">
        {t('REFUND_WILL_HAPPEN_AFTER', { refundAfterTime: formatMatchDate(refundAfterMs) })}
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
    const takerLockTimeExpired = Date.now() > takerSwapUnlockAtMs(m)

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
              <span className="match-step-label">{t('REFUND')} ({assetLabels.refund}):</span>
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
      {/* Single consolidated summary line, left-aligned with the
          per-order action buttons (Accelerate, Cancel) pushed to
          the right.
          Collapses the previous top-of-page `.order-header` (id +
          market/host), `.summary-grid` (Type/Rate/Quantity), and the
          order-progress-lane's `.lane-header` ("Order") into one baseline:
          "{order-type}: [from → to] @ {rate} {dot} {Status} (created
          {Ago}) [Accelerate] [Cancel]". Quantity is implicit in the
          mini-card's from/to amounts; id/host/lane-label are dropped
          — the /order URL already identifies the order. The trailing
          "{Status} (created {Ago})" block absorbs what used to be
          the order-progress-lane's two flanking stage dots (Created /
          terminal). Action buttons live inline here instead of in
          their own `.action-bar` row so they sit alongside the line
          they act on; `margin-left: auto` on the first `.order-
          action-btn` in `order.scss` pins them to the far right. */}
      <div className="order-summary-line">
        <span className={`order-type ${order.sell ? 'text-danger' : 'text-success'}`}>
          {typeStr}:
        </span>
        <MiniCard {...orderMini()} />
        <span className="order-rate">
          @ {rateStr} {rateUnit}
        </span>
        <span
          className={`order-status-dot paint-${status.color}`}
          aria-hidden="true"
        />
        <span className={`order-status paint-${status.color}`}>{t(status.key)}</span>
        <span className="order-age">
          ({t('CREATED')} <TimeAgo ms={order.submitTime} /> ago)
        </span>
        {canAccelerate && (
          <button
            className="order-action-btn"
            onClick={() => setShowAccelerate(true)}
          >
            {t('ACCELERATE_ORDER')}
          </button>
        )}
        {canCancel && (
          <button
            className={`order-action-btn danger${cancelPressed ? ' submit-pressed' : ''}`}
            onClick={submitCancel}
            disabled={cancelPressed}
          >
            {t('CANCEL')}
          </button>
        )}
      </div>

      {cancelError && (
        <div className="cancel-error">{cancelError}</div>
      )}

      <div className="status-diagram">
        {/* Order lane: a single vessel-shaped progress bar. Renders
            one segment per regular match in stamp order (same order
            as the match lanes below), widths proportional to each
            match's portion of the order qty, colors driven by match
            outcome (good/bad/warning). Segments are hoverable (tints
            the corresponding match lane) and clickable (scrolls to +
            flashes the match lane). The former flanking Created /
            terminal stage dots now live inline in the page header's
            "{Status} (created {Ago})" tail. Once the order is
            finalized with an unfilled remainder, a trailing neutral
            segment paints the portion that never matched; until
            then the vessel bg shows through the unfilled space. */}
        <div className="lane order-progress-lane">
          <OrderProgressBar
            segments={orderSegments}
            hoveredMatchID={hoveredMatchID}
            onHover={setHoveredMatchID}
            onClick={handleSegmentClick}
          />
        </div>

        {/* Match lanes — one per regular match, in stamp order.
            The mini-card under stage 0 (Match) is the user's entry
            point into the full match card (click to expand inline).
            Every match also renders a Refund divert below the
            "Your Swap" column so the happy-path and refund-path
            outcomes are visible side-by-side from the first render. */}
        {regularMatches.map((m) => {
          const hrefs = matchStageHrefs(m, net)
          const views = matchStageCoinViews(m)
          const mini = matchFromTo(m)
          const curIdx = matchCurStageIdx(m)
          const yourSwapIdx = yourSwapStageIdx(m)
          // Per-match stage count — maker lanes drop "Their Redeem"
          // and terminate at Your Redeem (4 stages); taker lanes
          // keep the full 5. Used both to gate the terminal stage's
          // connector and to size the lane's CSS grid.
          const stageCount = matchStageCount(m)
          // Single-pass stage build. The terminal stage has no
          // outgoing connector — we leave its connectorPaint /
          // connectorFill undefined and Stage skips the ::after
          // entirely.
          const matchStages: StageInfo[] = matchStageLabels(m, t).map((label, i) => {
            const isLast = i === stageCount - 1
            return {
              label,
              paint: matchStagePaint(m, i),
              connectorPaint: isLast ? undefined : matchConnectorPaint(m, i),
              connectorFill: isLast ? undefined : matchConnectorFill(m, i),
            }
          })
          // Compose per-stage coin pills from hrefs + views + mini.
          // A stage gets a pill when it has a mapped view (Match
          // stage is undefined in `views`) AND either the coin's
          // explorer URL is known (clickable) or it's the current
          // stage (readonly preview — no href, non-clickable
          // styling).
          const stageCoins: (StageCoin | undefined)[] = views.map((view, i) => {
            if (!view) return undefined
            const href = hrefs[i]
            if (!href && i !== curIdx) return undefined
            return {
              amt: mini[view.side].amt,
              icon: mini[view.side].icon,
              href,
              sentiment: view.sentiment,
            }
          })
          const expanded = expandedMatchId === m.matchID
          const laneColor = matchLaneColor(m)
          // Refund pill: the user is always refunded their own
          // outgoing asset ('from' side) and getting money back is a
          // credit — sentiment 'good' with a "+" prefix. Present
          // only once the refund coin has been broadcast.
          const refundHref = coinExplorerURL(m.refund, net)
          const refundCoin: StageCoin | undefined = refundHref
            ? { amt: mini.from.amt, icon: mini.from.icon, href: refundHref, sentiment: 'good' }
            : undefined
          const highlighted = hoveredMatchID === m.matchID
          const flashing = flash?.id === m.matchID
          return (
            <div
              key={m.matchID}
              ref={el => { matchLaneRefs.current[m.matchID] = el }}
              className={`lane match-lane lane-${laneColor}${highlighted ? ' highlighted' : ''}`}
              style={cssVars({ '--stage-count': stageCount })}
              // Bidirectional hover link: hovering the lane highlights
              // the matching progress-bar segment (via
              // `hoveredMatchID`), mirroring the bar→lane tint that
              // fires when the pointer is on a segment. The lane
              // itself is a plain div (not focusable), so pointer
              // handlers cover it; keyboard users reach the lanes'
              // interactive children (mini-card button, coin links)
              // whose own focus rings remain the visual signal.
              onMouseEnter={() => setHoveredMatchID(m.matchID)}
              onMouseLeave={() => setHoveredMatchID(null)}
            >
              {/* Flash overlay: keyed by `flash.tick` so a repeat
                  click re-mounts the element and restarts the
                  keyframe animation from the first frame. Lives
                  only on the currently-flashing lane; `onAnimationEnd`
                  clears the state so the overlay unmounts cleanly
                  instead of lingering at opacity 0. */}
              {flashing && (
                <div
                  key={flash.tick}
                  className="match-lane-flash-overlay"
                  onAnimationEnd={() => setFlash(null)}
                />
              )}
              <LaneStages stages={matchStages} />
              {/* Mini-card first in DOM so CSS grid auto-flow places
                  it on row 1 col 1 before the coin cells fill columns
                  2..N — otherwise sparse auto-flow would wrap the
                  mini-card onto a new row because col 1 precedes the
                  flow cursor. */}
              <div className="lane-card-row">
                <div className="lane-card-cell" style={{ gridColumn: 1 }}>
                  <MiniCard
                    {...mini}
                    expanded={expanded}
                    onClick={() => setExpandedMatchId(expanded ? null : m.matchID)}
                  />
                </div>
                {stageCoins.map((coin, i) => coin
                  ? (
                    <div
                      key={`coin-${i}`}
                      className="lane-card-cell"
                      style={{ gridColumn: i + 1 }}
                    >
                      <StageCoinButton coin={coin} />
                    </div>
                  )
                  : null)}
              </div>
              <RefundTrack m={m} yourSwapIdx={yourSwapIdx} refundCoin={refundCoin} t={t} />
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
