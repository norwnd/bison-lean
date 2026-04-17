// Portal-based tooltip ported from vanilla
// `mmsettings/components/Tooltip.tsx`.
//
// Wraps a single child element, attaches hover listeners, and portals
// the tooltip body into `document.body` so it is not clipped by any
// overflow: hidden ancestor (mmsettings has several). Position is
// computed in viewport coordinates at hover time.

import React from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: string
  children: React.ReactElement
}

const Tooltip: React.FC<TooltipProps> = ({ content, children }) => {
  const [isVisible, setIsVisible] = React.useState(false)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })
  const triggerRef = React.useRef<HTMLElement>(null)

  const handleShow = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const tooltipWidth = 300
      let left = rect.left + rect.width / 2 - tooltipWidth / 2

      if (left < 5) left = 5
      if (left + tooltipWidth > window.innerWidth) {
        left = window.innerWidth - tooltipWidth - 5
      }

      setPosition({
        top: rect.top - 35,
        left: left
      })
      setIsVisible(true)
    }
  }

  const handleHide = () => {
    setIsVisible(false)
  }

  const childWithHandlers = React.cloneElement(children as React.ReactElement<any>, {
    ref: triggerRef,
    onMouseEnter: handleShow,
    onMouseLeave: handleHide,
    onFocus: handleShow,
    onBlur: handleHide,
    style: { cursor: 'help', ...(children.props?.style || {}) }
  })

  return (
    <>
      {childWithHandlers}
      {isVisible && createPortal(
        <div
          className="tooltip"
          style={{
            position: 'fixed',
            top: `${position.top}px`,
            left: `${position.left}px`,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '5px 8px',
            borderRadius: '4px',
            fontSize: '14px',
            whiteSpace: 'normal',
            zIndex: 9999,
            pointerEvents: 'none',
            maxWidth: '300px',
            wordWrap: 'break-word',
            overflowWrap: 'break-word'
          }}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  )
}

export default Tooltip
