import {
  StatusEpoch, StatusBooked, StatusExecuted,
  StatusCanceled, StatusRevoked,
} from '../stores/types'
import type { Match, Order } from '../stores/types'
import { filled } from './AccountUtils'
import type { LaneColor } from './MatchStages'

// An order progresses through three discrete UI stages:
//   0: Created                      — fires on submit
//   1: Active (X% filled)           — on the book, anything not-yet-
//                                     terminal
//   2: {Completed|Canceled|Revoked} — terminal, order off the book AND
//                                     every regular match wrapped up
// Stages 0 and 2 pair with a live "(X ago)" suffix the caller renders
// via `orderStageAgeMs`.
//
// Unlike match statuses — which name the *last completed event* —
// order status names the *current phase* (StatusBooked = "on the book
// accepting matches"). `StatusExecuted` means "fully matched on the
// book", not "all swaps settled" — so an Executed order can still be
// in stage 1 while counterparty swaps are in flight. Stage 2 only
// fires when every regular match has wrapped up AND the order is off
// the book (Executed / Canceled / Revoked).

type TFunc = (k: string, opts?: Record<string, string>) => string

export const ORDER_STAGE_COUNT = 3

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

// orderTerminalName picks the outcome word used in the stage-2 label
// and in the compact status pill ("Completed" / "Canceled" /
// "Revoked"). Non-terminal statuses fall through to "Completed" —
// callers that care about the distinction should gate the call
// themselves.
function orderTerminalName (order: Order, t: TFunc): string {
  if (order.status === StatusCanceled) return t('Canceled')
  if (order.status === StatusRevoked) return t('Revoked')
  return t('Completed')
}

// orderReachedStageIdx returns the furthest stage the order got to.
// Derived from match data + status because `StatusExecuted` alone
// doesn't tell us whether swaps have actually settled.
export function orderReachedStageIdx (order: Order): number {
  if (order.status === StatusEpoch) return 0
  const regulars = regularMatches(order)
  const allDone = !regulars.some(m => m.active)
  const terminal = order.status === StatusExecuted ||
    order.status === StatusCanceled || order.status === StatusRevoked
  if (allDone && terminal) return 2
  return 1
}

// orderStageLabels returns the three left-to-right stage labels. The
// terminal slot is just the outcome name — the caller pairs it with
// a live "(X ago)" suffix via `orderStageAgeMs`.
export function orderStageLabels (order: Order, t: TFunc): string[] {
  const filledPct = pct(filled(order), order.qty)
  return [
    t('Created'),
    `${t('Active')} (${filledPct}% ${t('filled')})`,
    orderTerminalName(order, t),
  ]
}

// orderStageAgeMs returns the reference timestamp for stages that
// render a live "(X ago)" suffix — stage 0 (always, from submitTime)
// and the terminal stage once it's reached (from `stamp`, which the
// server advances on each order update; for a terminal order this
// captures the transition). Other stages return undefined.
export function orderStageAgeMs (order: Order, stageIdx: number): number | undefined {
  if (stageIdx === 0) return order.submitTime
  if (stageIdx === ORDER_STAGE_COUNT - 1 &&
      orderReachedStageIdx(order) === ORDER_STAGE_COUNT - 1) {
    return order.stamp
  }
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
// ("Created" / "Active" / "Completed" / "Canceled" / "Revoked"). Intended
// for reuse on the /markets page and anywhere else that renders order
// status in UI — the longer diagram labels (with percentages) come from
// `orderStageLabels`.
export function orderStatusDisplay (order: Order, t: TFunc): string {
  if (order.status === StatusEpoch) return t('Created')
  if (order.status === StatusBooked) return t('Active')
  return orderTerminalName(order, t)
}
