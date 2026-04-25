import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postTakeAction, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { ActionRequiredNote } from '../../stores/types'

interface Props {
  note: ActionRequiredNote
}

// MissingNoncesDialog handles actionTypeMissingNonces: the wallet has
// detected a gap between its confirmed and pending nonce that none of
// its tracked txs cover (i.e. someone or something consumed nonces
// outside of our visibility, OR our records lost some). The user picks
// Recover (broadcast 0-value self-sends to fill the gap so subsequent
// txs can mine) or Ignore (acknowledge once; the prompt won't re-fire
// until the next wallet restart).
export function MissingNoncesDialog ({ note }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div style={{ minWidth: 380, maxWidth: 520 }}>
      <div className="fs20 mb-3">{t('MISSING_NONCES_TITLE')}</div>
      <p className="fs14">{t('MISSING_NONCES_BODY', { asset: assetName })}</p>
      <p className="fs13 mb-3 text-secondary">{t('MISSING_NONCES_RECOVER_HINT')}</p>

      {error && <div className="fs13 mb-2 text-danger">{error}</div>}

      <div className="d-flex gap-2 flex-wrap">
        <button
          className="btn btn-primary"
          disabled={submitting !== null}
          onClick={() => submit('recover', { recover: true })}
        >
          {submitting === 'recover' ? t('SUBMITTING') : t('RECOVER_NONCES')}
        </button>
        <button
          className="btn btn-secondary"
          disabled={submitting !== null}
          onClick={() => submit('ignore', { recover: false })}
        >
          {submitting === 'ignore' ? t('SUBMITTING') : t('IGNORE')}
        </button>
      </div>
    </div>
  )
}
