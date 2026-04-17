import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { postJSON, checkResponse } from '../../services/api'
import type { Order, OrderFilter, RecentMatch, OrderNote, MatchNote } from '../../stores/types'
import { StatusExecuted, StatusCanceled, StatusRevoked } from '../../stores/types'
import { useNotifications } from '../../hooks/useNotifications'
import { useMarketPageContext } from './MarketPageContext'
import { UserOrderRow } from './UserOrderRow'
import { RecentMatchesTable } from './RecentMatchesTable'
import { COMPLETED_PERIODS, MAX_COMPLETED_ORDERS } from './helpers'

// ---------------------------------------------------------------------------
// OrdersSection -- open orders, completed orders, and recent matches.
// Owns `completedPeriod`, `completedOrders`, `loadCompletedOrders` state +
// effect + callback, and `orderScrollerRef`.
// ---------------------------------------------------------------------------

export interface OrdersSectionProps {
  activeOrders: Order[]
  recentMatches: RecentMatch[]
  cancelOrder: (id: string) => void
  hasUnreadyOrders: boolean
  baseSymbol: string
  quoteSymbol: string
  scrollRef: React.RefObject<HTMLDivElement | null>
}

export function OrdersSection ({
  activeOrders,
  recentMatches,
  cancelOrder,
  hasUnreadyOrders,
  baseSymbol,
  quoteSymbol,
  scrollRef
}: OrdersSectionProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { selected, currentMkt, bui, qui } = useMarketPageContext()

  const [completedPeriod, setCompletedPeriod] = useState('hide')
  const [completedOrders, setCompletedOrders] = useState<Order[]>([])

  // Load completed orders -- self-contained, calls postJSON directly.
  const loadCompletedOrders = useCallback(async (period: string) => {
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

  // Refresh completed orders when an order/match note indicates state on
  // this market has changed. Without this, a user watching the "1 day"
  // (or longer) period would see a stale list until toggling the period
  // pill or reloading the page.
  const noteHandlers = useMemo(() => ({
    order: (note: OrderNote) => {
      if (completedPeriod === 'hide') return
      const ord = note.order
      if (ord.host !== selected.host) return
      if (ord.baseID !== selected.baseID || ord.quoteID !== selected.quoteID) return
      loadCompletedOrders(completedPeriod)
    },
    match: (note: MatchNote) => {
      if (completedPeriod === 'hide') return
      if (note.host !== selected.host || note.marketID !== currentMkt.name) return
      loadCompletedOrders(completedPeriod)
    }
  }), [selected, currentMkt, completedPeriod, loadCompletedOrders])
  useNotifications(noteHandlers)

  return (
    <>
      {/* Open Orders */}
      <div className="my-1 border-top">
        <div className="text-center demi fs20 p-1">{t('Open Orders')}</div>
        {/* MP-34: Unready-wallets warning */}
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
                  scrollRef={scrollRef}
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
                scrollRef={scrollRef}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recent Matches */}
      <RecentMatchesTable
        recentMatches={recentMatches}
        bui={bui}
        qui={qui}
        currentMkt={currentMkt}
        baseSymbol={baseSymbol}
        quoteSymbol={quoteSymbol}
      />
    </>
  )
}
