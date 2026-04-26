import type { TFunction } from 'i18next'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { WARNING, ERROR } from '../../services/notifier'
import type { LostNonceNote, CoreNote } from '../../stores/types'

// handleLostNonce synthesizes a high-severity CoreNote from the wallet's
// `lostNonce` data note (route="lostNonce" on the walletnote channel) and
// pushes it through the notification store.
//
// Lost-nonce events are unusual under the assumption that this wallet's
// key is not in use elsewhere — they may indicate key compromise. The
// note is promoted to ERROR severity when the probe found the operation
// already achieved on-chain (the external tx successfully completed our
// intent — strongest signal that someone else is using our key) and
// WARNING otherwise. The wallet emits this at most once per slot
// (lostNonceNotified latches), so duplicate suppression isn't needed.
export function handleLostNonce (
  payload: LostNonceNote,
  assetID: number,
  assetName: string,
  network: string,
  t: TFunction
): void {
  const subject = t('LOST_NONCE_NOTE_SUBJECT', {
    asset: assetName,
    network,
    nonce: payload.nonce,
  })
  const severity = payload.probeResult === 'achieved' ? ERROR : WARNING
  const synthetic: CoreNote = {
    type: 'lostNonce',
    topic: 'lostNonce',
    subject,
    details: payload.reason,
    severity,
    stamp: Date.now(),
    acked: false,
    id: `lostNonce_${assetID}_${payload.nonce}`,
  }
  useNotificationStore.getState().notify(synthetic)
}
