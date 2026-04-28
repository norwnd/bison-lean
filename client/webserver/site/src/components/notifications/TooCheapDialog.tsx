import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postTakeAction, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { txTypeLabel, shortHash, networkSuffix } from './actionRequiredUtils'
import type { ActionRequiredNote, TransactionActionNote } from '../../stores/types'

interface Props {
  note: ActionRequiredNote
}

// TooCheapDialog handles the actionTypeTooCheap prompt: a wallet tx is
// stuck in mempool with fees below the current network rate. The user
// picks Bump (re-broadcast at the wallet's quoted higher fees), Abandon
// (a 0-value self-send replaces the original at the same nonce), or
// Wait (reset the cooldown timer; the prompt re-fires later if the
// condition persists).
export function TooCheapDialog ({ note }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const payload = note.payload as TransactionActionNote
  const tx = payload.tx
  const asset = assets[note.assetID]
  const assetName = asset?.name || `asset ${note.assetID}`
  const network = networkSuffix(assets, note.assetID, t)

  // submit posts the action and lets the wallet's actionResolved note
  // close the dialog. Errors don't dismiss - surface them inline so the
  // user can retry without losing the prompt.
  const submit = async (label: string, action: any) => {
    setSubmitting(label)
    setError(null)
    const resp = await postTakeAction(note.assetID, note.actionID, action)
    setSubmitting(null)
    if (!checkResponse(resp)) {
      setError(resp.msg || t('ACTION_REQUEST_FAILED'))
    }
  }

  return (
    <div style={{ minWidth: 380, maxWidth: 520 }}>
      <div className="fs20 mb-3">{t('TOO_CHEAP_TITLE')}</div>
      <p className="fs14">
        {t('TOO_CHEAP_BODY', { asset: assetName, network, type: txTypeLabel(t, tx.type) })}
      </p>
      <div className="fs13 mb-3" style={{ wordBreak: 'break-all' }}>
        <div><strong>{t('TX_HASH')}:</strong> {tx.id}</div>
        {payload.nonce !== undefined && (
          <div><strong>{t('NONCE')}:</strong> {payload.nonce}</div>
        )}
        {payload.newFees > 0 && (
          <div><strong>{t('PROPOSED_FEE')}:</strong> {payload.newFees} gwei</div>
        )}
      </div>

      {payload.blocked && payload.blocked.length > 0 && (
        <div className="fs13 mb-3">
          <div className="mb-1">
            <strong>{t('ALSO_BLOCKED', { count: payload.blocked.length })}</strong>
          </div>
          <ul className="mb-0" style={{ paddingLeft: '1.25rem' }}>
            {payload.blocked.map(b => (
              <li key={b.id}>
                {txTypeLabel(t, b.type)} - <code>{shortHash(b.id)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="fs13 mb-2 text-danger">{error}</div>}

      <div className="d-flex gap-2 flex-wrap">
        <button
          className="btn btn-primary"
          disabled={submitting !== null || payload.newFees <= 0}
          onClick={() => submit('bump', { txID: tx.id, bump: true, newFees: payload.newFees })}
        >
          {submitting === 'bump' ? t('SUBMITTING') : t('BUMP_FEES')}
        </button>
        <button
          className="btn btn-warning"
          disabled={submitting !== null}
          onClick={() => submit('abandon', { txID: tx.id, abandon: true })}
        >
          {submitting === 'abandon' ? t('SUBMITTING') : t('ABANDON_TX')}
        </button>
        <button
          className="btn btn-secondary"
          disabled={submitting !== null}
          onClick={() => submit('wait', { txID: tx.id, bump: false })}
        >
          {submitting === 'wait' ? t('SUBMITTING') : t('WAIT')}
        </button>
      </div>
    </div>
  )
}
