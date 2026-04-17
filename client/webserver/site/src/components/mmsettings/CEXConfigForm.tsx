// CEXConfigForm — modal form for entering CEX API credentials in the
// mmsettings configure-bot flow. Ported from vanilla
// `mmsettings/components/CEXConfigForm.tsx`.
//
// Not to be confused with `components/common/CEXConfigurationForm.tsx`
// which serves the MMPage flow. That one uses the raw /api endpoint
// and a different layout; keeping this as a separate module matches
// vanilla and avoids entangling the two configure flows.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateCEXConfig } from '../../services/mmApi'
import { useMMStore } from '../../stores/useMMStore'
import type { MMCEXStatus } from '../../stores/types'
import { CEXDisplayInfos } from './cexDisplayInfo'

interface CEXConfigFormProps {
  cexName: string
  cexStatus: MMCEXStatus | null
  onClose: () => void
  onCEXUpdated: () => void
}

const CEXConfigForm: React.FC<CEXConfigFormProps> = ({
  cexName,
  onClose,
  cexStatus,
  onCEXUpdated
}) => {
  const { t } = useTranslation()
  const { fetchMMStatus } = useMMStore()

  const [apiKey, setApiKey] = useState(cexStatus && cexStatus.connectErr ? cexStatus.config.apiKey : '')
  const [apiSecret, setApiSecret] = useState(cexStatus && cexStatus.connectErr ? cexStatus.config.apiSecret : '')
  const [error, setError] = useState('')

  const cexInfo = CEXDisplayInfos[cexName]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!apiKey.trim() || !apiSecret.trim()) {
      setError('API Key and Secret are required')
      return
    }

    try {
      const res = await updateCEXConfig({ name: cexName, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
      await fetchMMStatus()
      // Update the CEX statuses even if we fail, because if the CEX has a
      // connection error, we still want the pre-populated incorrect credentials
      // to be updated.
      onCEXUpdated()

      if (!res.ok) {
        setError(`Failed to update CEX configuration: ${res.msg}`)
      } else {
        onClose()
      }
    } catch (err) {
      setError(`Failed to update CEX configuration: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div id="forms" className="stylish-overflow flex-center">
      <form className="position-relative mw-425" autoComplete="off" onSubmit={handleSubmit}>
        <div className="form-closer">
          <span className="ico-cross pointer" onClick={onClose}></span>
        </div>

        <div className="pt-4 fs18">
          {t('MM_CEX_CONFIG_PROMPT', { cexName })}
        </div>

        <div className="flex-center flex-column mt-3 border-top">
          <img
            className="xclogo enourmous-icon"
            src={cexInfo?.logo || '/img/coins/question.png'}
            alt={cexName}
          />
          <div className="mt-2 fs20">{cexName}</div>
        </div>

        {cexStatus && cexStatus.connectErr && (
          <div className="flex-center flex-column text-danger px-3">
            <span className="ico-disconnected fs24"></span>
            <span>{t('MM_CEX_CONNECTION_ERROR')}</span>
            <span className="fs14 mt-2 text-break" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{cexStatus.connectErr}</span>
          </div>
        )}

        <div className="d-flex flex-column">
          <label htmlFor="cexApiKeyInput">{t('MM_API_KEY')}</label>
          <input
            id="cexApiKeyInput"
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="d-flex flex-column">
          <label htmlFor="cexSecretInput">{t('MM_API_SECRET')}</label>
          <input
            id="cexSecretInput"
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            autoComplete="off"
          />
        </div>

        {error && (
          <div className="flex-center text-danger text-break" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>
            {error}
          </div>
        )}

        <div className="flex-stretch-column">
          <button
            type="submit"
            className="feature"
            disabled={!apiKey.trim() || !apiSecret.trim()}
          >
            {t('MM_SAVE_CEX_CREDENTIALS')}
          </button>
        </div>
      </form>
    </div>
  )
}

export default CEXConfigForm
