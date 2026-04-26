import type { TFunction } from 'i18next'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { WARNING } from '../../services/notifier'
import type { AutoBumpCappedNote, CoreNote } from '../../stores/types'
import { txTypeLabel } from './actionRequiredUtils'

// handleAutoBumpCapped synthesizes a high-severity CoreNote from the
// wallet's `autoBumpCapped` data note (route="autoBumpCapped" on the
// walletnote channel) and pushes it through the notification store.
// The data note arrives at severity=DATA which the store filters out
// of the popup queue; promoting it to WARNING is what the user
// actually wants — the wallet has stopped auto-bumping a stuck
// Redeem/Refund and now needs manual review.
//
// The wallet emits this at most once per slot (slot.autoBumpCapNoticed
// latches), so duplicate suppression isn't needed here.
export function handleAutoBumpCapped (
  payload: AutoBumpCappedNote,
  assetID: number,
  assetName: string,
  t: TFunction
): void {
  const subject = t('AUTO_BUMP_CAPPED_SUBJECT', {
    asset: assetName,
    type: txTypeLabel(t, payload.type),
  })
  const details = t('AUTO_BUMP_CAPPED_DETAILS', {
    feeCapGwei: payload.feeCapGwei,
    capGwei: payload.capGwei,
    nonce: payload.nonce,
  })
  const synthetic: CoreNote = {
    type: 'autoBumpCapped',
    topic: 'autoBumpCapped',
    subject,
    details,
    severity: WARNING,
    stamp: Date.now(),
    acked: false,
    id: `autoBumpCapped_${assetID}_${payload.nonce}`,
  }
  useNotificationStore.getState().notify(synthetic)
}
