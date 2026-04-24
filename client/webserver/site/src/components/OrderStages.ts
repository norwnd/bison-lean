import {
  StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled, StatusRevoked,
  MatchComplete, MatchConfirmed,
} from '../stores/types'
import type { Match, Order } from '../stores/types'
import { matchQtyInOrderUnits } from './AccountUtils'
import type { LaneColor } from './MatchStages'

// An order progresses through two discrete UI stages flanking a
// progress bar:
//   0: Created                       — fires on submit
//   1: {Fulfilled|Canceled|Revoked}  — terminal, order off the book
//                                      AND every regular match
//                                      wrapped up; paired with a
//                                      live "(X% settled)" suffix
//                                      showing how much of the
//                                      ordered qty successfully
//                                      redeemed on-chain
// The space between the two stage dots is filled by the progress
// bar (rendered in OrderPage) — one segment per regular match,
// widths proportional to the match's portion of the order, colored
// by per-match outcome (good / bad / warning). Stage 0 carries a
// live "(X ago)" suffix via `orderStageAgeMs`.
//
// Unlike match statuses — which name the *last completed event* —
// order status names the *current phase* (StatusBooked = "on the
// book accepting matches"). `StatusExecuted` means "fully matched on
// the book", not "all swaps settled" — so an Executed order can
// still be pre-terminal while counterparty swaps are in flight.
// Stage 1 only fires when every regular match has wrapped up AND the
// order is off the book (Executed / Canceled / Revoked).

type TFunc = (k: string, opts?: Record<string, string>) => string

const ORDER_STAGE_COUNT = 2

function pct (n: number, d: number): string {
  if (d <= 0) return '0.0'
  return ((n / d) * 100).toFixed(1)
}

// regularMatches filters out cancel matches — those are bookkeeping
// entries attached to a cancel order, not real swaps with a
// counterparty. Every lane/stage rule here treats them as if they
// weren't there.
function regularMatches (order: Order): Match[] {
  return (order.matches ?? []).filter(m => !m.isCancel)
}

// orderTerminalName picks the outcome word used in the stage-1 label
// and in the compact status pill ("Fulfilled" / "Canceled" /
// "Revoked"). Non-terminal statuses fall through to "Fulfilled" —
// callers that care about the distinction should gate the call
// themselves.
function orderTerminalName (order: Order, t: TFunc): string {
  if (order.status === StatusCanceled) return t('Canceled')
  if (order.status === StatusRevoked) return t('Revoked')
  return t('Fulfilled')
}

// orderReachedStageIdx returns the furthest stage the order got to.
// Derived from match data + status because `StatusExecuted` alone
// doesn't tell us whether swaps have actually settled.
export function orderReachedStageIdx (order: Order): number {
  const regulars = regularMatches(order)
  const allDone = !regulars.some(m => m.active)
  const terminal = order.status === StatusExecuted ||
    order.status === StatusCanceled || order.status === StatusRevoked
  if (allDone && terminal) return 1
  return 0
}

// orderSettledQty sums the qty (in the same units as `order.qty`) of
// matches that have fully settled on-chain — both the maker and the
// taker have redeemed successfully. We gate on the strict protocol
// statuses (MatchComplete / MatchConfirmed) and exclude refunded
// matches; this matches the intent of the terminal "X% settled"
// suffix: how much of the order's qty actually crossed to the
// counterparty. Differs from `settled()` in AccountUtils which uses
// side-dependent thresholds — a maker's own MakerRedeemed counts for
// them but not for the order-level metric here, because the taker
// might still be mid-redeem (or refund-bound) at that moment.
export function orderSettledQty (order: Order): number {
  let sum = 0
  for (const m of regularMatches(order)) {
    if (m.refund) continue
    if (m.status !== MatchComplete && m.status !== MatchConfirmed) continue
    sum += matchQtyInOrderUnits(order, m)
  }
  return sum
}

// orderStageLabels returns the two left-to-right stage labels. The
// terminal slot pairs the outcome name with a live "(X% settled)"
// suffix once reached — callers render it verbatim (no extra
// percentage or age string on the terminal dot).
export function orderStageLabels (order: Order, t: TFunc): string[] {
  const terminal = orderTerminalName(order, t)
  if (orderReachedStageIdx(order) === ORDER_STAGE_COUNT - 1) {
    const settledPct = pct(orderSettledQty(order), order.qty)
    return [t('Created'), `${terminal} (${settledPct}% ${t('settled')})`]
  }
  return [t('Created'), terminal]
}

// orderStageAgeMs returns the reference timestamp for stages that
// render a live "(X ago)" suffix. Only stage 0 (Created) carries
// this — the terminal stage's own "(X% settled)" suffix is embedded
// directly in `orderStageLabels` so no age is rendered there.
export function orderStageAgeMs (order: Order, stageIdx: number): number | undefined {
  if (stageIdx === 0) return order.submitTime
  return undefined
}

// orderLaneColor returns the single color for the entire order lane.
//   - In-flight (Epoch / Booked): always 'warning'.
//   - Terminal with no regular matches: 'neutral' — nothing ever
//     happened at the counterparty level (cancel matches don't count).
//   - Terminal with at least one still-active regular match: 'warning'
//     — the order is "done" from the book's perspective but swaps are
//     still resolving underneath.
//   - Terminal otherwise: 'good' — all matches wrapped up.
// Note: a fully-refunded order is still 'good' at the order level;
// refund outcomes belong to individual match lanes.
export function orderLaneColor (order: Order): LaneColor {
  if (order.status === StatusEpoch || order.status === StatusBooked) return 'warning'
  const regulars = regularMatches(order)
  if (regulars.length === 0) return 'neutral'
  if (regulars.some(m => m.active)) return 'warning'
  return 'good'
}

// orderStageColored returns whether a single stage of the order lane
// should be painted in the lane color. Coloring tracks reached-idx
// directly — unlike match lanes, an order can be "terminal" on the
// book (StatusExecuted) while swaps are still settling, and we want
// the last stage to stay grey until every match wraps up.
export function orderStageColored (order: Order, stageIdx: number): boolean {
  return stageIdx <= orderReachedStageIdx(order)
}

// orderStatusDisplay returns the compact UI status string for an order
// ("Created" / "Active" / "Fulfilled" / "Canceled" / "Revoked").
// Intended for reuse on the /markets page and anywhere else that
// renders order status in UI — the longer diagram labels (with
// percentages) come from `orderStageLabels`.
export function orderStatusDisplay (order: Order, t: TFunc): string {
  if (order.status === StatusEpoch) return t('Created')
  if (order.status === StatusBooked) return t('Active')
  return orderTerminalName(order, t)
}
