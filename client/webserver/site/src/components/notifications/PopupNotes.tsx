import { useNotificationStore } from '../../stores/useNotificationStore'
import { POKE, severityClass, plainNote } from '../../services/notifier'

// PopupNotes renders the transient bottom-right notification toasts.
// Items are enqueued from `useNotificationStore.notify()` (gated by the
// "Show pop-up notifications" setting) and auto-removed after 6 seconds
// via the store's `removePopup`. Mirrors dev2 `app.ts notify()` (L1275).
//
// The fade-out is handled by a CSS keyframe animation applied to each
// span (see `main.scss .popup-notes > span`); the store's 6s setTimeout
// keeps timing consistent with the animation's 6s duration.
export function PopupNotes () {
  const queue = useNotificationStore(s => s.popupQueue)
  if (queue.length === 0) return null
  return (
    <div id="popupNotes" className="popup-notes">
      {queue.map(({ id, note }) => {
        const showIndicator = note.severity > POKE
        return (
          <span key={id} className="fs15">
            <div
              className={`note-indicator d-inline-block ${showIndicator ? severityClass(note.severity) : 'd-hide'}`}
            />
            <span>{note.subject}: {plainNote(note.details)}</span>
          </span>
        )
      })}
    </div>
  )
}
