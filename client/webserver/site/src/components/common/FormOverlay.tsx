import { useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  show: boolean
  onClose: () => void
  children: React.ReactNode
}

export function FormOverlay ({ show, onClose, children }: Props) {
  const formRef = useRef<HTMLDivElement>(null)

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    if (show) {
      document.addEventListener('keyup', handleKeyUp)
    }
    return () => {
      document.removeEventListener('keyup', handleKeyUp)
    }
  }, [show, handleKeyUp])

  const handleBackdropMouseDown = useCallback((e: React.MouseEvent) => {
    if (formRef.current && !formRef.current.contains(e.target as Node)) {
      onClose()
    }
  }, [onClose])

  if (!show) return null

  // Portal to body so the overlay is not a layout sibling of whatever
  // parent mounted it. Keeps in-flow positional CSS selectors
  // (:first-child / :last-child) from being displaced by the overlay
  // when it's mounted. NOTE: any page-scoped CSS that targets modal
  // content (e.g. `div[data-handler=markets] #verifyForm ...`) must
  // be rewritten as global; see markets.scss for an example.
  return createPortal(
    <div
      className="form-overlay d-flex align-items-center justify-content-center"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: 1000,
      }}
      onMouseDown={handleBackdropMouseDown}
    >
      <div ref={formRef}>
        {children}
      </div>
    </div>,
    document.body
  )
}
