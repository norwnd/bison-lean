import { useEffect, useCallback, useRef } from 'react'

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

  return (
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
    </div>
  )
}
