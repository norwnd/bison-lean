import { useState, useMemo } from 'react'
import { formatRateToRateStep, shortSymbol, logoPath } from '../../hooks/useFormatters'
import { ConnectionStatus } from '../../stores/types'
import type { Exchange } from '../../stores/types'
import { useUIStore } from '../../stores/useUIStore'
import { useMarketPageContext } from './MarketPageContext'
import { OrderBookRow } from './OrderBookRow'
import { type OrderBookDisplayRow, type ExchangeMarket } from './helpers'

// ---------------------------------------------------------------------------
// OrderBookPanel -- the leftmost section containing either the market list
// dock (when showMarketList is true) or the order book (sell side +
// external reference price + buy side). Reads currentMkt / bui / qui from
// MarketPageContext. Owns the `marketSearch` state internally.
// ---------------------------------------------------------------------------

export interface OrderBookPanelProps {
  showMarketList: boolean
  setShowMarketList: (next: boolean) => void
  allMarkets: ExchangeMarket[]
  exchanges: Record<string, Exchange>
  selected: { host: string; baseID: number; quoteID: number }
  selectMarket: (host: string, baseID: number, quoteID: number) => void
  orderBookData: { buys: OrderBookDisplayRow[]; sells: OrderBookDisplayRow[] }
  externalPriceConv: number
  fillRateFromBook: (msgRate: number) => void
  isConnected: boolean
  hasBook: boolean
}

export function OrderBookPanel ({
  showMarketList,
  setShowMarketList,
  allMarkets,
  exchanges,
  selected,
  selectMarket,
  orderBookData,
  externalPriceConv,
  fillRateFromBook,
  isConnected,
  hasBook
}: OrderBookPanelProps) {
  const { currentMkt, bui, qui } = useMarketPageContext()
  const darkMode = useUIStore(s => s.darkMode)

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
                const isSelected = selected.host === m.host &&
                  selected.baseID === m.baseID && selected.quoteID === m.quoteID
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
      <div id="orderBook" className="d-flex flex-stretch-column">
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
                  darkMode={darkMode}
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
                  darkMode={darkMode}
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
