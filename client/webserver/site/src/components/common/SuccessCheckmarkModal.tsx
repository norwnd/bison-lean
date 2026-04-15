import { useEffect } from 'react'
import { FormOverlay } from './FormOverlay'

// SuccessCheckmarkModal is the animated success-checkmark overlay shared
// across pages. Mirrors vanilla `forms.ts` `showSuccess()` /
// `animateCheckmark()` (L2279-2298) and the `#checkmarkForm` HTML block
// shared by vanilla's `proposal.tmpl`, `dexsettings.tmpl`, and
// `wallets.tmpl`:
//
//   <form id="checkmarkForm" class="flex-center flex-column plain">
//     <div id="checkmarkBox" class="flex-center">
//       <span class="ico-check" id="checkmark"></span>
//     </div>
//     <div id="successMessage" class="fs22"></div>
//   </form>
//
// Vanilla's animation drives `checkmark.style.fontSize` from 0 → 80px and
// `checkmark.style.color` from the body text color to green (#10a310) over
// 1200ms with easeOutElastic, then waits 1500ms before closing — 2700ms
// total. The CSS approximation below uses a keyframe sequence with
// overshoot+pullback steps to evoke the elastic bounce without a JS
// animation loop, and the auto-close timer fires onClose after 2700ms to
// match vanilla's total duration.
//
// Because `FormOverlay` unmounts its children when `show` flips false, the
// CSS animation replays fresh every time the modal is re-opened without
// needing a `key` prop dance.
//
// Closes PP-01 (ProposalPage vote success) and DSP-04 (DexSettingsPage
// trading-tier updated) with one shared implementation.

interface Props {
  show: boolean
  message: string
  onClose: () => void
}

// Total duration: 1200ms animation + 1500ms hold — matches vanilla
// `animateCheckmark` (1200ms) + the subsequent pause in the `showSuccess`
// call sites at `proposal.ts` L84-89 and `dexsettings.ts` L119.
const CHECKMARK_ANIMATION_MS = 1200
const CHECKMARK_HOLD_MS = 1500
const CHECKMARK_TOTAL_MS = CHECKMARK_ANIMATION_MS + CHECKMARK_HOLD_MS

export function SuccessCheckmarkModal ({ show, message, onClose }: Props) {
  useEffect(() => {
    if (!show) return
    const timer = setTimeout(() => onClose(), CHECKMARK_TOTAL_MS)
    return () => clearTimeout(timer)
  }, [show, onClose])

  return (
    <FormOverlay show={show} onClose={onClose}>
      <div className="flex-center flex-column plain p-4">
        <div className="success-checkmark-box flex-center">
          <span className="ico-check success-checkmark"></span>
        </div>
        <div className="fs22 text-center">{message}</div>
      </div>
    </FormOverlay>
  )
}
