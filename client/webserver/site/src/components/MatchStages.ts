import {
  MatchSideMaker,
  NewlyMatched, MakerSwapCast, TakerSwapCast,
  MakerRedeemed, MatchComplete, MatchConfirmed,
} from '../stores/types'
import type { Coin, Match } from '../stores/types'
import { coinExplorerURL } from './CoinExplorers'

// A match progresses through a perspective-aware sequence of happy-
// path UI stages on the main track, mapped from the protocol-level
// match statuses (NewlyMatched, MakerSwapCast, ...). Every lane also
// renders a Refund track ("Swap Unlock" → "Refund") that diverts
// vertically from the "Your Swap" column — visible for every match,
// not just revoked ones, so the two possible outcomes (happy
// completion vs refund) are laid out side-by-side.
//
// Track length differs by side:
//   - Taker: 5 stages — Match, Their Swap, Your Swap, Their Redeem,
//     Your Redeem. The taker's Their Redeem (maker's on-chain redeem)
//     has to happen before the taker can redeem, so we render it.
//   - Maker: 4 stages — Match, Your Swap, Their Swap, Your Redeem.
//     The maker's Their Redeem (taker's on-chain redeem) happens
//     AFTER Your Redeem and carries no actionable signal, so we omit
//     it; Your Redeem is the lane's terminal stage.
//
// Stage labels are perspective-aware ("Your" / "Their" depending on
// whether the user was the maker or taker) — the protocol status
// names ("Maker Swap Cast", etc.) stay on the wire; users only care
// whether a step was their action or their counterparty's.
//
// The semantic rule for match status is: a protocol status of N means
// stage N has been *completed* and stage N+1 is the in-progress step
// (except at the terminal `MatchComplete` / `MatchConfirmed`, where
// the lane is fully done). This differs from the order-progress-lane semantics
// where `StatusEpoch / Booked / Executed` name the current phase
// rather than a completed event.

type TFunc = (k: string, opts?: Record<string, string>) => string

// matchStageCount returns the number of main-track stages for the
// given match. Maker lanes end at Your Redeem (4 stages); taker lanes
// include Their Redeem + Your Redeem (5 stages). See the top-of-file
// comment for the rationale.
export function matchStageCount (m: Match): number {
  return m.side === MatchSideMaker ? 4 : 5
}

// lockTimeMakerMs / lockTimeTakerMs must match LockTimeMaker /
// LockTimeTaker in bisonw. These are the maximum time a user's swap
// can be locked before they're allowed to broadcast a refund
// transaction. Kept module-private — callers go through the
// perspective-aware `swapUnlockAtMs` (the user's own unlock time)
// or `takerSwapUnlockAtMs` (the taker's unlock time specifically,
// used by the match card's revoked-path visibility rule).
const lockTimeMakerMs = 20 * 60 * 60 * 1000
const lockTimeTakerMs = 8 * 60 * 60 * 1000

// LaneColor classifies an entire lane (match or order) with a single
// outcome-driven color. Individual stages within the lane are
// painted per-stage based on the taken path (see matchStagePaint):
//   'warning' — still in progress (active)
//   'good'    — terminal (path-painted; non-taken stages go neutral)
//   'neutral' — terminal, nothing happened (orders with no matches)
export type LaneColor = 'good' | 'warning' | 'neutral'

// StagePaint is the resolved color for a single dot or connector.
// 'neutral' stages are left in the default grey; 'warning' / 'good'
// map to the corresponding `--indicator-*` CSS variable.
export type StagePaint = 'good' | 'warning' | 'neutral'

// matchStageLabels returns the main-track stage labels for the given
// match, ordered left-to-right along the lifecycle. Length depends on
// side — see `matchStageCount` / the top-of-file comment for the
// rationale behind dropping Their Redeem on the maker lane.
export function matchStageLabels (m: Match, t: TFunc): string[] {
  if (m.side === MatchSideMaker) {
    return [
      t('STAGE_MATCH'),
      t('STAGE_YOUR_SWAP'),
      t('STAGE_THEIR_SWAP'),
      t('STAGE_YOUR_REDEEM'),
    ]
  }
  return [
    t('STAGE_MATCH'),
    t('STAGE_THEIR_SWAP'),
    t('STAGE_YOUR_SWAP'),
    t('STAGE_THEIR_REDEEM'),
    t('STAGE_YOUR_REDEEM'),
  ]
}

