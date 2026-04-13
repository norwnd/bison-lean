import { useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { DEXAddressForm } from '../components/common/DEXAddressForm'
import { FeeAssetSelectionForm } from '../components/common/FeeAssetSelectionForm'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletWaitForm } from '../components/common/WalletWaitForm'
import { ConfirmRegistrationForm } from '../components/common/ConfirmRegistrationForm'
import { ReputationMeter } from '../components/common/ReputationMeter'
import { strongTier } from '../components/AccountUtils'
import { ROUTES, dexSettingsPath } from '../router/routes'
import { ConnectionStatus, PrepaidBondID } from '../stores/types'
import type { Exchange } from '../stores/types'

type TierStep = 'feeAsset' | 'newWallet' | 'walletWait' | 'confirm'

interface BondOptionsForm {
  host?: string
  bondAssetID?: number
  targetTier?: number
  penaltyComps?: number
}

export default function DexSettingsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const rawHost = useParams<{ host: string }>().host ?? ''
  const host = decodeURIComponent(rawHost)

  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const fetchUser = useAuthStore(s => s.fetchUser)

  const exchange = exchanges[host]
  const auth = exchange?.auth

  // -- Connection status state (refreshed via WS) --
  const [connStatusKey, setConnStatusKey] = useState(0)

  // -- Account disabled state --
  const [accountDisabled, setAccountDisabled] = useState(() => exchange?.disabled ?? false)

  // -- Overlay visibility --
  const [showTierForm, setShowTierForm] = useState(false)
  const [showDisableAccount, setShowDisableAccount] = useState(false)
  const [showUpdateHost, setShowUpdateHost] = useState(false)

  // -- Tier change wizard --
  const [tierStep, setTierStep] = useState<TierStep>('feeAsset')
  const [tierAssetID, setTierAssetID] = useState<number | null>(null)
  const [tierValue, setTierValue] = useState(1)
  const [tierBondFeeBuffer, setTierBondFeeBuffer] = useState(0)
  const [tierCertFile] = useState('')
  const [tierSuccessMsg, setTierSuccessMsg] = useState('')

  // -- Auto-renew toggle --
  const [autoRenew, setAutoRenew] = useState(() => (auth?.targetTier ?? 0) > 0)
  const [renewError, setRenewError] = useState('')

  // -- Penalty comps --
  const [penaltyComps, setPenaltyComps] = useState(() => String(auth?.penaltyComps ?? 0))
  const [penaltyCompsError, setPenaltyCompsError] = useState('')

  // -- Export / Disable errors --
  const [exportError, setExportError] = useState('')
  const [disableError, setDisableError] = useState('')
  const [generalError, setGeneralError] = useState('')

  // -- Cert update --
  const certFileRef = useRef<HTMLInputElement>(null)
  const [certUpdateMsg, setCertUpdateMsg] = useState('')

  // -- WS note handlers --
  useNotifications(useMemo(() => ({
    conn: (_note: any) => {
      setConnStatusKey(prev => prev + 1)
    },
    reputation: () => {
      // Just force a re-render. The authStore is already updated by the
      // notification pipeline; the component reads exchange.auth directly.
      setConnStatusKey(prev => prev + 1)
    },
    feepayment: () => {
      setConnStatusKey(prev => prev + 1)
    },
    bondpost: () => {
      setConnStatusKey(prev => prev + 1)
    },
  }), []))

  // -- Derived values --
  // Read from exchanges on each render (may be updated by store).
  const currentExchange = exchanges[host]
  const currentAuth = currentExchange?.auth
  const connectionStatus = currentExchange?.connectionStatus
  const effectiveTier = currentAuth
    ? strongTier(currentAuth)
    : 0
  const targetTier = currentAuth?.targetTier ?? 0
  const penalties = currentAuth?.rep?.penalties ?? 0
  const expiredBondsCount = currentAuth?.expiredBonds?.length ?? 0

  // -- Helpers --
  const getBondsFeeBuffer = useCallback(async (assetID: number): Promise<number> => {
    const res = await postJSON('/api/bondsfeebuffer', { assetID })
    if (!checkResponse(res)) return 0
    return res.feeBuffer
  }, [])

  const updateBondOptions = useCallback(async (conf: BondOptionsForm) => {
    conf.host = host
    const res = await postJSON('/api/updatebondoptions', conf)
    if (!checkResponse(res)) throw res
    const newTarget = conf.targetTier ?? currentAuth?.targetTier ?? 0
    setAutoRenew(newTarget > 0)
  }, [host, currentAuth])

  // -- Tier change wizard callbacks --
  const openTierForm = useCallback(() => {
    const xc = exchanges[host]
    if (!xc) return
    setTierStep('feeAsset')
    setTierSuccessMsg('')
    setShowTierForm(true)
  }, [exchanges, host])

  const handleTierFeeAssetSuccess = useCallback(async (assetID: number, tier: number) => {
    if (assetID === PrepaidBondID) {
      await fetchUser()
      setTierSuccessMsg(t('Trading tier updated'))
      setAutoRenew(tier > 0)
      setTimeout(() => setShowTierForm(false), 1500)
      return
    }
    const xc = exchanges[host]
    if (!xc) return
    const asset = assets[assetID]
    const wallet = asset?.wallet
    setTierAssetID(assetID)
    setTierValue(tier)

    if (wallet) {
      const feeBuffer = await getBondsFeeBuffer(assetID)
      setTierBondFeeBuffer(feeBuffer)
      const bondAsset = xc.bondAssets[asset.symbol]
      if (!wallet.open) {
        // Try to open the wallet first.
        const res = await postJSON('/api/openwallet', { assetID })
        if (!checkResponse(res)) {
          setGeneralError(`Error unlocking wallet: ${res.msg}`)
          setShowTierForm(false)
          return
        }
        return
      }
      if (wallet.synced && wallet.balance.available >= 2 * bondAsset.amount + feeBuffer) {
        // Wallet is funded. Check if we're raising or lowering tier.
        const currentStrong = xc.auth.liveStrength + xc.auth.pendingStrength - xc.auth.weakStrength
        if (tier > xc.auth.targetTier && tier > currentStrong) {
          setTierStep('confirm')
          return
        }
        // Lowering tier - just update options directly.
        try {
          await updateBondOptions({ bondAssetID: assetID, targetTier: tier })
          setTierSuccessMsg(t('Trading tier updated'))
          await fetchUser()
          setTimeout(() => setShowTierForm(false), 1500)
        } catch (e: any) {
          setGeneralError(e.msg || 'Error updating bond options')
          setShowTierForm(false)
        }
        return
      }
      setTierStep('walletWait')
      return
    }
    setTierBondFeeBuffer(0)
    setTierStep('newWallet')
  }, [exchanges, host, assets, getBondsFeeBuffer, fetchUser, updateBondOptions, t])

  const handleTierNewWalletSuccess = useCallback(async (assetID: number) => {
    const user = await fetchUser()
    if (!user) return
    const xc = exchanges[host]
    if (!xc) return
    const asset = user.assets[assetID]
    const wallet = asset?.wallet
    const bondAmt = xc.bondAssets[asset.symbol].amount
    const feeBuffer = await getBondsFeeBuffer(assetID)
    setTierBondFeeBuffer(feeBuffer)
    setTierAssetID(assetID)

    if (wallet && wallet.synced && wallet.balance.available >= 2 * bondAmt + feeBuffer) {
      const currentStrong = xc.auth.liveStrength + xc.auth.pendingStrength - xc.auth.weakStrength
      if (tierValue > xc.auth.targetTier && tierValue > currentStrong) {
        setTierStep('confirm')
        return
      }
      try {
        await updateBondOptions({ bondAssetID: assetID, targetTier: tierValue })
        setTierSuccessMsg(t('Trading tier updated'))
        await fetchUser()
        setTimeout(() => setShowTierForm(false), 1500)
      } catch (e: any) {
        setGeneralError(e.msg || 'Error updating bond options')
        setShowTierForm(false)
      }
      return
    }
    setTierStep('walletWait')
  }, [exchanges, host, fetchUser, getBondsFeeBuffer, tierValue, updateBondOptions, t])

  const handleTierWalletWaitSuccess = useCallback(async () => {
    setTierStep('confirm')
  }, [])

  const handleTierConfirmSuccess = useCallback(async () => {
    setTierSuccessMsg(t('Trading tier updated'))
    setAutoRenew(tierValue > 0)
    await fetchUser()
    setTimeout(() => setShowTierForm(false), 1500)
  }, [fetchUser, tierValue, t])

  const closeTierForm = useCallback(() => {
    setShowTierForm(false)
    setTierSuccessMsg('')
  }, [])

  // -- Auto-renew toggle --
  const handleAutoRenewToggle = useCallback(async () => {
    setRenewError('')
    if (accountDisabled) return
    if (!autoRenew) {
      // Enabling auto-renew: open tier form
      openTierForm()
    } else {
      // Disabling auto-renew
      try {
        await updateBondOptions({ targetTier: 0 })
        setAutoRenew(false)
      } catch (e: any) {
        setRenewError(e.msg || 'Error disabling auto-renew')
      }
    }
  }, [autoRenew, accountDisabled, openTierForm, updateBondOptions])

  // -- Penalty comps --
  const handlePenaltyCompsKeyUp = useCallback(async (e: React.KeyboardEvent) => {
    setPenaltyCompsError('')
    if (e.key === 'Escape') return
    if (e.key !== 'Enter') return
    const val = parseInt(penaltyComps)
    if (isNaN(val)) {
      setPenaltyCompsError(t('Invalid value'))
      return
    }
    try {
      await updateBondOptions({ penaltyComps: val })
    } catch (e: any) {
      setPenaltyCompsError(e.msg || 'Error updating')
    }
  }, [penaltyComps, updateBondOptions, t])

  // -- Export account --
  const exportAccount = useCallback(async () => {
    setExportError('')
    const res = await postJSON('/api/exportaccount', { host })
    if (!checkResponse(res)) {
      setExportError(res.msg)
      return
    }
    res.account.bonds = res.bonds
    const accountForExport = JSON.parse(JSON.stringify(res.account))
    const a = document.createElement('a')
    a.setAttribute('download', `dcrAccount-${host}.json`)
    a.setAttribute('href', 'data:text/json,' + JSON.stringify(accountForExport, null, 2))
    a.click()
  }, [host])

  // -- Toggle account status --
  const toggleAccountStatus = useCallback(async (disable: boolean, force?: boolean) => {
    setDisableError('')
    setGeneralError('')
    const req = { host, disable, force: force || false }
    const res = await postJSON('/api/toggleaccountstatus', req)
    if (!checkResponse(res)) {
      if (disable && !force && res.msg && res.msg.includes('active orders')) {
        return toggleAccountStatus(true, true)
      }
      if (disable) {
        setDisableError(res.msg)
      } else {
        setGeneralError(res.msg)
      }
      return
    }
    setAccountDisabled(disable)
    setShowDisableAccount(false)
    await fetchUser()
    navigate(dexSettingsPath(host))
  }, [host, fetchUser, navigate])

  // -- Update cert --
  const handleCertFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    setGeneralError('')
    setCertUpdateMsg('')
    const files = e.target.files
    if (!files || !files.length) return
    const cert = await files[0].text()
    if (!cert) return
    const res = await postJSON('/api/updatecert', { host, cert })
    if (!checkResponse(res)) {
      setGeneralError(res.msg)
    } else {
      setCertUpdateMsg(t('Certificate updated'))
      setTimeout(() => setCertUpdateMsg(''), 5000)
    }
    if (certFileRef.current) certFileRef.current.value = ''
  }, [host, t])

  // -- Update host --
  const handleUpdateHostSuccess = useCallback((xc: Exchange) => {
    setShowUpdateHost(false)
    navigate(dexSettingsPath(xc.host))
  }, [navigate])

  // -- Connection status display --
  const connectionStatusDisplay = useMemo((): { text: string; connected: boolean } => {
    if (!currentExchange) return { text: t('Unknown'), connected: false }
    switch (connectionStatus) {
      case ConnectionStatus.Connected:
        return { text: t('Connected'), connected: true }
      case ConnectionStatus.Disconnected:
        if (accountDisabled) return { text: t('Account Disabled'), connected: false }
        return { text: t('Disconnected'), connected: false }
      case ConnectionStatus.InvalidCert:
        return { text: `${t('Disconnected')} - ${t('Invalid Certificate')}`, connected: false }
      default:
        return { text: t('Unknown'), connected: false }
    }
  }, [currentExchange, connectionStatus, accountDisabled, t, connStatusKey])

  if (!exchange) {
    return (
      <div className="py-3 px-3">
        <p className="text-danger">{t('Exchange not found')}: {host}</p>
        <button className="btn btn-secondary" onClick={() => navigate(ROUTES.SETTINGS)}>
          {t('Back to Settings')}
        </button>
      </div>
    )
  }

  return (
    <div className="py-3 px-3">
      {/* -- Header -- */}
      <div className="d-flex align-items-center gap-3 mb-4">
        <button className="btn btn-sm btn-outline-secondary" onClick={() => navigate(ROUTES.SETTINGS)}>
          &larr; {t('Settings')}
        </button>
        <h2 className="mb-0">{host}</h2>
      </div>

      {/* -- Connection status -- */}
      <div className="mb-4">
        <h5>{t('Connection')}</h5>
        <div className="d-flex align-items-center gap-2">
          {connectionStatusDisplay.connected
? (
            <span className="ico-check text-success" />
          )
: (
            <span className="ico-cross text-danger" />
          )}
          <span className="fs15">{connectionStatusDisplay.text}</span>
        </div>
      </div>

      {/* -- Reputation -- */}
      <div className="mb-4">
        <h5>{t('Reputation')}</h5>
        <div className="d-flex flex-wrap gap-4 mb-2">
          <div>
            <span className="text-secondary fs14">{t('Target Tier')}: </span>
            <strong>{targetTier}</strong>
          </div>
          <div>
            <span className="text-secondary fs14">{t('Effective Tier')}: </span>
            <strong>{effectiveTier}</strong>
          </div>
          <div>
            <span className="text-secondary fs14">{t('Penalties')}: </span>
            <strong>{penalties}</strong>
          </div>
          <div>
            <span className="text-secondary fs14">{t('Bonds Pending Refund')}: </span>
            <strong>{expiredBondsCount}</strong>
          </div>
        </div>
        <ReputationMeter host={host} />
      </div>

      {/* -- Tier management -- */}
      <div className="mb-4">
        <h5>{t('Trading Tier')}</h5>
        <div className="d-flex flex-wrap gap-2 mb-2">
          <button className="btn btn-outline-primary" onClick={openTierForm}>
            {t('Change Tier')}
          </button>
        </div>
      </div>

      {/* -- Bond settings -- */}
      <div className="mb-4">
        <h5>{t('Bond Settings')}</h5>
        <div className="form-check mb-2">
          <input
            className="form-check-input"
            type="checkbox"
            id="autoRenewToggle"
            checked={autoRenew}
            onChange={handleAutoRenewToggle}
            disabled={accountDisabled}
          />
          <label className="form-check-label" htmlFor="autoRenewToggle">
            {t('Auto-renew bonds')}
          </label>
        </div>
        {renewError && (
          <div className="fs14 text-danger mb-2">{renewError}</div>
        )}

        <div className="d-flex align-items-center gap-2 mb-2">
          <label className="fs14">{t('Penalty compensations')}:</label>
          <input
            type="number"
            className="form-control"
            style={{ width: '100px' }}
            value={penaltyComps}
            onChange={e => setPenaltyComps(e.target.value)}
            onKeyUp={handlePenaltyCompsKeyUp}
          />
          <span className="fs12 text-secondary">{t('Press Enter to save')}</span>
        </div>
        {penaltyCompsError && (
          <div className="fs14 text-danger mb-2">{penaltyCompsError}</div>
        )}
      </div>

      {/* -- Account actions -- */}
      <div className="mb-4">
        <h5>{t('Account Actions')}</h5>
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-secondary" onClick={exportAccount}>
            {t('Export Account')}
          </button>
          <button
            className="btn btn-outline-secondary"
            onClick={() => {
              if (accountDisabled) {
                toggleAccountStatus(false)
              } else {
                setDisableError('')
                setShowDisableAccount(true)
              }
            }}
          >
            {accountDisabled
? t('Enable Account')
: t('Disable Account')}
          </button>
          <button className="btn btn-outline-secondary" onClick={() => certFileRef.current?.click()}>
            {t('Update TLS Certificate')}
          </button>
          <input
            ref={certFileRef}
            type="file"
            className="d-none"
            onChange={handleCertFileChange}
          />
          <button className="btn btn-outline-secondary" onClick={() => setShowUpdateHost(true)}>
            {t('Update DEX Host')}
          </button>
        </div>
        {exportError && (
          <div className="fs14 text-danger mt-2">{exportError}</div>
        )}
        {generalError && (
          <div className="fs14 text-danger mt-2">{generalError}</div>
        )}
        {certUpdateMsg && (
          <div className="fs14 text-success mt-2">{certUpdateMsg}</div>
        )}
      </div>

      {/* -- Tier success banner -- */}
      {tierSuccessMsg && !showTierForm && (
        <div className="alert alert-success">{tierSuccessMsg}</div>
      )}

      {/* ==== OVERLAYS ==== */}

      {/* -- Tier change overlay -- */}
      <FormOverlay show={showTierForm} onClose={closeTierForm}>
        <div className="col-12 col-sm-10 col-md-8 col-lg-6 mx-auto">
          {tierSuccessMsg
? (
            <div className="px-4 py-3 text-center">
              <div className="ico-check text-success fs24 mb-2" />
              <div className="fs18">{tierSuccessMsg}</div>
            </div>
          )
: (
            <>
              {tierStep === 'feeAsset' && exchange && (
                <FeeAssetSelectionForm
                  exchange={exchange}
                  certFile={tierCertFile}
                  onSuccess={handleTierFeeAssetSuccess}
                />
              )}

              {tierStep === 'newWallet' && tierAssetID !== null && (
                <NewWalletForm
                  assetID={tierAssetID}
                  onSuccess={handleTierNewWalletSuccess}
                  onBack={() => setTierStep('feeAsset')}
                />
              )}

              {tierStep === 'walletWait' && exchange && tierAssetID !== null && (
                <WalletWaitForm
                  exchange={exchange}
                  assetID={tierAssetID}
                  bondFeeBuffer={tierBondFeeBuffer}
                  tier={tierValue}
                  onSuccess={handleTierWalletWaitSuccess}
                  onBack={async () => setTierStep('feeAsset')}
                />
              )}

              {tierStep === 'confirm' && exchange && tierAssetID !== null && (
                <ConfirmRegistrationForm
                  exchange={exchange}
                  certFile={tierCertFile}
                  bondAssetID={tierAssetID}
                  tier={tierValue}
                  fees={tierBondFeeBuffer}
                  onSuccess={handleTierConfirmSuccess}
                  onBack={async () => setTierStep('feeAsset')}
                />
              )}
            </>
          )}
        </div>
      </FormOverlay>

      {/* -- Disable account confirmation overlay -- */}
      <FormOverlay show={showDisableAccount} onClose={() => setShowDisableAccount(false)}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
          <div className="fs20 mb-3">{t('Disable Account')}</div>
          <p className="fs15">
            {t('Are you sure you want to disable your account on')} <strong>{host}</strong>?
          </p>
          {disableError && (
            <div className="fs15 text-danger mb-2">{disableError}</div>
          )}
          <div className="d-flex gap-2">
            <button className="btn btn-secondary" onClick={() => setShowDisableAccount(false)}>
              {t('Cancel')}
            </button>
            <button className="btn btn-danger" onClick={() => toggleAccountStatus(true)}>
              {t('Disable')}
            </button>
          </div>
        </div>
      </FormOverlay>

      {/* -- Update host overlay -- */}
      <FormOverlay show={showUpdateHost} onClose={() => setShowUpdateHost(false)}>
        <DEXAddressForm
          onSuccess={handleUpdateHostSuccess}
          dexToUpdate={host}
        />
      </FormOverlay>
    </div>
  )
}
