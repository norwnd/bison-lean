import { useTranslation } from 'react-i18next'
import { FormOverlay } from '../common/FormOverlay'
import { postTakeAction } from '../../services/api'
import { useActionRequiredStore } from '../../stores/useActionRequiredStore'
import { TooCheapDialog } from './TooCheapDialog'
import { MissingNoncesDialog } from './MissingNoncesDialog'
import type { TransactionActionNote } from '../../stores/types'

// Action-ID constants — keep in sync with `actionType*` in
// client/asset/eth/eth.go. The Go side is the source of truth; if a new
// action type is added there, mirror it here and add a dispatch arm
// below.
export const ActionTypeTooCheap = 'tooCheap'
export const ActionTypeMissingNonces = 'missingNonces'

// ActionRequiredDialog is the single global mount point for all
// action-required prompts. It renders the head of the
// useActionRequiredStore queue as a modal; once that note is removed
// (via the wallet's actionResolved emission, the user clicking Close,
// or a successful TakeAction RPC), the next queued note pops up.
//
// One-at-a-time semantics keep the user from having to reason about
// stacked dialogs — the wallet itself only emits at most one
// actionrequired per tx slot per `txActionPromptFrequency`, so the
// queue typically holds zero or one entries; multi-asset wallets can
// see a brief burst at startup if several wallets each had a stale
// action carried in `User.actions[]`.
export function ActionRequiredDialog () {
  const { t } = useTranslation()
  const queue = useActionRequiredStore(s => s.queue)
  const resolve = useActionRequiredStore(s => s.resolve)

  const head = queue[0]
  if (!head) return null

  // dismiss is invoked when the user closes the modal via Escape or
  // backdrop click without explicitly choosing an in-dialog button.
  //
  // Naïve dismissal (just removing from the local queue) is destructive
  // for tooCheap: the wallet's per-candidate `actionRequested` flag
  // would stay true server-side, and maybePromptHead's
  // `slot.anyActionRequested()` short-circuit would suppress all future
  // re-emissions for that slot. Fire-and-forget the equivalent of the
  // dialog's "Wait" button server-side so the flag clears, the cooldown
  // resets, and the prompt can re-fire later if the underlying
  // condition still holds. The wallet's actionResolved emission will
  // arrive shortly and remove the head from the store; we also remove
  // eagerly so the UI doesn't lag.
  //
  // missingNonces doesn't use actionRequested (it uses
  // recoveryRequestSent which latches until restart), so a UI-only
  // dismiss is harmless there.
  const dismiss = () => {
    const fire = (action: any) => {
      // Fire-and-forget — failures are logged and don't block the
      // local UI dismiss. The wallet's actionResolved emission will
      // also arrive shortly via the websocket and clean up.
      postTakeAction(head.assetID, head.actionID, action).catch(err => {
        console.error('action dismiss request failed:', err)
      })
    }
    switch (head.actionID) {
      case ActionTypeTooCheap: {
        const tx = (head.payload as TransactionActionNote).tx
        fire({ txID: tx.id, bump: false })
        break
      }
    }
    resolve(head.uniqueID)
  }

  let body: React.ReactNode
  switch (head.actionID) {
    case ActionTypeTooCheap:
      body = <TooCheapDialog note={head} />
      break
    case ActionTypeMissingNonces:
      body = <MissingNoncesDialog note={head} />
      break
    default:
      // Unknown action type — render a minimal fallback so the user can
      // dismiss it rather than getting stuck on a blank modal.
      body = (
        <div style={{ minWidth: 320 }}>
          <div className="fs20 mb-3">{t('UNKNOWN_ACTION_TITLE')}</div>
          <p className="fs14">{t('UNKNOWN_ACTION_BODY', { actionID: head.actionID })}</p>
        </div>
      )
  }

  return (
    <FormOverlay show={true} onClose={dismiss}>
      {body}
    </FormOverlay>
  )
}
