import { useState } from 'react'
import {
  formatRateAtomToRateStep,
  formatCoinAtomToLotSizeBaseCurrency,
  shortSymbol
} from '../../hooks/useFormatters'
import type { RecentMatch, UnitInfo, Market } from '../../stores/types'
import { ageSince, useSecondTicker, RECENT_MATCHES_AGE_WINDOW_MS } from './helpers'

// ---------------------------------------------------------------------------
// RecentMatchesTable — extracted so its `useSecondTicker()` re-render is
// isolated to just this table. Without the extraction, putting the ticker
// at the MarketsPage level would force the whole page to re-render once
// per second.
//
// Implements vanilla parity for Section H (MP-45..MP-50):
//   MP-45: sortable columns (click to toggle direction / change column).
//   MP-46: 24-hour age filter.
//   MP-47: side-colored price and qty cells.
//   MP-48: headers include quote/base asset symbols (shortSymbol).
//   MP-49: live age ticker (shared with `useSecondTicker` above).
//   MP-50: 100-match storage cap — already enforced in the feed handler
//          (see `handleEpochMatchSummary`); no render cap here (vanilla
//          shows all 24h-filtered matches, box scrolls via
//          `max-height: 350px` + `stylish-overflow`).
// ---------------------------------------------------------------------------

export type RecentMatchesSortKey = 'price' | 'qty' | 'age'
export type RecentMatchesSortDir = 1 | -1

export interface RecentMatchesTableProps {
  recentMatches: RecentMatch[]
  bui: UnitInfo | null
  qui: UnitInfo | null
  currentMkt: Market | null
  baseSymbol: string
  quoteSymbol: string
}

export function RecentMatchesTable ({
  recentMatches, bui, qui, currentMkt, baseSymbol, quoteSymbol
}: RecentMatchesTableProps) {
  // MP-43/MP-49: 1 Hz re-render so the age column in the recent matches
  // table ticks live. Vanilla L566: the same ticker also touches
  // `page.recentMatchesLiveList` age cells.
  useSecondTicker()

  // MP-45: sort state. Vanilla defaults to `{ key: 'age', dir: -1 }` at
  // markets.ts L204-205 — newest matches first.
  const [sort, setSort] = useState<{ key: RecentMatchesSortKey; dir: RecentMatchesSortDir }>({
    key: 'age',
    dir: -1
  })

  // Click handler mirrors vanilla `setRecentMatchesSortCol` (markets.ts
  // L600-611): clicking the same column toggles direction; clicking a new
  // column switches and resets direction to ascending (1).
  const onHeaderClick = (key: RecentMatchesSortKey) => {
    setSort(prev => (
      prev.key === key
        ? { key, dir: (prev.dir * -1) as RecentMatchesSortDir }
        : { key, dir: 1 }
    ))
  }

  // MP-45 + MP-46: sort first, then filter — matches vanilla ordering in
  // `refreshRecentMatchesTable` (markets.ts L2794-2802). We copy the array
  // before sorting because vanilla's in-place `.sort` would mutate React
  // state, and React must never mutate state.
  //
  // No `useMemo` here deliberately: the 24h filter depends on `Date.now()`,
  // which has no React dep to key on. The parent `useSecondTicker` forces a
  // re-render every second, so inline recomputation is the simplest way to
  // keep the filter fresh as matches age out. Cost is trivial — ≤100 items
  // sorted and filtered once per second.
  const sortedFiltered = (() => {
    const copy = [...recentMatches]
    const dir = sort.dir
    switch (sort.key) {
      case 'price':
        copy.sort((a, b) => dir * (a.rate - b.rate))
        break
      case 'qty':
        copy.sort((a, b) => dir * (a.qty - b.qty))
        break
      case 'age':
        copy.sort((a, b) => dir * (a.stamp - b.stamp))
        break
    }
    const now = Date.now()
    return copy.filter(m => now - m.stamp <= RECENT_MATCHES_AGE_WINDOW_MS)
  })()

  // MP-45: the `sorted-asc` / `sorted-dsc` classes decide arrow visibility
  // and rotation via `markets.scss` L631-661.
  const sortClass = (key: RecentMatchesSortKey): string => {
    if (sort.key !== key) return ''
    return sort.dir === 1 ? 'sorted-asc' : 'sorted-dsc'
  }

  // MP-48: headers interpolate the market's short base/quote symbols.
  // Vanilla (markets.ts L1397-1399) uses:
  //   priceHdr = `Price (${Doc.shortSymbol(quote.symbol)})`
  //   qtyHdr   = `Size (${Doc.shortSymbol(base.symbol)})`
  //   ageHdr   = 'Age'
  const priceHdrText = quoteSymbol ? `Price (${shortSymbol(quoteSymbol)})` : 'Price'
  const qtyHdrText = baseSymbol ? `Size (${shortSymbol(baseSymbol)})` : 'Size'

  return (
    <div id="recentMatchesBox" className="flex-stretch-column my-1 border-top">
      <div className="text-center demi fs20 p-1">Recent Matches</div>
      <table id="recentMatchesTable" className="row-border row-hover lh1 border-bottom">
        <thead>
          <tr className="pointer">
            <th
              className={`text-start text-nowrap grey ${sortClass('price')}`.trim()}
              onClick={() => onHeaderClick('price')}
            >
              <span>{priceHdrText}</span>
              {' '}
              <span className="ico-arrowdown"></span>
            </th>
            <th
              className={`text-end text-nowrap grey ${sortClass('qty')}`.trim()}
              onClick={() => onHeaderClick('qty')}
            >
              <span className="ico-arrowdown"></span>
              {' '}
              <span>{qtyHdrText}</span>
            </th>
            <th
              className={`text-end text-nowrap grey ${sortClass('age')}`.trim()}
              onClick={() => onHeaderClick('age')}
            >
              <span className="ico-arrowdown"></span>
              {' '}
              <span>Age</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedFiltered.map(m => {
            // MP-47: both price and qty use vanilla's `buycolor`/`sellcolor`
            // utility classes (utilities.scss L106-111) rather than an inline
            // style — matches markets.ts L2810 + L2812. The `!m.sell`
            // inversion on the price comes from vanilla L2808: "for match
            // (when rate-formatting) the meaning of sell is reversed".
            const sideCls = m.sell ? 'sellcolor' : 'buycolor'
            // Composite key avoids tying React's reconciliation identity to
            // sort order (the old `${stamp}-${i}` did). Collision would
            // require two matches with identical (stamp, rate, qty, side)
            // in a single epoch — vanishingly unlikely in practice. When
            // `RecentMatch` exposes a server-assigned match id, switch to
            // that for strict uniqueness.
            return (
              <tr key={`${m.stamp}-${m.rate}-${m.qty}-${m.sell ? 's' : 'b'}`}>
                <td className={`text-start fs17 ${sideCls}`}>
                  {bui && qui && currentMkt
                    ? formatRateAtomToRateStep(m.rate, bui, qui, currentMkt.ratestep, !m.sell)
                    : ''}
                </td>
                <td className={`text-end fs17 ${sideCls}`}>
                  {bui && currentMkt
                    ? formatCoinAtomToLotSizeBaseCurrency(m.qty, bui, currentMkt.lotsize)
                    : ''}
                </td>
                <td className="preserve-spaces text-end fs17">{ageSince(m.stamp)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
