import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { CertificatePicker, CertificatePickerHandle } from './CertificatePicker'
import type { Exchange } from '../../stores/types'

interface Props {
  onSuccess: (xc: Exchange, cert: string) => void
  dexToUpdate?: string
  knownExchanges?: string[]
}

export function DEXAddressForm ({ onSuccess, dexToUpdate, knownExchanges = [] }: Props) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const certRef = useRef<CertificatePickerHandle>(null)

  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [needCert, setNeedCert] = useState(false)
  const [showCustom, setShowCustom] = useState(
    knownExchanges.length === 0 || !!dexToUpdate
  )
  const [selectedKnown, setSelectedKnown] = useState<string | null>(null)
  const [skipRegistration, setSkipRegistration] = useState(false)
  const [loading, setLoading] = useState(false)

  const hasKnown = knownExchanges.length > 0 && !dexToUpdate

  const checkDEX = useCallback(async (addr?: string) => {
    setError('')
    setNeedCert(false)
    addr = addr || address
    if (addr === '') {
      setError(t('EMPTY_DEX_ADDRESS_MSG'))
      return
    }
    const cert = await certRef.current?.file() ?? ''

    let endpoint: string
    let req: any
    if (dexToUpdate) {
      endpoint = '/api/updatedexhost'
      req = { newHost: addr, cert, oldHost: dexToUpdate }
    } else {
      endpoint = skipRegistration ? '/api/adddex' : '/api/discoveracct'
      req = { addr, cert }
    }

    setLoading(true)
    const res = await postJSON(endpoint, req)
    setLoading(false)

    if (!checkResponse(res)) {
      if (String(res.msg).includes('certificate required')) {
        setNeedCert(true)
      } else {
        setError(res.msg)
      }
      return
    }
    await fetchUser()
    if (!dexToUpdate && (skipRegistration || res.paid ||
        Object.keys(res.xc.auth.pendingBonds).length > 0)) {
      // Already registered or skipping -- caller should navigate to markets.
      // We still call onSuccess so the parent can route appropriately.
      onSuccess(res.xc, cert)
      return
    }
    onSuccess(res.xc, cert)
  }, [address, dexToUpdate, skipRegistration, fetchUser, onSuccess, t])

  const handleKnownClick = (host: string) => {
    setSelectedKnown(host)
    checkDEX(host)
  }

  return (
    <div className="px-3 py-2">
      {/* Header */}
      <div className="flex-center pt-2">
        {!dexToUpdate && <div className="fs24">{t('Add a DEX')}</div>}
        {dexToUpdate && <div className="fs24">{t('update dex host')}</div>}
      </div>

      {/* Known exchanges list */}
      {hasKnown && (
        <>
          <div className="fs20 mt-2 border-top">{t('Pick a server')}</div>
          <div className="flex-stretch-column">
            {knownExchanges.map(host => (
              <div
                key={host}
                className={`known-exchange${selectedKnown === host ? ' selected' : ''}`}
                onClick={() => handleKnownClick(host)}
              >
                <img
                  className="micro-icon me-1"
                  src={`/img/coins/${host.split('.')[0]}.png`}
                  alt=""
                />
                {host}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Skip registration checkbox */}
      {!dexToUpdate && (
        <div className="fs14">
          <input
            className="form-check-input"
            type="checkbox"
            id="skipRegistration"
            checked={skipRegistration}
            onChange={e => setSkipRegistration(e.target.checked)}
          />
          <label htmlFor="skipRegistration" className="ps-1">
            {t('Skip Registration')}
          </label>
        </div>
      )}

      {/* Show custom toggle */}
      {hasKnown && !showCustom && (
        <div
          className="px-1 mb-2 fs14 pointer d-flex justify-content-start align-items-center"
          onClick={() => setShowCustom(true)}
        >
          <span className="ico-plus fs11" />
          <div className="ps-2">{t('add a different server')}</div>
        </div>
      )}

      {/* Custom address input */}
      {showCustom && (
        <div className="mt-2 border-top">
          {hasKnown && (
            <div className="fs20">{t('Add a custom server')}</div>
          )}
          <div className="mb-3">
            <label htmlFor="dexAddr">{t('DEX Address')}</label>
            <input
              id="dexAddr"
              type="text"
              className="form-control"
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') checkDEX() }}
              disabled={loading}
            />
          </div>

          {/* Certificate picker */}
          <div className="mb-3">
            <CertificatePicker ref={certRef} />
          </div>

          {needCert && (
            <div className="fs15 text-warning mb-2">
              {t('TLS certificate required')}
            </div>
          )}

          <button
            className="btn btn-primary w-100"
            onClick={() => checkDEX()}
            disabled={loading}
          >
            {loading ? '...' : t('Submit')}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="fs15 text-danger mt-2">{error}</div>
      )}
    </div>
  )
}