// matchDoneStageIdx returns the index of the last completed stage for
// the user's perspective. For the taker, MatchComplete (= taker
// redeem observed) advances to the 5th stage; for the maker the lane
// ends at Your Redeem (stage 3), so MatchComplete / MatchConfirmed
// collapse onto MakerRedeemed (= maker's own redeem observed).
export function matchDoneStageIdx (m: Match): number {
  const isMaker = m.side === MatchSideMaker
  switch (m.status) {
    case NewlyMatched: return 0
    case MakerSwapCast: return 1
    case TakerSwapCast: return 2
    case MakerRedeemed: return 3
    case MatchComplete:
    case MatchConfirmed: return isMaker ? 3 : 4
    default: return 0
  }
}

// matchCurStageIdx returns the index of the in-progress stage — the
// "next up" one. Collapses to doneIdx when the match has reached the
// final stage.
export function matchCurStageIdx (m: Match): number {
  const done = matchDoneStageIdx(m)
  return Math.min(done + 1, matchStageCount(m) - 1)
}

// matchVisuallyTerminal reports whether every user-visible stage has
// been reached. This drives "paint the lane good" even while the
// server still reports m.active — e.g. the maker's MakerRedeemed
// moment flips the lane good immediately, without waiting for
// MatchComplete/MatchConfirmed (which for the maker are post-
// completion bookkeeping on stages the lane no longer renders). The
// taker reaches this state at MatchComplete.
export function matchVisuallyTerminal (m: Match): boolean {
  if (!m.active) return true
  return matchDoneStageIdx(m) >= matchStageCount(m) - 1
}

// yourSwapStageIdx returns the divergence point — the stage index of
// the user's own swap, where the Refund track branches off. Stages
// at or before this index are always colored `good` on a terminal
// match (they belong to both the happy and refund paths); stages
// after diverge by path.
export function yourSwapStageIdx (m: Match): number {
  return m.side === MatchSideMaker ? 1 : 2
}

// matchRefundPathTaken reports whether the match's terminal outcome
// was a refund (user got their own funds back) as opposed to a
// regular redeem. The distinguishing signal is simply whether a
// refund coin was broadcast at any point in the match's lifetime.
export function matchRefundPathTaken (m: Match): boolean {
  return Boolean(m.refund)
}

// matchLaneColor returns the single lane-level color descriptor.
// Visually-terminal lanes are 'good' (incl. the maker's
// MakerRedeemed window, see `matchVisuallyTerminal`); otherwise
// active matches are 'warning'. Per-stage painting handles the
// non-taken path — it stays neutral via matchStagePaint, no more
// 'bad' outcome at the lane level.
export function matchLaneColor (m: Match): LaneColor {
  if (matchVisuallyTerminal(m)) return 'good'
  return 'warning'
}

// SegmentPaint is the outcome-level color for a single match's
// segment in the order-progress-lane progress bar. Unlike lane-level
// `LaneColor` (which collapses refunded matches to 'good' because the
// order itself is still "done"), the progress bar wants to *visually
// distinguish* a refunded match from a successful one — hence 'bad'
// as a first-class outcome.
export type SegmentPaint = 'good' | 'warning' | 'bad'

// matchSegmentPaint resolves the color for a match's order-progress-
// bar segment:
//   'warning' — match still in flight (not visually terminal)
//   'bad'     — terminal with a refund coin broadcast (refund path)
//   'good'    — terminal on the happy path (both sides redeemed, or
//               the maker's post-MakerRedeemed window — see
//               `matchVisuallyTerminal`)
export function matchSegmentPaint (m: Match): SegmentPaint {
  if (!matchVisuallyTerminal(m)) return 'warning'
  return matchRefundPathTaken(m) ? 'bad' : 'good'
}

