import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRateToRateStep, shortSymbol, logoPath } from '../../hooks/useFormatters'
import { ConnectionStatus } from '../../stores/types'
import { useAuthStore } from '../../stores/useAuthStore'
import { useMarketPageContext } from './MarketPageContext'
import { OrderBookRow } from './OrderBookRow'
import {
  collectMarkets, ORDER_BOOK_MID_SECTION_PX,
  type OrderBookDisplayRow
} from './helpers'

// ---------------------------------------------------------------------------
// OrderBookPanel -- the leftmost section containing either the market list
// dock (when showMarketList is true) or the order book (sell side +
// external reference price + buy side). Reads currentMkt / bui / qui from
// MarketPageContext. Owns the `marketSearch` state internally.
//
// CL-MP-NARROW-SELECTOR (Fix A): this component owns the broad `exchanges`
// subscription. MarketsPage used to subscribe to the full map and pass it
// + `allMarkets` down as props, which forced a MarketsPage re-render on
// every spot note even when the user wasn't viewing the affected host.
// Moving the subscription here keeps those re-renders contained to this
// leaf panel (where the market-list dock actually needs the data).
// ---------------------------------------------------------------------------

export interface OrderBookPanelProps {
  showMarketList: boolean
  setShowMarketList: (next: boolean) => void
  selected: { host: string; baseID: number; quoteID: number }
  selectMarket: (host: string, baseID: number, quoteID: number) => void
  orderBookData: { buys: OrderBookDisplayRow[]; sells: OrderBookDisplayRow[] }
  externalPriceConv: number
  fillRateFromBook: (msgRate: number) => void
  isConnected: boolean
  hasBook: boolean
  // Callback ref for the `#orderBook` container. MarketsPage uses a
  // ResizeObserver on it to drive a viewport-aware row cap (more rows
  // on taller screens). Fires with `null` when the market-list dock
  // replaces the order book.
  orderBookRef?: (el: HTMLDivElement | null) => void
}

export function OrderBookPanel ({
  showMarketList,
  setShowMarketList,
  selected,
  selectMarket,
  orderBookData,
  externalPriceConv,
  fillRateFromBook,
  isConnected,
  hasBook,
  orderBookRef
}: OrderBookPanelProps) {
  const { t } = useTranslation()
  const { currentMkt, bui, qui } = useMarketPageContext()
  const authFailed = useAuthStore(s => s.authFailed)
  // CL-MP-NARROW-SELECTOR (Fix A): broad `exchanges` subscription lives
  // here (moved down from MarketsPage). `allMarkets` is derived locally
  // so MarketsPage doesn't have to keep the full map in its render
  // closure. Re-renders from spot notes stay inside this leaf.
  const exchanges = useAuthStore(s => s.exchanges)
  const allMarkets = useMemo(() => collectMarkets(exchanges), [exchanges])

  // marketSearch state is local to this panel.
  const [marketSearch, setMarketSearch] = useState('')

  const filteredMarkets = useMemo(() => {
    if (!marketSearch) return allMarkets
    const q = marketSearch.toLowerCase()
    return allMarkets.filter(m =>
      m.baseSymbol.toLowerCase().includes(q) ||
      m.quoteSymbol.toLowerCase().includes(q) ||
      m.host.toLowerCase().includes(q)
    )
  }, [allMarkets, marketSearch])

  return (
    <section className="d-flex">
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
                const isSelected = selected.host === m.host &&
                  selected.baseID === m.baseID && selected.quoteID === m.quoteID
                // MP-07: disconnected icon when the DEX host for this row is down.
                const xcForRow = exchanges[m.host]
                const isDisconnected = xcForRow
                  ? xcForRow.connectionStatus !== ConnectionStatus.Connected
                  : false
                // UI-AUTH: show a small spinner on market-list rows whose
                // DEX is WS-connected but still authing. Avoids showing
                // rows as "ready to trade" until auth actually completes.
                // Suppress when auth has failed — that host won't auth
                // further; an error state is more informative than a
                // forever-spinning indicator.
                const isAuthing = !isDisconnected && xcForRow
                  ? xcForRow.connectionStatus === ConnectionStatus.Connected &&
                    !xcForRow.authed && !xcForRow.viewOnly &&
                    !authFailed[m.host]
                  : false
                const hasAuthFailed = !isDisconnected && !!authFailed[m.host]
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
                        {isAuthing && (
                          <span
                            className="ico-spinner spinner fs11 ps-1"
                            title={t('AUTHENTICATING_WITH_DEX')}
                          />
                        )}
                        {hasAuthFailed && (
                          <span
                            className="text-danger ico-cross fs11 ps-1"
                            title="DEX authentication failed"
                          />
                        )}
                      </div>
                    </div>
                    <div className="d-flex flex-column flex-grow-1 ps-1">
                      <span className="fs22 demi">
                        {shortSymbol(m.baseSymbol)} / {shortSymbol(m.quoteSymbol)}
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
      <div
        id="orderBook"
        className="d-flex flex-stretch-column"
        ref={orderBookRef}
        style={{
          // Drives `.ordertable-wrap { height: calc(50% - var(--ob-mid-section-px)/2) }`
          // in markets.scss. Single source of truth lives in helpers.ts
          // so the CSS split and MarketsPage's ResizeObserver stay in
          // sync through one constant.
          ['--ob-mid-section-px' as string]: `${ORDER_BOOK_MID_SECTION_PX}px`
        }}
      >
        {/* Sell side (asks) - reversed so best ask at bottom */}
        <div className="hoveronly overflow-x-hidden flex-stretch-column ordertable-wrap reversible">
          <table className="compact lh1">
            <tbody id="sellRows">
              {orderBookData.sells.map((row) => (
                <OrderBookRow
                  key={row.key}
                  row={row}
                  sell
                  bui={bui}
                  qui={qui}
                  ratestep={currentMkt.ratestep}
                  lotsize={currentMkt.lotsize}
                  onClick={() => fillRateFromBook(row.msgRate)}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div id="obMidSection" className="d-flex flex-stretch-column align-items-center justify-content-center py-1 px-2">
          {externalPriceConv > 0 && (
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
              {orderBookData.buys.map((row) => (
                <OrderBookRow
                  key={row.key}
                  row={row}
                  sell={false}
                  bui={bui}
                  qui={qui}
                  ratestep={currentMkt.ratestep}
                  lotsize={currentMkt.lotsize}
                  onClick={() => fillRateFromBook(row.msgRate)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {!hasBook && (
          <div className="text-center grey py-4 fs15">
            {isConnected
              ? 'Loading order book...'
              : 'Connecting...'}
          </div>
        )}
      </div>
      )}
    </section>
  )
}
