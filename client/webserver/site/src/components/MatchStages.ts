import {
  MatchSideMaker,
  NewlyMatched, MakerSwapCast, TakerSwapCast,
  MakerRedeemed, MatchComplete, MatchConfirmed,
} from '../stores/types'
import type { Coin, Match } from '../stores/types'
import { coinExplorerURL } from './CoinExplorers'

// A match progresses through six discrete UI stages, mapped from the
// protocol-level match statuses (NewlyMatched, MakerSwapCast, ...).
// This module is the canonical place to render match status in the
// UI: stage labels are perspective-aware ("Your" / "Their" based on
// whether the user was the maker or taker on this match), Stage 0 is
// "Match" and Stage 5 is "Completed". The protocol status names
// ("Maker Swap Cast", etc.) stay on the wire; users only care
// whether a step was their action or their counterparty's.
//
// The semantic rule is: a protocol status of N means stage N has been
// *completed* and stage N+1 is the in-progress step (except at the
// final status, where the match is fully done). This differs from the
// order-lane semantics where `StatusEpoch / Booked / Executed` name
// the current phase rather than a completed event.

type TFunc = (k: string, opts?: Record<string, string>) => string

export const MATCH_STAGE_COUNT = 6

// LaneColor classifies an entire lane (match or order) with a single
// outcome-driven color. Individual stages within the lane are either
// painted in that color or left uncolored; no stage-specific colors.
//   'warning' — still in progress (active)
//   'good'    — terminal, happy-path completion
//   'bad'     — terminal, ended in refund (matches only)
//   'neutral' — terminal, nothing happened (orders with no matches)
export type LaneColor = 'good' | 'warning' | 'bad' | 'neutral'

const STATUS_TO_DONE_STAGE_IDX: Record<number, number> = {
  [NewlyMatched]: 0,
  [MakerSwapCast]: 1,
  [TakerSwapCast]: 2,
  [MakerRedeemed]: 3,
  [MatchComplete]: 4,
  [MatchConfirmed]: 5,
}

// matchStageLabels returns the six stage labels for a match, ordered
// left-to-right along the lifecycle.
export function matchStageLabels (m: Match, t: TFunc): string[] {
  const isMaker = m.side === MatchSideMaker
  return [
    t('Match'),
    isMaker ? t('Your Swap') : t('Their Swap'),
    isMaker ? t('Their Swap') : t('Your Swap'),
    isMaker ? t('Your Redeem') : t('Their Redeem'),
    isMaker ? t('Their Redeem') : t('Your Redeem'),
    t('Completed'),
  ]
}

// matchDoneStageIdx returns the index of the last completed stage.
// `status == MakerRedeemed` (3), from the user's perspective, means
// "Your/Their Redeem" just happened — i.e. stage 3 is done and stage
// 4 is the next one in progress.
export function matchDoneStageIdx (m: Match): number {
  return STATUS_TO_DONE_STAGE_IDX[m.status] ?? 0
}

// matchCurStageIdx returns the index of the in-progress stage — the
// one the UI should highlight and under which the mini card should
// sit. Collapses to doneIdx when the match has reached the final
// Completed stage.
export function matchCurStageIdx (m: Match): number {
  const done = matchDoneStageIdx(m)
  return Math.min(done + 1, MATCH_STAGE_COUNT - 1)
}

// matchLaneColor returns the single color that the entire match lane
// is rendered in. Active matches are warning-colored regardless of
// revocation; terminal matches are bad (refunded) or good (redeemed).
export function matchLaneColor (m: Match): LaneColor {
  if (m.active) return 'warning'
  if (m.refund) return 'bad'
  return 'good'
}

// matchStageColored returns whether a single stage of the six-stage
// happy-path lane should be painted in the lane color.
// - Active matches color up through the current in-progress stage,
//   regardless of revocation — the revoked-and-still-in-flight case
//   is still warning-colored through the next pending action.
// - Terminal matches color every stage.
export function matchStageColored (m: Match, stageIdx: number): boolean {
  if (!m.active) return true
  return stageIdx <= matchCurStageIdx(m)
}

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

// matchStageHrefs returns a `MATCH_STAGE_COUNT`-length array of
// explorer URLs (or undefined) in the same order as
// `matchStageLabels`. Stages 0 (Match) and 5 (Completed) are never
// linkable; 1–4 point at the maker/taker swap/redeem coins as they
// come on-chain. Keeping this beside `matchStageLabels` ensures the
// two arrays stay the same length and stay semantically aligned if
// the stage list ever changes.
export function matchStageHrefs (m: Match, net: number): (string | undefined)[] {
  return [
    undefined,
    coinExplorerURL(makerSwapCoin(m), net),
    coinExplorerURL(takerSwapCoin(m), net),
    coinExplorerURL(makerRedeemCoin(m), net),
    coinExplorerURL(takerRedeemCoin(m), net),
    undefined,
  ]
}