// matchStagePaint resolves a single main-track stage's color.
//  - Active (not yet visually terminal): stages 0..doneIdx are
//    'warning' (completed steps); later stages stay 'neutral'. The
//    "next up" stage is NOT painted — its arrival is signalled by
//    the partial warning fill on the incoming connector (see
//    matchConnectorFill).
//  - Visually terminal: stages 0..D are always 'good' (before/at
//    divergence, belong to both paths). Stages past D are 'good' on
//    the happy path, 'neutral' on the refund path.
export function matchStagePaint (m: Match, stageIdx: number): StagePaint {
  if (!matchVisuallyTerminal(m)) {
    return stageIdx <= matchDoneStageIdx(m) ? 'warning' : 'neutral'
  }
  const d = yourSwapStageIdx(m)
  if (stageIdx <= d) return 'good'
  return matchRefundPathTaken(m) ? 'neutral' : 'good'
}

// matchConnectorTxCoin returns the on-chain coin whose confirmations
// drive the granular warning fill on connector N→N+1:
//   0→1: maker swap coin (waited on while status is NewlyMatched)
//   1→2: taker swap coin (waited on while status is MakerSwapCast)
//   2→3: maker redeem coin (waited on while status is TakerSwapCast)
//   3→4: taker redeem coin (waited on while status is MakerRedeemed)
//          — taker lane only; the maker lane ends at stage 3.
export function matchConnectorTxCoin (m: Match, startIdx: number): Coin | undefined {
  switch (startIdx) {
    case 0: return makerSwapCoin(m)
    case 1: return takerSwapCoin(m)
    case 2: return makerRedeemCoin(m)
    case 3: return m.side === MatchSideMaker ? undefined : takerRedeemCoin(m)
    default: return undefined
  }
}

// coinConfsFill returns the fill % for a coin based on its
// confirmation progress (count / required). Clamped to [0, 100].
// Returns 0 when the coin is undefined or required is 0.
export function coinConfsFill (coin: Coin | undefined): number {
  if (!coin?.confs || coin.confs.required === 0) return 0
  return Math.max(0, Math.min(100, (coin.confs.count / coin.confs.required) * 100))
}

// matchConnectorFill returns the fill percentage (0-100) for the
// connector starting at stage `startIdx` on the main track.
//  - Visually terminal: 100 on the taken path, 0 off the taken path.
//    Before divergence it's always 100.
//  - Active (not yet visually terminal):
//     - Fully filled (100) if the transition has already completed
//       (startIdx < doneIdx).
//     - Partial, coin-confs-driven, for the one in-progress
//       transition (startIdx == doneIdx).
//     - 0 for not-yet-started transitions (startIdx > doneIdx).
export function matchConnectorFill (m: Match, startIdx: number): number {
  if (matchVisuallyTerminal(m)) {
    const d = yourSwapStageIdx(m)
    if (startIdx < d) return 100
    return matchRefundPathTaken(m) ? 0 : 100
  }
  const done = matchDoneStageIdx(m)
  if (startIdx < done) return 100
  if (startIdx > done) return 0
  return coinConfsFill(matchConnectorTxCoin(m, startIdx))
}

// matchConnectorPaint returns the color of a main-track connector.
// Paired with matchConnectorFill: the connector renders as a
// gradient from (color, fill%) to (neutral, remainder).
export function matchConnectorPaint (m: Match, startIdx: number): StagePaint {
  if (!matchVisuallyTerminal(m)) return 'warning'
  const d = yourSwapStageIdx(m)
  if (startIdx < d) return 'good'
  return matchRefundPathTaken(m) ? 'neutral' : 'good'
}

// --------------------------------------------------------------------
// Refund track
// --------------------------------------------------------------------
//
// The refund track diverts from the "Your Swap" column and runs
// vertically: Your Swap → Swap Unlock → Refund. It's always rendered,
// even for non-revoked matches, so the two possible outcomes are
// laid out side-by-side. While the match is active, the Swap Unlock
// connector shows time-based progress (lockTime elapsed since the
// user's swap stamp) and the Refund connector shows confs progress on
// the broadcast refund tx (0% if no refund has been broadcast). When
// terminal, the whole track flips to 'good' on the refund path,
// 'neutral' on the happy path.

