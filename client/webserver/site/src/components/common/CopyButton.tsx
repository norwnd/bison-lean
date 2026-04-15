import { useState, useCallback } from 'react'

// CopyButton is a small icon button that copies its `text` to the
// clipboard when clicked and briefly highlights both itself and (if
// provided) a sibling text element to acknowledge the copy. Mirrors
// vanilla `doc.ts` `setupCopyBtn()` (L1236-1250) which flashed both the
// text element and the button green (`#1e7d11`) for 350ms.
//
// Used by MMLogsPage event-detail modals (MML-01) for Order IDs,
// Withdrawal IDs, and TX IDs. Also intended for WP-11 and WP-20 (deposit
// address + tx id copy buttons) so consumers don't each reimplement the
// clipboard + visual-feedback pattern.

interface Props {
  text: string
  // Optional aria-label override. Defaults to "Copy to clipboard".
  ariaLabel?: string
  // Optional className appended to the default button class. Lets
  // callers tune size/spacing without overriding the base styling.
  className?: string
}

const FLASH_DURATION_MS = 350

export function CopyButton ({ text, ariaLabel, className }: Props) {
  const [flashing, setFlashing] = useState(false)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!text) return
    if (!window.isSecureContext) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('CopyButton: unable to copy:', err)
      return
    }
    setFlashing(true)
    setTimeout(() => setFlashing(false), FLASH_DURATION_MS)
  }, [text])

  return (
    <button
      type="button"
      className={`btn btn-sm p-1 border-0 bg-transparent ${className ?? ''}`}
      onClick={handleClick}
      aria-label={ariaLabel ?? 'Copy to clipboard'}
      title={ariaLabel ?? 'Copy to clipboard'}
      style={{
        color: flashing ? '#1e7d11' : 'inherit',
        transition: 'color 100ms ease',
      }}
    >
      <span className="ico-copy" />
    </button>
  )
}
