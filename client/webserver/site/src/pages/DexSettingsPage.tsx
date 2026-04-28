import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
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
import { SuccessCheckmarkModal } from '../components/common/SuccessCheckmarkModal'
import Tooltip from '../components/common/Tooltip'
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
  // DSP-04: SuccessCheckmarkModal replaces the previous inline
  // `tierSuccessMsg` banner + manual `setTimeout` flow. Mirrors vanilla
  // `dexsettings.ts` `showSuccess(intl.prep(intl.ID_TRADING_TIER_UPDATED))`
  // (L56, L82, L244) which used the animated checkmark overlay shared
  // by `forms.showSuccess()`. Both success and dismiss are handled by
  // the modal's internal 2700ms auto-close timer.
  const [showTierSuccess, setShowTierSuccess] = useState(false)

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
  // All five note types share the same handler: bump `connStatusKey`
  // to force a local re-render. The auth store is already updated by
  // the global note dispatcher in `AppLayout`; this component reads
  // `exchange.auth` and `exchange.connectionStatus` directly, so it
  // just needs a render trigger to pick up the fresh values.
  // `walletstate` is included (DSP-01) because wallet readiness
  // affects bond-posting capability — a wallet going locked or
  // unsynced leaves the user unable to post bonds, and the connection
  // panel + tier displays should reflect that.
  const forceReRender = useCallback(() => setConnStatusKey(prev => prev + 1), [])
  useNotifications(useMemo(() => ({
    conn: forceReRender,
    reputation: forceReRender,
    feepayment: forceReRender,
    bondpost: forceReRender,
    walletstate: forceReRender,
  }), [forceReRender]))

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
    setShowTierForm(true)
  }, [exchanges, host])

  // DSP-04: helper that closes the tier wizard and triggers the success
  // checkmark modal. Used by every success path in the tier flow.
  const finishTierUpdate = useCallback(() => {
    setShowTierForm(false)
    setShowTierSuccess(true)
  }, [])

  const handleTierFeeAssetSuccess = useCallback(async (assetID: number, tier: number) => {
    if (assetID === PrepaidBondID) {
      await fetchUser()
      setAutoRenew(tier > 0)
      finishTierUpdate()
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
          await fetchUser()
          finishTierUpdate()
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
  }, [exchanges, host, assets, getBondsFeeBuffer, fetchUser, updateBondOptions, finishTierUpdate])

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
        await fetchUser()
        finishTierUpdate()
      } catch (e: any) {
        setGeneralError(e.msg || 'Error updating bond options')
        setShowTierForm(false)
      }
      return
    }
    setTierStep('walletWait')
  }, [exchanges, host, fetchUser, getBondsFeeBuffer, tierValue, updateBondOptions, finishTierUpdate])

  const handleTierWalletWaitSuccess = useCallback(async () => {
    setTierStep('confirm')
  }, [])

  const handleTierConfirmSuccess = useCallback(async () => {
    setAutoRenew(tierValue > 0)
    await fetchUser()
    finishTierUpdate()
  }, [fetchUser, tierValue, finishTierUpdate])

  const closeTierForm = useCallback(() => {
    setShowTierForm(false)
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
  // DSP-07: keep the canonical applied value handy so we can revert
  // local input state on error or cancel.
  const appliedPenaltyComps = currentAuth?.penaltyComps ?? 0
  // DSP-07: re-sync local state when the auth store reports a new
  // applied value (e.g. after a successful update or from a fresh
  // /api/user payload). Without this, the input keeps showing the
  // stale value from the initial mount even though the store updated.
  useEffect(() => {
    setPenaltyComps(String(appliedPenaltyComps))
  }, [appliedPenaltyComps])

  // DSP-02: pending penalty-comps value awaiting user confirmation.
  // When non-null, the confirm modal is shown.
  const [pendingPenaltyComps, setPendingPenaltyComps] = useState<number | null>(null)

  const handlePenaltyCompsKeyUp = useCallback((e: React.KeyboardEvent) => {
    setPenaltyCompsError('')
    // DSP-07: Escape reverts the input to the canonical applied value,
    // matching vanilla `dexsettings.ts` `penaltyCompBox` click handler
    // (L135) which restores `String(xc.auth.penaltyComps)`.
    if (e.key === 'Escape') {
      setPenaltyComps(String(appliedPenaltyComps))
      return
    }
    if (e.key !== 'Enter') return
    const val = parseInt(penaltyComps)
    if (isNaN(val)) {
      // DSP-03: canonical `INVALID_COMPS_VALUE` key from `en-US.json`
      // L937, mirroring vanilla `dexsettings.ts` L149
      // `intl.prep(intl.ID_INVALID_COMPS_VALUE)`. The previous
      // `t('INVALID_VALUE')` was a non-existent key.
      setPenaltyCompsError(t('INVALID_COMPS_VALUE'))
      return
    }
    // No-op if the value didn't actually change.
    if (val === appliedPenaltyComps) return
    // DSP-02: open confirmation modal before submitting. Vanilla
    // `dexsettings.ts` L167 had a commented-out `bondDetailsForm`
    // confirm wired to `updateBondOptionsConfirm`; React adopts a
    // dedicated React modal (FormOverlay) to prevent typo-induced
    // accidental updates of a bond-affecting setting.
    setPendingPenaltyComps(val)
  }, [penaltyComps, appliedPenaltyComps, t])

  const cancelPenaltyCompsUpdate = useCallback(() => {
    setPendingPenaltyComps(null)
    // Revert the input to the canonical value (matches Escape behavior).
    setPenaltyComps(String(appliedPenaltyComps))
  }, [appliedPenaltyComps])

  const confirmPenaltyCompsUpdate = useCallback(async () => {
    if (pendingPenaltyComps === null) return
    const val = pendingPenaltyComps
    setPendingPenaltyComps(null)
    try {
      await updateBondOptions({ penaltyComps: val })
    } catch (e: any) {
      setPenaltyCompsError(e.msg || 'Error updating')
      // DSP-07: revert the input on error so the user can see the
      // value that's still applied (and try again if they want).
      setPenaltyComps(String(appliedPenaltyComps))
    }
  }, [pendingPenaltyComps, appliedPenaltyComps, updateBondOptions])

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
      setCertUpdateMsg(t('CERTIFICATE_UPDATED'))
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
        if (accountDisabled) return { text: t('ACCOUNT_DISABLED'), connected: false }
        return { text: t('Disconnected'), connected: false }
      case ConnectionStatus.InvalidCert:
        return { text: `${t('Disconnected')} - ${t('INVALID_CERTIFICATE')}`, connected: false }
      default:
        return { text: t('Unknown'), connected: false }
    }
  }, [currentExchange, connectionStatus, accountDisabled, t, connStatusKey])

  if (!exchange) {
    return (
      <div className="py-3 px-3">
        <p className="text-danger">{t('EXCHANGE_NOT_FOUND')}: {host}</p>
        <button className="btn btn-secondary" onClick={() => navigate(ROUTES.SETTINGS)}>
          {t('BACK_TO_SETTINGS')}
        </button>
      </div>
    )
  }

  return (
    <div className="py-3 px-3 overflow-y-auto" style={{ height: '100%' }}>
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
          <Tooltip content={t('TARGET_TIER_TOOLTIP')}>
            <div>
              <span className="text-secondary fs14">{t('TARGET_TIER')}: </span>
              <strong>{targetTier}</strong>
            </div>
          </Tooltip>
          <Tooltip content={t('EFFECTIVE_TIER_TOOLTIP')}>
            <div>
              <span className="text-secondary fs14">{t('EFFECTIVE_TIER')}: </span>
              <strong>{effectiveTier}</strong>
            </div>
          </Tooltip>
          <Tooltip content={t('PENALTIES_TOOLTIP')}>
            <div>
              <span className="text-secondary fs14">{t('PENALTIES')}: </span>
              <strong>{penalties}</strong>
            </div>
          </Tooltip>
          <Tooltip content={t('BONDS_PENDING_REFUND_TOOLTIP')}>
            <div>
              <span className="text-secondary fs14">{t('BONDS_PENDING_REFUND')}: </span>
              <strong>{expiredBondsCount}</strong>
            </div>
          </Tooltip>
        </div>
        <ReputationMeter host={host} />
      </div>

      {/* -- Tier management -- */}
      <div className="mb-4">
        <h5>{t('TRADING_TIER')}</h5>
        <div className="d-flex flex-wrap gap-2 mb-2">
          {/* DSP-10: disable when account is disabled, mirroring vanilla
              `dexsettings.ts` which disables both the auto-renew toggle
              and the tier wizard entry point for disabled accounts. */}
          <button
            className="btn btn-outline-primary"
            onClick={openTierForm}
            disabled={accountDisabled}
          >
            {t('CHANGE_TIER')}
          </button>
        </div>
      </div>

      {/* -- Bond settings -- */}
      <div className="mb-4">
        <h5>{t('BOND_SETTINGS')}</h5>
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
            {t('AUTO_RENEW_BONDS')}
          </label>
        </div>
        {renewError && (
          <div className="fs14 text-danger mb-2">{renewError}</div>
        )}

        <div className="d-flex align-items-center gap-2 mb-2">
          <label className="fs14">{t('PENALTY_COMPENSATIONS')}:</label>
          <input
            type="number"
            className="form-control"
            style={{ width: '100px' }}
            value={penaltyComps}
            onChange={e => setPenaltyComps(e.target.value)}
            onKeyUp={handlePenaltyCompsKeyUp}
          />
          <span className="fs12 text-secondary">{t('PRESS_ENTER_TO_SAVE')}</span>
        </div>
        {penaltyCompsError && (
          <div className="fs14 text-danger mb-2">{penaltyCompsError}</div>
        )}
      </div>

      {/* -- Account actions -- */}
      <div className="mb-4">
        <h5>{t('ACCOUNT_ACTIONS')}</h5>
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-secondary" onClick={exportAccount}>
            {t('EXPORT_ACCOUNT')}
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
? t('ENABLE_ACCOUNT')
: t('DISABLE_ACCOUNT')}
          </button>
          <button className="btn btn-outline-secondary" onClick={() => certFileRef.current?.click()}>
            {t('UPDATE_TLS_CERTIFICATE')}
          </button>
          <input
            ref={certFileRef}
            type="file"
            className="d-none"
            onChange={handleCertFileChange}
          />
          <button className="btn btn-outline-secondary" onClick={() => setShowUpdateHost(true)}>
            {t('UPDATE_DEX_HOST')}
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

      {/* ==== OVERLAYS ==== */}

      {/* DSP-04: animated trading-tier-updated success modal, replacing
          the previous inline `tierSuccessMsg` alert + checkmark. Auto-
          closes after 2700ms via the modal's internal timer, matching
          vanilla `dexsettings.ts` `showSuccess(intl.prep(intl.ID_TRADING_TIER_UPDATED))`. */}
      <SuccessCheckmarkModal
        show={showTierSuccess}
        message={t('TRADING_TIER_UPDATED')}
        onClose={() => setShowTierSuccess(false)}
      />

      {/* -- Tier change overlay -- */}
      <FormOverlay show={showTierForm} onClose={closeTierForm}>
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
      </FormOverlay>

      {/* DSP-02: penalty comps confirmation modal. Modeled on the
          Disable Account confirm pattern below. The user must
          explicitly confirm before the bond-affecting setting is
          updated, preventing typo-induced accidents. Uses the visual
          arrow `→` instead of an "update from X to Y" sentence to
          avoid introducing new fall-through i18n keys for what is
          already universally understood. */}
      <FormOverlay show={pendingPenaltyComps !== null} onClose={cancelPenaltyCompsUpdate}>
        <div className="fs20 mb-3">{t('PENALTY_COMPENSATIONS')}</div>
        <p className="fs15">
          <strong>{appliedPenaltyComps}</strong> → <strong>{pendingPenaltyComps}</strong>
        </p>
        <div className="d-flex gap-2">
          <button className="btn btn-secondary" onClick={cancelPenaltyCompsUpdate}>
            {t('CANCEL')}
          </button>
          <button className="btn btn-primary" onClick={confirmPenaltyCompsUpdate}>
            {t('Confirm')}
          </button>
        </div>
      </FormOverlay>

      {/* -- Disable account confirmation overlay -- */}
      <FormOverlay show={showDisableAccount} onClose={() => setShowDisableAccount(false)}>
        <div className="fs20 mb-3">{t('DISABLE_ACCOUNT')}</div>
        <p className="fs15">
          {t('ARE_YOU_SURE_YOU_WANT_TO_DISABLE_YOUR_ACCOUNT_ON')} <strong>{host}</strong>?
        </p>
        {disableError && (
          <div className="fs15 text-danger mb-2">{disableError}</div>
        )}
        <div className="d-flex gap-2">
          <button className="btn btn-secondary" onClick={() => setShowDisableAccount(false)}>
            {t('CANCEL')}
          </button>
          <button className="btn btn-danger" onClick={() => toggleAccountStatus(true)}>
            {t('Disable')}
          </button>
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
