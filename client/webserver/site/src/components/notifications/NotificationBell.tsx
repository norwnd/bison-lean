import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { IGNORE, severityClass } from '../../services/notifier'
import type { CoreNote } from '../../stores/types'
import { RichNote } from './RichNote'

// formatAge renders an ms duration with at most two significant chunks
// (year/month/day/hour/minute/second). Mirrors dev2 `Doc.formatDuration`
// (see `js/doc.ts` L737): months and minutes both render as "m" - the
// adjacent chunk disambiguates ("5m 14d" → 5 months 14 days; "1h 5m" →
// 1 hour 5 minutes). Single-digit values get a leading space so adjacent
// rows in the bell line up in monospace contexts (the `.note-time`
// column in the dropdown).
function formatAge (durationMs: number): string {
  let r = Math.max(0, Math.floor(durationMs))
  let result = ''
  let chunks = 0
  const add = (n: number, unit: string): boolean => {
    if (n === 0 && chunks === 0) return false
    chunks++
    let chunk = `${n}${unit} `
    if (n < 10) chunk = ' ' + chunk
    result += chunk
    return chunks >= 2
  }
  const take = (m: number): number => {
    const v = Math.floor(r / m)
    r -= v * m
    return v
  }

  if (add(take(31536000000), 'y')) return result.trimEnd()
  if (add(take(2592000000), 'm')) return result.trimEnd()  // months
  if (add(take(86400000), 'd')) return result.trimEnd()
  if (add(take(3600000), 'h')) return result.trimEnd()
  if (add(take(60000), 'm')) return result.trimEnd()  // minutes
  add(take(1000), 's')
  return result.trimEnd() || '0s'
}

// computeRightOffset anchors the dropdown's right edge to the bell
// button's right edge so the bell + the hamburger to its right stay
// visible (the dropdown's close icon then sits roughly where the bell
// was, so the bell visually transforms into the close button instead
// of jumping to the viewport edge). Returns an empty object on mobile
// - the SCSS media query takes over there.
function computeRightOffset (bell: HTMLElement | null): React.CSSProperties {
  if (!bell || window.innerWidth < 576) return {}
  const rect = bell.getBoundingClientRect()
  return { right: `${Math.max(0, window.innerWidth - rect.right)}px` }
}

