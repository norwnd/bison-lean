import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { type OrderSegment } from './OrderProgress'

// OrderProgressBar renders a single-row vessel of clickable colored
// segments, each carrying its percent-of-order as an inline label.
// Segments pack at flex-start and sum to the filled percentage of
// the order (NOT 100%); any remaining width shows the vessel bg
// through, reading as "still has room for more matches". For a
// finalized order (no more matches coming) the remainder is filled
// by a trailing labeled `neutral` segment so the user sees the
// portion that never matched in a solid color rather than an empty
// vessel. Match-backed segments respond to hover (persistent tint
// on the corresponding match lane + a visual bump via `.hovered`)
// and click (scrollIntoView + flash highlight on that match lane);
// the neutral remainder is decorative only — no handlers, but its
// label still reports the unfilled percentage.
//
// Accessibility:
//   * The container carries `role="progressbar"` with
//     `aria-valuenow` / `aria-valuemin` / `aria-valuemax` so assistive
//     tech reads a single-sentence summary of the fill state — users
//     don't have to tab through every segment button to grok the
//     overall picture.
//   * A sibling `visually-hidden` span (linked via `aria-describedby`)
//     adds a richer human-friendly description like "3 match(es),
//     47.2% filled, 52.8% awaiting", branched on active vs finalized
//     vs fully-filled state. Focusing the progressbar hears the name
//     + value + description; linear page reading also surfaces the
//     hidden span's text naturally.
//
// Empty-state copy:
//   * When the order is active and has zero matches (the bar is a
//     single `empty` segment at full width) the inline "0.0%" label
//     is swapped for a friendlier "Waiting for first match…" string.
//     The numeric label carries no information in that case — the
//     vessel IS the zero — so the space is better spent explaining
//     the state to the user. The SR summary still reports "0 match(es),
//     0% filled, 100% awaiting" via the hidden describedby span.
export function OrderProgressBar ({
  segments, hoveredMatchID, onHover, onClick,
}: {
  segments: OrderSegment[],
  hoveredMatchID: string | null,
  onHover: (matchID: string | null) => void,
  onClick: (matchID: string) => void,
}) {
  // `t` is needed only for the per-segment aria-label — pull it
  // here via the hook instead of passing it through props. Keeps
  // the caller's argument list tight.
  const { t } = useTranslation()
  // useId guards against id collisions if the bar is ever rendered
  // twice on a page. The `aria-describedby` pairing needs a stable,
  // unique id per component instance.
  const summaryId = useId()

  // Aggregate stats for the `progressbar` role and the SR summary.
  // `filledPct` sums the match-backed segments only (not the trailing
  // `neutral`/`empty` remainder) so `aria-valuenow` reflects the
  // actual fill. Rounded to one decimal to mirror the visible labels.
  const matchSegments = segments.filter(s => s.matchID)
  const matchCount = matchSegments.length
  const filledPct = matchSegments.reduce((sum, s) => sum + s.widthPct, 0)
  const roundedFilled = Math.round(filledPct * 10) / 10
  const roundedRemainder = Math.round((100 - filledPct) * 10) / 10

  // Branch the summary on the trailing segment type (see OrderProgress.ts):
  //   * no trailing → 100% filled → FILLED
  //   * trailing `empty` → active order with room to fill → ACTIVE
  //   * trailing `neutral` → finalized with unfilled remainder → FINALIZED
  // Three static t() calls (rather than one dynamic t(variable)) keep
  // the i18n-lint allowlist free of this site.
  const hasEmpty = segments.some(s => s.paint === 'empty')
  const hasNeutralRemainder = segments.some(s => s.paint === 'neutral')
  const summaryParams = { matches: matchCount, filled: roundedFilled, remainder: roundedRemainder }
  let summary: string
  if (!hasEmpty && !hasNeutralRemainder) {
    summary = t('ORDER_PROGRESS_SR_FILLED', summaryParams)
  } else if (hasEmpty) {
    summary = t('ORDER_PROGRESS_SR_ACTIVE', summaryParams)
  } else {
    summary = t('ORDER_PROGRESS_SR_FINALIZED', summaryParams)
  }

  // Empty-state shortcut: active order with zero matches renders as
  // a single full-width `empty` segment. Replace the useless "0.0%"
  // label with a human-readable "Waiting for first match…" string.
  // Gated on matchCount===0 so a 100%-empty bar from some future
  // edge case (no matches but orderIsFinalized somehow produced an
  // empty instead of neutral) still reads sensibly — and so that
  // normal multi-segment bars with a trailing empty keep their
  // trailing "0.0%" label (which DOES carry information: remaining
  // capacity not yet matched).
  const isWaitingForFirstMatch = matchCount === 0 && segments.length === 1 && segments[0].paint === 'empty'

  // Colored segments inside the vessel container. Each match-backed
  // segment is a button for native keyboard + pointer semantics;
  // the neutral remainder is a plain div (non-interactive,
  // aria-hidden from screen readers). Both render their percent
  // label as centered text inside the rect — narrow segments clip
  // the label (CSS `overflow: hidden`) and surface the full string
  // via the `title` attribute's native tooltip on hover. Segments
  // pack at flex-start — if they sum to < 100% the vessel's
  // ::before bg shows through on the right.
  return (
    <>
      <span id={summaryId} className="visually-hidden">{summary}</span>
      <div
        className="order-progress-segments"
        role="progressbar"
        aria-valuenow={roundedFilled}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('ORDER_FILL_PROGRESS')}
        aria-describedby={summaryId}
      >
        {segments.map((s) => {
          const matchID = s.matchID
          const waitingLabel = isWaitingForFirstMatch && s.paint === 'empty'
          const labelText = waitingLabel ? t('WAITING_FOR_FIRST_MATCH') : s.pctLabel
          // Wrapping the label in its own span lets `.paint-empty`
          // paint a matching-vessel background on just that span so
          // the dashed line underneath is masked where the "0.0%"
          // text sits. Colored segments don't need the mask but use
          // the same wrapper for a uniform DOM shape.
          const label = <span className="order-progress-segment-label">{labelText}</span>
          if (!matchID) {
            // Stable key so React reuses the same DOM node across
            // renders as the remainder's width shrinks (new matches
            // arrive) or as its paint swaps (active `empty` →
            // finalized `neutral`). Reusing the node lets the base
            // rule's `width 300ms ease-out` transition animate the
            // shrink smoothly — with a per-index key (`remainder-0`
            // → `remainder-1` as a match lands) the old node would
            // unmount and a fresh one would mount at the new width,
            // skipping the transition. There's only ever one
            // remainder segment in `segments` (buildOrderSegments
            // guarantees it), so a single literal key is unique.
            return (
              <div
                key="remainder"
                className={`order-progress-segment paint-${s.paint}`}
                style={{ width: `${s.widthPct}%` }}
                title={labelText}
                aria-hidden="true"
              >
                {label}
              </div>
            )
          }
          const hovered = matchID === hoveredMatchID
          return (
            <button
              key={matchID}
              type="button"
              className={`order-progress-segment paint-${s.paint}${hovered ? ' hovered' : ''}`}
              style={{ width: `${s.widthPct}%` }}
              title={s.pctLabel}
              onMouseEnter={() => onHover(matchID)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(matchID)}
              onBlur={() => onHover(null)}
              onClick={() => onClick(matchID)}
              aria-label={`${t('STAGE_MATCH')} ${s.pctLabel}`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </>
  )
}
