import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postTakeAction, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { txTypeLabel, shortHash } from './actionRequiredUtils'
import type { ActionRequiredNote, TransactionActionNote } from '../../stores/types'

interface Props {
  note: ActionRequiredNote
}

// LostNonceDialog handles the actionTypeLostNonce prompt: the chain
// either advanced past this nonce without our tx mining (so an external
// tx took it), or our tx has been absent from mempool long enough that
// the wallet treats it as dropped. The user picks Drop (mark as lost in
// local tracking — no on-chain action; appropriate when the chain has
// already accepted a different tx at this nonce), Provide replacement
// (supply the external tx hash to link our records to it), or Wait
// (reset the prompt cooldown).
export function LostNonceDialog ({ note }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replacementID, setReplacementID] = useState('')

  const payload = note.payload as TransactionActionNote
  const tx = payload.tx
  const asset = assets[note.assetID]
  const assetName = asset?.name || `asset ${note.assetID}`

  const submit = async (label: string, action: any) => {
    setSubmitting(label)
    setError(null)
    const resp = await postTakeAction(note.assetID, note.actionID, action)
    setSubmitting(null)
    if (!checkResponse(resp)) {
      setError(resp.msg || t('ACTION_REQUEST_FAILED'))
    }
  }

  const linkDisabled = submitting !== null || replacementID.trim().length < 10

  return (
    <div style={{ minWidth: 380, maxWidth: 520 }}>
      <div className="fs20 mb-3">{t('LOST_NONCE_TITLE')}</div>
      <p className="fs14">
        {t('LOST_NONCE_BODY', { asset: assetName, type: txTypeLabel(t, tx.type) })}
      </p>
      <div className="fs13 mb-3" style={{ wordBreak: 'break-all' }}>
        <div><strong>{t('TX_HASH')}:</strong> {tx.id}</div>
        {payload.nonce !== undefined && (
          <div><strong>{t('NONCE')}:</strong> {payload.nonce}</div>
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
                {txTypeLabel(t, b.type)} — <code>{shortHash(b.id)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="fs13 mb-3">
        <label className="form-label">{t('LOST_NONCE_REPLACEMENT_LABEL')}</label>
        <input
          type="text"
          className="form-control"
          placeholder="0x..."
          value={replacementID}
          onChange={e => setReplacementID(e.target.value)}
          disabled={submitting !== null}
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
        />
      </div>

      {error && <div className="fs13 mb-2 text-danger">{error}</div>}

      <div className="d-flex gap-2 flex-wrap">
        <button
          className="btn btn-primary"
          disabled={linkDisabled}
          onClick={() => submit('link', { txID: tx.id, abandon: false, replacementID: replacementID.trim() })}
        >
          {submitting === 'link' ? t('SUBMITTING') : t('LINK_REPLACEMENT')}
        </button>
        <button
          className="btn btn-warning"
          disabled={submitting !== null}
          onClick={() => submit('drop', { txID: tx.id, abandon: true })}
        >
          {submitting === 'drop' ? t('SUBMITTING') : t('DROP_FROM_TRACKING')}
        </button>
        <button
          className="btn btn-secondary"
          disabled={submitting !== null}
          onClick={() => submit('wait', { txID: tx.id, abandon: false })}
        >
          {submitting === 'wait' ? t('SUBMITTING') : t('WAIT')}
        </button>
      </div>
    </div>
  )
}