export function NotificationBell () {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const notes = useNotificationStore(s => s.notes)
  const pokes = useNotificationStore(s => s.pokes)
  const ackNotes = useNotificationStore(s => s.ackNotes)
  const setBellOpen = useNotificationStore(s => s.setBellOpen)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'notes' | 'pokes'>('notes')
  const [pos, setPos] = useState<React.CSSProperties>({})
  const bellRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // Badge derives from unacked notes only (POKEs aren't counted - they
  // have no server-side ack and live in the "Recent Activity" tab where
  // dev2 doesn't surface a badge for them either).
  const { unread, maxSeverity } = useMemo(() => {
    let unread = 0
    let max = IGNORE
    for (const n of notes) {
      if (!n.acked) {
        unread++
        if (n.severity > max) max = n.severity
      }
    }
    return { unread, maxSeverity: max }
  }, [notes])

  // Hide the badge while the dropdown is open - dev2 hides #noteIndicator
  // on bell click and re-hides after ack on close, so the user never sees
  // a count rise back up while reading the panel.
  const showBadge = !open && unread > 0

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  const handleOpen = useCallback(() => {
    setTab('notes')
    setPos(computeRightOffset(bellRef.current))
    setOpen(true)
    ackNotes()
  }, [ackNotes])

  // Outside-click dismiss. Defer attaching the listener to the next tick
  // so the click that opened the bell doesn't immediately close it.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (boxRef.current && boxRef.current.contains(target)) return
      if (bellRef.current && bellRef.current.contains(target)) return
      handleClose()
    }
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onMouseDown)
    }, 0)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open, handleClose])

  // Recompute the bell-anchored right offset on resize while open.
  useEffect(() => {
    if (!open) return
    const onResize = () => setPos(computeRightOffset(bellRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // Close the dropdown on SPA navigation. In dev2 the page reload
  // destroyed the dropdown DOM; in React, the layout (and the open
  // state) persists, so an in-dropdown order/coin link click leaves a
  // stale dropdown overlaid on the next page.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Mirror `open` into the store so notify() can auto-ack notes
  // arriving while the dropdown is visible. Cleanup forces it false
  // on unmount (e.g. logout tears down the layout) so a stale
  // bellOpen=true doesn't auto-ack on a fresh login.
  useEffect(() => {
    setBellOpen(open)
    return () => setBellOpen(false)
  }, [open, setBellOpen])

  return (
    <>
      <div
        id="noteBell"
        ref={bellRef}
        className="header-btn position-relative"
        onClick={open ? handleClose : handleOpen}
      >
        <span className="ico-bell fs20" />
        {showBadge && (
          <div id="noteIndicator" className={severityClass(maxSeverity)}>
            {unread > 99 ? '99+' : String(unread)}
          </div>
        )}
      </div>

      {open && (
        <div id="noteBox" ref={boxRef} style={pos}>
          <div
            className="icon fs20 ico-bell p-1 pointer"
            id="innerNoteIcon"
            onClick={handleClose}
          />
          <div className="header d-flex align-items-center justify-content-start fs17 demi px-3">
            <div
              id="noteCat"
              className={`me-3${tab === 'notes' ? ' active' : ''}`}
              onClick={() => setTab('notes')}
            >
              {t('Notifications')}
            </div>
            <div
              id="pokeCat"
              className={tab === 'pokes' ? 'active' : ''}
              onClick={() => setTab('pokes')}
            >
              {t('Recent Activity')}
            </div>
          </div>
          {tab === 'notes'
            ? <NotesList notes={notes} t={t} />
            : <PokesList pokes={pokes} t={t} />}
        </div>
      )}
    </>
  )
}

function NotesList ({ notes, t }: { notes: CoreNote[]; t: (k: string) => string }) {
  if (notes.length === 0) {
    return (
      <div id="noteList" className="flex-grow-1 stylish-overflow">
        <div className="p-3 text-center fs15 grey">{t('No notifications')}</div>
      </div>
    )
  }
  return (
    <div id="noteList" className="flex-grow-1 stylish-overflow">
      {notes.map((n, i) => (
        // `.note-time` is absolute-positioned at the note's top-right
        // (see `#noteBox div.note .note-time` in main.scss); kept as a
        // sibling of the content rows rather than inside the flex row
        // so wrapped subject/details can't collide with it. `p-*` Bootstrap
        // utilities are intentionally NOT used here - they're `!important`
        // and would override the right-gutter padding the absolute time
        // depends on; padding is set in the `#noteBox div.note` SCSS rule.
        <div key={`${n.id || i}-${n.stamp}`} className={`note${n.acked ? '' : ' firstview'}`}>
          <span className="note-time">{formatAge(Date.now() - n.stamp)}</span>
          <div className="d-flex align-items-center">
            <div className={`note-indicator d-inline-block me-2 ${severityClass(n.severity)}`} />
            <div className="note-subject flex-grow-1 d-inline-block fs16 demi">{n.subject}</div>
          </div>
          <div className="note-details fs15"><RichNote details={n.details} /></div>
        </div>
      ))}
    </div>
  )
}

function PokesList ({ pokes, t }: { pokes: CoreNote[]; t: (k: string) => string }) {
  if (pokes.length === 0) {
    return (
      <div id="pokeList" className="flex-grow-1 stylish-overflow">
        <div className="p-3 text-center fs15 grey">{t('NO_RECENT_ACTIVITY')}</div>
      </div>
    )
  }
  return (
    <div id="pokeList" className="flex-grow-1 stylish-overflow">
      {pokes.map((p, i) => (
        // No `.p-*` Bootstrap classes - see comment in NotesList. Padding
        // is owned by the `#noteBox div.note` SCSS rule so the right
        // gutter (where `.note-time` sits absolute) isn't overridden.
        <div key={`${p.id || i}-${p.stamp}`} className="note fs15">
          <span className="note-time">{formatAge(Date.now() - p.stamp)}</span>
          <div>
            <span>{p.subject}:</span> <RichNote details={p.details} />
          </div>
        </div>
      ))}
    </div>
  )
}
