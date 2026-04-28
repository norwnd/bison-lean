import type { Order } from '../stores/types'
import { matchPortion } from './AccountUtils'
import { type SegmentPaint, matchSegmentPaint } from './MatchStages'
import { orderIsFinalized } from './OrderStages'

// OrderProgress.ts collects the pure data helpers behind the
// /order page's order-progress-lane progress bar. The React component that
// renders the bar (`OrderProgressBar` in OrderPage.tsx) is a thin
// wrapper over an `OrderSegment[]` built here - keeping the segment
// math out of the render path means the bar can be unit-tested or
// reused by other surfaces (e.g. a compact order summary widget)
// without dragging along the hover/click interaction handlers.

// OrderSegment is the per-segment bundle the order progress bar
// consumes. Each regular match contributes one segment; the trailing
// slot depends on the order's state:
//   * finalized + unfilled remainder → one `neutral` segment carrying
//     the remainder percentage (reads as "X.X% never matched")
//   * active + unfilled remainder → one `empty` placeholder carrying
//     "0.0%" (reads as "this slice has contributed 0% - so far")
// Match-backed segments always resolve to one of good/warning/bad
// via `SegmentPaint`; the two trailing variants widen the union.
export type OrderSegment = {
  matchID?: string,
  widthPct: number,
  pctLabel: string,
  paint: SegmentPaint | 'neutral' | 'empty',
}

// buildOrderSegments produces the ordered list of segments the
// progress bar renders. Each regular (non-cancel) match contributes
// a segment whose width tracks its portion of the overall order qty
// (in `order.qty`'s units - base for limit/market-sell, quote for
// market-buy) and whose color tracks the match's outcome (good /
// warning / bad). Segments are ordered by match `stamp` to mirror
// the match-lane stack below the bar - clicking a bar segment jumps
// to the lane at the same relative position. Any unfilled remainder
// always gets a trailing slab so the bar reads as a full sequence:
// finalized orders (no more matches can land) get a solid `neutral`
// slab labeled with its actual percentage (portion that never
// matched); active orders get an `empty` placeholder labeled
// "0.0%" (the slice has contributed nothing - yet). Zero-portion
// matches (cancel matches, or matches whose qty rounded to 0 in
// the order's units) are skipped - they carry no visual weight.
export function buildOrderSegments (order: Order): OrderSegment[] {
  const regulars = [...(order.matches ?? [])]
    .filter(m => !m.isCancel)
    .sort((a, b) => a.stamp - b.stamp)
  const segments: OrderSegment[] = []
  let filledPct = 0
  for (const m of regulars) {
    const portion = matchPortion(order, m)
    if (portion <= 0) continue
    segments.push({
      matchID: m.matchID,
      widthPct: portion,
      pctLabel: `${portion.toFixed(1)}%`,
      paint: matchSegmentPaint(m),
    })
    filledPct += portion
  }
  if (filledPct < 100) {
    const remainderPct = 100 - filledPct
    if (orderIsFinalized(order)) {
      segments.push({
        widthPct: remainderPct,
        pctLabel: `${remainderPct.toFixed(1)}%`,
        paint: 'neutral',
      })
    } else {
      segments.push({
        widthPct: remainderPct,
        pctLabel: '0.0%',
        paint: 'empty',
      })
    }
  }
  return segments
}
