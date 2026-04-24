import { formatRateAtomToRateStep, formatCoinAtomToLotSizeBaseCurrency } from '../../hooks/useFormatters'
import type { OrderBookDisplayRow } from './helpers'
import type { UnitInfo } from '../../stores/types'

// ---------------------------------------------------------------------------
// OrderBookRow — one grouped row in the order book
// Implements MP-01 (rate delta), MP-02 (own-order marker),
// MP-03 (epoch check icons), MP-04 (numorders badge),
// MP-05 (weight gradient background).
// ---------------------------------------------------------------------------
export interface OrderBookRowProps {
  row: OrderBookDisplayRow
  sell: boolean
  bui: UnitInfo
  qui: UnitInfo
  ratestep: number
  lotsize: number
  onClick: () => void
}

export function OrderBookRow ({ row, sell, bui, qui, ratestep, lotsize, onClick }: OrderBookRowProps) {
  // MP-05 row-weight gradient: the side-specific base color and the
  // light/dark palette live in markets.scss (`.ob-row.buy/.sell` via
  // `--ob-row-bg`, themed off `--ob-buy-bg` / `--ob-sell-bg`); only
  // the per-row fill percentage changes here.
  const bgPct = row.priceRelevance * row.rowWeightRatio * 100

  // MP-01: rate delta color inverts when the order sits on the "wrong" side of
  // the external price, so the operator can see it at a glance.
  const baseColor = sell ? 'var(--sell-color)' : 'var(--buy-color)'
  const invertedColor = sell ? 'var(--buy-color)' : 'var(--sell-color)'
  const deltaColor = row.deltaInverted ? invertedColor : baseColor

  return (
    <tr
      className={`ob-row ${sell ? 'sell' : 'buy'} d-flex justify-content-between px-2 w-100 pointer`}
      style={{ ['--ob-row-pct' as string]: `${bgPct}%` }}
      onClick={onClick}
    >
      <td className="d-flex align-items-center text-nowrap pe-2">
        <span className="fs17" style={{ color: baseColor }}>
          {formatRateAtomToRateStep(row.rate, bui, qui, ratestep, sell)}
        </span>
        <span className="fs14 ps-1" style={{ color: deltaColor }}>
          {row.deltaText}
        </span>
        {row.hasOwnOrder && <div className="own-book-order ms-1" />}
        {row.isEpoch && (
          sell
            ? <span className="ico-check-sell fs10 ps-1" />
            : <span className="ico-check-buy fs10 ps-1" />
        )}
      </td>
      <td className="d-flex justify-content-end align-items-center ps-2">
        {row.numOrders > 1 && (
          <small
            className="numorders lh1 border-rounded3 text-center"
            title={`quantity is comprised of ${row.numOrders} orders`}
          >
            {row.numOrders}
          </small>
        )}
        <div className="fs17 ms-2">
          {formatCoinAtomToLotSizeBaseCurrency(row.qty, bui, lotsize)}
        </div>
      </td>
    </tr>
  )
}