// swapLockTimeMs is the user's swap lock duration (maker vs taker).
export function swapLockTimeMs (m: Match): number {
  return m.side === MatchSideMaker ? lockTimeMakerMs : lockTimeTakerMs
}

// swapUnlockAtMs returns the wall-clock moment at which the user's
// swap becomes refundable.
export function swapUnlockAtMs (m: Match): number {
  return m.stamp + swapLockTimeMs(m)
}

// takerSwapUnlockAtMs returns the wall-clock moment at which the
// TAKER's swap becomes refundable — regardless of which side the
// user is on. Used by the match card's revoked-path visibility rule:
// a maker still expects a refund only after the taker's lockTime has
// expired, so the gate depends on the taker's clock, not the user's.
export function takerSwapUnlockAtMs (m: Match): number {
  return m.stamp + lockTimeTakerMs
}

// swapUnlockFill returns the fill percentage (0-100) for the
// "Your Swap → Swap Unlock" connector — how much of the lockTime has
// elapsed since m.stamp. Caller passes `now` so the lane can tick
// without this helper grabbing its own Date.now() and skewing tests.
export function swapUnlockFill (m: Match, now: number): number {
  const lock = swapLockTimeMs(m)
  if (lock <= 0) return 100
  const elapsed = now - m.stamp
  return Math.max(0, Math.min(100, (elapsed / lock) * 100))
}

// refundConnectorFill returns the fill percentage (0-100) for the
// "Swap Unlock → Refund" connector — confirmations on the broadcast
// refund coin (0% when no refund has been broadcast yet).
export function refundConnectorFill (m: Match): number {
  return coinConfsFill(m.refund)
}

// refundPathInvalidated reports whether the refund path is known to
// be dead independently of lockTime — specifically once Maker Redeem
// has been observed on-chain. Maker Redeem spends the taker's swap
// AND reveals the atomic-swap secret publicly; from that moment
// neither side has a reason to refund: the taker's swap is gone, and
// the maker is committed (taker will redeem maker's swap shortly
// using the revealed secret). Perspective-neutral — `makerRedeemCoin`
// is `m.redeem` for the maker (Your Redeem) and `m.counterRedeem`
// for the taker (Their Redeem).
export function refundPathInvalidated (m: Match): boolean {
  return Boolean(makerRedeemCoin(m))
}

// swapUnlockDotPaint resolves the Swap Unlock dot's color.
//  - Visually terminal: 'good' on the refund path, 'neutral' on the
//    happy path.
//  - Active with refund path still live: 'warning' once lockTime has
//    fully elapsed (user COULD refund); 'neutral' before then.
//    Before lockTime expires the partial warning fill on the incoming
//    connector still communicates that the countdown is running.
//  - Active with refund path invalidated (Maker Redeem observed):
//    'neutral' — the refund branch is dead even though the lane
//    is still active.
export function swapUnlockDotPaint (m: Match, now: number): StagePaint {
  if (matchVisuallyTerminal(m)) return matchRefundPathTaken(m) ? 'good' : 'neutral'
  if (refundPathInvalidated(m)) return 'neutral'
  return swapUnlockFill(m, now) >= 100 ? 'warning' : 'neutral'
}

// refundDotPaint resolves the Refund dot's color.
//  - Visually terminal: 'good' on the refund path, 'neutral' on the
//    happy path.
//  - Active with refund path still live: 'warning' only once the
//    refund tx has reached full confirmations; before then the
//    partial incoming connector communicates the progress.
//  - Active with refund path invalidated: 'neutral'.
export function refundDotPaint (m: Match): StagePaint {
  if (matchVisuallyTerminal(m)) return matchRefundPathTaken(m) ? 'good' : 'neutral'
  if (refundPathInvalidated(m)) return 'neutral'
  return refundConnectorFill(m) >= 100 ? 'warning' : 'neutral'
}

