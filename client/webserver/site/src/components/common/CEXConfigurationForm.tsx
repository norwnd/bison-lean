import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { CEXConfig } from '../../stores/types'

interface Props {
  cexName: string
  onUpdated: (cexName: string, success: boolean) => void
}

export function CEXConfigurationForm ({ cexName, onUpdated }: Props) {
  const { t } = useTranslation()
  const mmStatus = useAuthStore(s => s.mmStatus)

  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [apiPassphrase, setApiPassphrase] = useState('')
  const [error, setError] = useState('')
  const [connectErr, setConnectErr] = useState('')
  const [showPrompt, setShowPrompt] = useState(true)
  const [loading, setLoading] = useState(false)

  const requiresPassphrase = cexName === 'Bitget'

  // Initialize form from existing CEX status if there's an error.
  useEffect(() => {
    setApiKey('')
    setApiSecret('')
    setApiPassphrase('')
    setError('')
    setConnectErr('')
    setShowPrompt(true)

    const cexStatus = mmStatus?.cexes[cexName]
    const existingErr = cexStatus?.connectErr
    if (existingErr) {
      setConnectErr(existingErr)
      setShowPrompt(false)
      if (cexStatus.config) {
        setApiKey(cexStatus.config.apiKey || '')
        setApiSecret(cexStatus.config.apiSecret || '')
        if (cexStatus.config.apiPassphrase) {
          setApiPassphrase(cexStatus.config.apiPassphrase)
        }
      }
    }
  }, [cexName, mmStatus])

  const submit = async () => {
    setError('')
    if (!apiKey || !apiSecret) {
      setError(t('NO_PASS_ERROR_MSG'))
      return
    }
    if (requiresPassphrase && !apiPassphrase) {
      setError('Bitget requires an API Passphrase')
      return
    }

    const cfg: CEXConfig = {
      name: cexName,
      apiKey: apiKey,
      apiSecret: apiSecret,
    }
    if (apiPassphrase) {
      cfg.apiPassphrase = apiPassphrase
    }

    setLoading(true)
    try {
      const res = await postJSON('/api/updatecexconfig', cfg)
      if (!checkResponse(res)) throw res
      onUpdated(cexName, true)
    } catch (e: any) {
      setError(t('API_ERROR', { msg: e.msg ?? String(e) }))
      onUpdated(cexName, false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-3 py-2">
      <div className="fs20 mb-2">{cexName} {t('Configuration')}</div>

      {showPrompt && (
        <div className="fs15 mb-2 text-secondary">
          {t('ENTER_YOUR_API_CREDENTIALS_FOR')} {cexName}
        </div>
      )}

      {connectErr && (
        <div className="fs14 text-danger mb-2">
          <strong>{t('CONNECTION_ERROR')}:</strong> {connectErr}
        </div>
      )}

      <div className="mb-2">
        <label className="fs14">{t('API_KEY')}</label>
        <input
          type="text"
          className="form-control"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          disabled={loading}
        />
      </div>

      <div className="mb-2">
        <label className="fs14">{t('API_SECRET')}</label>
        <input
          type="password"
          className="form-control"
          value={apiSecret}
          onChange={e => setApiSecret(e.target.value)}
          disabled={loading}
        />
      </div>

      {requiresPassphrase && (
        <div className="mb-2">
          <label className="fs14">{t('API_PASSPHRASE')}</label>
          <input
            type="password"
            className="form-control"
            value={apiPassphrase}
            onChange={e => setApiPassphrase(e.target.value)}
            disabled={loading}
          />
        </div>
      )}

      {error && (
        <div className="fs15 text-danger mb-2">{error}</div>
      )}

      <button
        className="btn btn-primary w-100"
        onClick={submit}
        disabled={loading}
      >
        {loading ? '...' : t('Submit')}
      </button>
    </div>
  )
}
