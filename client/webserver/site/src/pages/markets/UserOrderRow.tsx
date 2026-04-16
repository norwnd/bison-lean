import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  formatCoinAtomToLotSizeBaseCurrency,
  formatRateAtomToRateStep
} from '../../hooks/useFormatters'
import {
  filled, settled, isCancellable, hasActiveMatches
} from '../../components/AccountUtils'
import { orderPath } from '../../router/routes'
import type { Order, UnitInfo, Market } from '../../stores/types'
import { OrderTypeMarket, StatusExecuted } from '../../stores/types'
import {
  ageSince, statusString, typeString,
  marketOrderRateString, useSecondTicker
} from './helpers'

export interface UserOrderRowProps {
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

export function UserOrderRow ({ order, bui, qui, mkt, navigate, cancelOrder, variant, scrollRef }: UserOrderRowProps) {
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