// refundTrackConnectorPaint returns the color of the two refund-track
// connectors (Your Swap → Swap Unlock and Swap Unlock → Refund).
// Visually terminal lanes paint 'good' on the refund path or
// 'neutral' on the happy path. Active lanes paint 'warning' — unless
// the refund path has been invalidated by Maker Redeem, in which
// case the whole divert flips to 'neutral' while the lane is still
// active. The rule is the same for both connectors so they share a
// helper.
export function refundTrackConnectorPaint (m: Match): StagePaint {
  if (matchVisuallyTerminal(m)) return matchRefundPathTaken(m) ? 'good' : 'neutral'
  if (refundPathInvalidated(m)) return 'neutral'
  return 'warning'
}

// --------------------------------------------------------------------
// Coin resolution (perspective-neutral)
// --------------------------------------------------------------------

// Maker/taker swap/redeem coin resolution — these are perspective-
// neutral (always the maker's swap coin, always the taker's redeem
// coin, etc.) regardless of whether the user is the maker or taker
// on this match. `m.swap` / `m.redeem` are the user's own actions
// and `m.counterSwap` / `m.counterRedeem` are the counterparty's.

export function makerSwapCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker ? m.swap : m.counterSwap
}

export function takerSwapCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker ? m.counterSwap : m.swap
}

export function makerRedeemCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker ? m.redeem : m.counterRedeem
}

export function takerRedeemCoin (m: Match): Coin | undefined {
  return m.side === MatchSideMaker ? m.counterRedeem : m.redeem
}

// matchStageHrefs returns a per-match array of explorer URLs (or
// undefined) in the same order as `matchStageLabels` — 4 entries for
// a maker lane, 5 for a taker. Stage 0 (Match) has no on-chain coin
// and is never linkable; each later stage's href is the coin whose
// confirmations drive the connector INTO that stage — i.e. the same
// tx `matchConnectorTxCoin(m, i - 1)` resolves for the fill. This
// keeps the "clickable coin per stage" and "confs-filled connector
// per transition" concerns on a single source of truth.
export function matchStageHrefs (m: Match, net: number): (string | undefined)[] {
  return Array.from({ length: matchStageCount(m) }, (_, i) =>
    i === 0 ? undefined : coinExplorerURL(matchConnectorTxCoin(m, i - 1), net)
  )
}

// StageCoinView is the per-stage view-model the match lane hands to
// its coin buttons: which half of the caller's from/to (user's
// outgoing vs. incoming asset) to display, plus the UI sentiment —
// 'bad' for user-sends (colored debit, "-" prefix), 'good' for
// user-receives (colored credit, "+" prefix), 'neutral' for the
// counterparty's own actions (observed, no prefix). The mapping is
// perspective-aware — "Your Swap" is stage 1 for a maker and stage 2
// for a taker, but its side+sentiment (from, bad) is the same
// regardless of where in the five-stage lane it falls.
export type StageCoinView = {
  side: 'from' | 'to',
  sentiment: 'good' | 'bad' | 'neutral',
}

// matchStageCoinViews returns a per-match array of view-models (or
// undefined) paired with `matchStageHrefs` — the caller combines each
// (href, view) with their own `{from, to}` amounts to produce per-
// stage coin buttons.
//   Your Swap    → from, bad     (user sends)
//   Their Swap   → to, neutral   (counterparty sends; user observes)
//   Your Redeem  → to, good      (user receives)
//   Their Redeem → from, neutral (counterparty receives; user observes)
// Length tracks `matchStageLabels` — 4 for a maker, 5 for a taker.
export function matchStageCoinViews (m: Match): (StageCoinView | undefined)[] {
  if (m.side === MatchSideMaker) {
    return [
      undefined,                                  // Match
      { side: 'from', sentiment: 'bad' },         // Your Swap
      { side: 'to', sentiment: 'neutral' },       // Their Swap
      { side: 'to', sentiment: 'good' },          // Your Redeem
    ]
  }
  return [
    undefined,                                    // Match
    { side: 'to', sentiment: 'neutral' },         // Their Swap
    { side: 'from', sentiment: 'bad' },           // Your Swap
    { side: 'from', sentiment: 'neutral' },       // Their Redeem
    { side: 'to', sentiment: 'good' },            // Your Redeem
  ]
}
