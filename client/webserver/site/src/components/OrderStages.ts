import {
  StatusEpoch, StatusBooked,
  StatusCanceled, StatusRevoked,
} from '../stores/types'
import type { Match, Order } from '../stores/types'
import type { LaneColor } from './MatchStages'

// The /order page renders the order's current state as a compact
// "{dot} {Status} (created {Ago})" sentence inside the page header,
// colored by a single traffic-light indicator. Everything below —
// the progress bar and the per-match lanes — carries the granular
// detail; the header sentence just summarizes "where is this order
// right now" at a glance.
//
// Unlike match statuses (which name the *last completed event*),
// `Order.status` names the *current phase*: `StatusBooked` means
// "on the book accepting matches", `StatusExecuted` means "fully
// matched on the book" — NOT "every swap has settled". An Executed
// order can still be pre-terminal while counterparty swaps are in
// flight, and the same "settling" limbo can happen to Canceled /
// Revoked orders whose in-progress matches continue after the order
// comes off the book. We collapse all three of those into a single
// "Active" display status while any regular match is still active,
// then pick the terminal label once everything wraps up.

type TFunc = (k: string) => string

// regularMatches filters out cancel matches — those are bookkeeping
// entries attached to a cancel order, not real swaps with a
// counterparty. Every display rule here treats them as if they
// weren't there.
function regularMatches (order: Order): Match[] {
  return (order.matches ?? []).filter(m => !m.isCancel)
}

// OrderDisplayStatus is the traffic-light summary of an order's
// current state: a translation key naming the status, plus the
// indicator color that paints the dot beside it. `color` doubles as
// the "is the order finalized?" signal — anything other than
// 'warning' means no more matches are coming (used by the progress
// bar to paint an unfilled remainder in neutral).
export type OrderDisplayStatus = {
  key: 'Placed' | 'Active' | 'Fulfilled' | 'Completed' | 'Canceled' | 'Revoked',
  color: LaneColor,
}

// orderDisplayStatus maps protocol state to the header summary.
//   Placed     (warning)  — StatusEpoch: submitted, not yet booked
//   Active     (warning)  — StatusBooked, OR any other status with
//                           still-active regular matches. Covers the
//                           "settling" limbo where an Executed /
//                           Canceled / Revoked order has matches
//                           still working through their swap cycle.
//   Canceled   (neutral)  — off the book by user cancel, all matches done
//   Revoked    (neutral)  — off the book by server revoke, all matches done
//   Completed  (good)     — StatusExecuted, all matches done, at least
//                           one ended in a refund. Distinguishes from
//                           Fulfilled so the header doesn't claim a
//                           fully-successful outcome when some value
//                           didn't actually cross to the counterparty;
//                           per-match lanes below carry the detail.
//   Fulfilled  (good)     — StatusExecuted, all matches done, no refunds
//
// Note: all-matches-refunded is still "Completed" / good at the
// header level — the user receives their own funds back (good
// outcome for that match) and the per-match lanes surface the
// refund path individually. The header tracks "did the order finish
// cleanly" rather than "did any value change hands".
export function orderDisplayStatus (order: Order): OrderDisplayStatus {
  if (order.status === StatusEpoch) return { key: 'Placed', color: 'warning' }
  if (order.status === StatusBooked) return { key: 'Active', color: 'warning' }
  const regulars = regularMatches(order)
  if (regulars.some(m => m.active)) return { key: 'Active', color: 'warning' }
  if (order.status === StatusCanceled) return { key: 'Canceled', color: 'neutral' }
  if (order.status === StatusRevoked) return { key: 'Revoked', color: 'neutral' }
  // StatusExecuted + no active regulars: terminal at the swap level.
  const anyRefunded = regulars.some(m => Boolean(m.refund))
  if (anyRefunded) return { key: 'Completed', color: 'good' }
  return { key: 'Fulfilled', color: 'good' }
}

// orderIsFinalized returns true when no more matches can land on
// this order — the header has committed to a terminal label and
// the progress bar can safely paint the unfilled remainder in
// neutral. Equivalent to `orderDisplayStatus(order).color !==
// 'warning'` but spelled out for callers that don't need the key.
export function orderIsFinalized (order: Order): boolean {
  return orderDisplayStatus(order).color !== 'warning'
}

// orderStatusDisplay is the string-only variant used by the
// /markets page and the /orders table — call sites that just want
// the translated status text, no indicator color. Kept as a thin
// wrapper around `orderDisplayStatus` so the status mapping lives
// in one place.
export function orderStatusDisplay (order: Order, t: TFunc): string {
  return t(orderDisplayStatus(order).key)
}
