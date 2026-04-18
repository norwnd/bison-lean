import { useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse, Errors } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useUIStore } from '../stores/useUIStore'
import { FormOverlay } from '../components/common/FormOverlay'
import { DEXAddressForm } from '../components/common/DEXAddressForm'
import { FeeAssetSelectionForm } from '../components/common/FeeAssetSelectionForm'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletWaitForm } from '../components/common/WalletWaitForm'
import { ConfirmRegistrationForm } from '../components/common/ConfirmRegistrationForm'
import { AppPassResetForm } from '../components/common/AppPassResetForm'
import { ROUTES, dexSettingsPath } from '../router/routes'
import type { Exchange } from '../stores/types'
import { PrepaidBondID, DCRAssetID } from '../stores/types'
import { formatCoinAtom } from '../hooks/useFormatters'
import { explorerURL } from '../components/CoinExplorers'

type RegStep = 'dexAddress' | 'feeAsset' | 'newWallet' | 'walletWait' | 'confirm'

// Desktop notification settings stored in localStorage.
const ntfnSettingsKey = () => `desktop_notifications-${window.location.host}`

const noteTypes: Record<string, string> = {
  order: 'Orders',
  match: 'Matches',
  bondpost: 'Bonds',
  conn: 'Connections',
}

function loadNtfnSettings (): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(ntfnSettingsKey())
    if (raw) return JSON.parse(raw) as Record<string, boolean>
  } catch { /* ignore */ }
  return { browserNtfnEnabled: false, order: true, match: true, bondpost: true, conn: true }
}

function saveNtfnSettings (settings: Record<string, boolean>) {
  window.localStorage.setItem(ntfnSettingsKey(), JSON.stringify(settings))
}

export default function SettingsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const logout = useAuthStore(s => s.logout)
  const onionUrl = useAuthStore(s => s.onionUrl)
  const companionAppPaired = useAuthStore(s => s.companionAppPaired)
  const darkMode = useUIStore(s => s.darkMode)
  const toggleDarkMode = useUIStore(s => s.toggleDarkMode)
  const showPopups = useUIStore(s => s.showPopups)
  const togglePopups = useUIStore(s => s.togglePopups)

  // -- Overlay visibility state --
  const [showAddDex, setShowAddDex] = useState(false)
  const [showChangePW, setShowChangePW] = useState(false)
  const [showResetPW, setShowResetPW] = useState(false)
  const [showImportAccount, setShowImportAccount] = useState(false)
  const [showExportSeed, setShowExportSeed] = useState(false)
  const [showCompanionApp, setShowCompanionApp] = useState(false)
  const [showGameCode, setShowGameCode] = useState(false)

  // -- DEX registration wizard state --
  const [regStep, setRegStep] = useState<RegStep>('dexAddress')
  const [regExchange, setRegExchange] = useState<Exchange | null>(null)
  const [regCertFile, setRegCertFile] = useState('')
  const [regAssetID, setRegAssetID] = useState<number | null>(null)
  const [regTier, setRegTier] = useState(1)
  const [regBondFeeBuffer, setRegBondFeeBuffer] = useState(0)

  // -- Fiat rate sources --
  const [fiatSourcesLoading, setFiatSourcesLoading] = useState<Record<string, boolean>>({})

  // -- Change password form --
  const [currentPW, setCurrentPW] = useState('')
  const [newPW, setNewPW] = useState('')
  const [confirmNewPW, setConfirmNewPW] = useState('')
  const [changePWError, setChangePWError] = useState('')
  // Loading state for the password-change round trip. Mirrors vanilla
  // `settings.ts` `changeAppPW()` (L450) `app().loading(page.changeAppPW)`
  // overlay. Same pattern as SP-06 export-seed loading.
  const [changePWLoading, setChangePWLoading] = useState(false)

  // -- Import account --
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const accountFileRef = useRef<HTMLInputElement>(null)

  // -- Export seed --
  const [exportSeedPW, setExportSeedPW] = useState('')
  const [exportSeedError, setExportSeedError] = useState('')
  const [exportSeedResult, setExportSeedResult] = useState<{ legacy?: string; mnemonic?: string } | null>(null)
  // SP-06: loading state for the password-check round trip. Vanilla
  // `settings.ts` `submitExportSeedReq()` (L394) wraps the request in
  // `app().loading(this.body)` to show a spinner overlay; React mirrors
  // this with a per-button loading flag + disabled state.
  const [exportSeedLoading, setExportSeedLoading] = useState(false)

  // -- Companion app --
  const [companionUnpaired, setCompanionUnpaired] = useState(false)

  // -- Game code --
  const [gameCode, setGameCode] = useState('')
  const [gameCodeMsg, setGameCodeMsg] = useState('')
  const [gameCodeError, setGameCodeError] = useState('')
  const [gameCodeSuccess, setGameCodeSuccess] = useState<{ coinString: string; win: number } | null>(null)

  // -- Desktop notifications --
  const [ntfnSettings, setNtfnSettings] = useState<Record<string, boolean>>(loadNtfnSettings)
  const [ntfnPermissionBlocked, setNtfnPermissionBlocked] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'denied'
  )

  // -- Sign out --
  const [signOutError, setSignOutError] = useState('')
  const [signOutLoading, setSignOutLoading] = useState(false)
  // `showForceSignOut` triggers the confirmation overlay shown when the
  // server returns `activeOrdersErr`. Confirming calls `logout(true)` to
  // bypass the server-side active-orders check at the user's own risk.
  const [showForceSignOut, setShowForceSignOut] = useState(false)

  // Fiat rate sources from user data.
  const fiatRateSources = useMemo(() => {
    if (!user) return []
    // user.fiatRates keys are asset IDs; the rate sources are on the user
    // object at the top level. Scan user for fiatRateSources field.
    return (user as any).fiatRateSources ?? []
  }, [user])

  // DEX list for navigation.
  const exchangeList = useMemo(() => Object.values(exchanges), [exchanges])

  // -- DEX registration wizard callbacks --
  const getBondsFeeBuffer = useCallback(async (assetID: number): Promise<number> => {
    const res = await postJSON('/api/bondsfeebuffer', { assetID })
    if (!checkResponse(res)) return 0
    return res.feeBuffer
  }, [])

  const registerDEXSuccess = useCallback(async () => {
    await fetchUser()
    setShowAddDex(false)
    window.location.reload()
  }, [fetchUser])

  const handleDexAddressSuccess = useCallback((xc: Exchange, cert: string) => {
    setRegExchange(xc)
    setRegCertFile(cert)
    setRegStep('feeAsset')
  }, [])

  const handleFeeAssetSuccess = useCallback(async (assetID: number, tier: number) => {
    if (assetID === PrepaidBondID) {
      await registerDEXSuccess()
      return
    }
    setRegAssetID(assetID)
    setRegTier(tier)

    const asset = assets[assetID]
    const wallet = asset?.wallet
    if (!regExchange) return

    const bondAsset = regExchange.bondAssets[asset.symbol]
    const feeBuffer = await getBondsFeeBuffer(assetID)
    setRegBondFeeBuffer(feeBuffer)

    if (wallet) {
      if (wallet.synced && wallet.balance.available >= 2 * bondAsset.amount + feeBuffer) {
        setRegStep('confirm')
        return
      }
      setRegStep('walletWait')
      return
    }
    setRegStep('newWallet')
  }, [assets, regExchange, getBondsFeeBuffer, registerDEXSuccess])

  const handleNewWalletSuccess = useCallback(async (assetID: number) => {
    if (!regExchange) return
    const user = await fetchUser()
    if (!user) return
    const asset = user.assets[assetID]
    const wallet = asset?.wallet
    const bondAsset = regExchange.bondAssets[asset.symbol]
    const feeBuffer = await getBondsFeeBuffer(assetID)
    setRegBondFeeBuffer(feeBuffer)
    setRegAssetID(assetID)

    if (wallet && wallet.synced && wallet.balance.available >= 2 * bondAsset.amount + feeBuffer) {
      setRegStep('confirm')
      return
    }
    setRegStep('walletWait')
  }, [regExchange, fetchUser, getBondsFeeBuffer])

  const handleWalletWaitSuccess = useCallback(async () => {
    setRegStep('confirm')
  }, [])

  const handleConfirmSuccess = useCallback(async () => {
    await registerDEXSuccess()
  }, [registerDEXSuccess])

  // -- Fiat rate source toggle --
  const toggleRateSource = useCallback(async (source: string, currentlyEnabled: boolean) => {
    setFiatSourcesLoading(prev => ({ ...prev, [source]: true }))
    const res = await postJSON('/api/toggleratesource', {
      disable: currentlyEnabled,
      source,
    })
    setFiatSourcesLoading(prev => ({ ...prev, [source]: false }))
    if (!checkResponse(res)) return
    await fetchUser()
  }, [fetchUser])

  // -- Change password --
  const submitChangePassword = useCallback(async () => {
    setChangePWError('')
    if (!currentPW || !newPW || !confirmNewPW) {
      setChangePWError(t('NO_APP_PASS_ERROR_MSG'))
      return
    }
    if (newPW !== confirmNewPW) {
      setChangePWError(t('PASSWORD_NOT_MATCH'))
      return
    }
    setChangePWLoading(true)
    const res = await postJSON('/api/changeapppass', {
      appPW: currentPW,
      newAppPW: newPW,
    })
    setChangePWLoading(false)
    if (!checkResponse(res)) {
      setChangePWError(res.msg)
      return
    }
    setCurrentPW('')
    setNewPW('')
    setConfirmNewPW('')
    setShowChangePW(false)
  }, [currentPW, newPW, confirmNewPW, t])

  // -- Reset password --
  const handleResetPWSuccess = useCallback(() => {
    setShowResetPW(false)
    navigate(ROUTES.LOGIN)
  }, [navigate])

  // -- Import account --
  const handleImportFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      setImportFile(files[0])
    }
  }, [])

  const submitImportAccount = useCallback(async () => {
    setImportError('')
    if (!importFile) {
      // SP-02: defensive guard — the Import button is `disabled` when
      // `importFile` is null so this branch shouldn't be reachable
      // through the UI. Match vanilla `settings.ts` `importAccount()`
      // (L356) which also bails silently with a `console.error`.
      console.error('importAccount: no file specified')
      return
    }
    setImportLoading(true)
    try {
      const text = await importFile.text()
      let account: any
      try {
        account = JSON.parse(text)
      } catch (e: any) {
        setImportError(e.message)
        setImportLoading(false)
        return
      }
      if (typeof account === 'undefined') {
        setImportError(t('ACCT_UNDEFINED'))
        setImportLoading(false)
        return
      }
      const { bonds = [], ...acctInf } = account
      const res = await postJSON('/api/importaccount', { account: acctInf, bonds })
      if (!checkResponse(res)) {
        setImportError(res.msg)
        setImportLoading(false)
        return
      }
      await fetchUser()
      setShowImportAccount(false)
      window.location.reload()
    } finally {
      setImportLoading(false)
    }
  }, [importFile, fetchUser, t])

  // -- Export seed --
  const submitExportSeed = useCallback(async () => {
    setExportSeedError('')
    setExportSeedResult(null)
    setExportSeedLoading(true)
    const res = await postJSON('/api/exportseed', { pass: exportSeedPW })
    setExportSeedLoading(false)
    if (!checkResponse(res)) {
      setExportSeedError(res.msg)
      return
    }
    setExportSeedPW('')
    const seed = res.seed as string
    if (seed.length === 128 && seed.split(' ').length === 1) {
      const formatted = (seed.match(/.{1,32}/g) ?? [])
        .map((chunk: string) => chunk.match(/.{1,8}/g)?.join(' '))
        .join('\n')
      setExportSeedResult({ legacy: formatted })
    } else {
      setExportSeedResult({ mnemonic: seed })
    }
  }, [exportSeedPW])

  // -- Export logs --
  const exportLogs = useCallback(() => {
    const url = new URL(window.location.href)
    url.pathname = '/api/exportapplog'
    if ((window as any).electron !== undefined || (window as any).isWebview !== undefined) {
      window.open(url.toString(), '_self')
    } else {
      window.open(url.toString())
    }
  }, [])

  // -- Desktop notifications --
  const toggleBrowserNtfn = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'denied') {
      setNtfnPermissionBlocked(true)
      return
    }
    const next = !ntfnSettings.browserNtfnEnabled
    if (next && Notification.permission !== 'granted') {
      await Notification.requestPermission()
      if ((Notification.permission as string) === 'denied') {
        setNtfnPermissionBlocked(true)
        return
      }
    }
    const updated = { ...ntfnSettings, browserNtfnEnabled: next }
    setNtfnSettings(updated)
    saveNtfnSettings(updated)
  }, [ntfnSettings])

  const toggleNtfnType = useCallback((noteType: string) => {
    const updated = { ...ntfnSettings, [noteType]: !ntfnSettings[noteType] }
    setNtfnSettings(updated)
    saveNtfnSettings(updated)
  }, [ntfnSettings])

  // -- Companion app --
  const unpairCompanionApp = useCallback(async () => {
    const res = await postJSON('/api/unpaircompanionapp', {})
    if (!checkResponse(res)) return
    setCompanionUnpaired(true)
  }, [])

  // -- Game code --
  const submitGameCode = useCallback(async () => {
    setGameCodeError('')
    setGameCodeSuccess(null)
    if (!gameCode) {
      // SP-03: use canonical `NO_CODE_PROVIDED` key from `en-US.json`
      // L1155 (matches vanilla `settings.ts` L507
      // `intl.prep(intl.ID_NO_CODE_PROVIDED)`). The previous
      // `t('No code provided')` was a non-existent key and fell
      // through to the literal English string.
      setGameCodeError(t('NO_CODE_PROVIDED'))
      return
    }
    const res = await postJSON('/api/redeemgamecode', { code: gameCode, msg: gameCodeMsg })
    if (!checkResponse(res)) {
      setGameCodeError(res.msg)
      return
    }
    setGameCodeSuccess({ coinString: res.coinString, win: res.win })
  }, [gameCode, gameCodeMsg, t])

  // -- Close helpers --
  const closeAddDex = useCallback(() => {
    setShowAddDex(false)
    setRegStep('dexAddress')
    setRegExchange(null)
    setRegCertFile('')
    setRegAssetID(null)
  }, [])

  const closeChangePW = useCallback(() => {
    setShowChangePW(false)
    setCurrentPW('')
    setNewPW('')
    setConfirmNewPW('')
    setChangePWError('')
  }, [])

  const closeExportSeed = useCallback(() => {
    setShowExportSeed(false)
    setExportSeedPW('')
    setExportSeedError('')
    setExportSeedResult(null)
  }, [])

  const closeImportAccount = useCallback(() => {
    setShowImportAccount(false)
    setImportFile(null)
    setImportError('')
    if (accountFileRef.current) accountFileRef.current.value = ''
  }, [])

  const closeCompanionApp = useCallback(() => {
    setShowCompanionApp(false)
    setCompanionUnpaired(false)
  }, [])

  const closeGameCode = useCallback(() => {
    setShowGameCode(false)
    setGameCode('')
    setGameCodeMsg('')
    setGameCodeError('')
    setGameCodeSuccess(null)
  }, [])

  // -- Sign out --
  // Mirrors vanilla `app.ts` `signOut()` (L1565): on error, display
  // the server's message. On success, clearing `authed` causes the
  // router's AuthGuard to redirect to `/login` on the next render —
  // the component unmounts, so there's no need to reset loading state.
  //
  // Special-cases `activeOrdersErr`: instead of blocking the user with
  // an inline error, opens a confirmation overlay that lets them
  // force-sign-out after acknowledging the risk.
  const handleSignOut = useCallback(async () => {
    setSignOutError('')
    setSignOutLoading(true)
    const result = await logout()
    if (result.ok) return
    setSignOutLoading(false)
    if (result.code === Errors.activeOrdersErr) {
      setShowForceSignOut(true)
      return
    }
    setSignOutError(result.msg)
  }, [logout])

  // Confirmed sign-out path — calls logout(true) to bypass the
  // server-side active-orders check. AuthGuard unmounts on success,
  // so we only need to handle the error path here.
  const handleForceSignOut = useCallback(async () => {
    setSignOutError('')
    setSignOutLoading(true)
    const result = await logout(true)
    if (result.ok) return
    setSignOutLoading(false)
    setShowForceSignOut(false)
    setSignOutError(result.msg)
  }, [logout])

  const isPaired = companionAppPaired && !companionUnpaired

  return (
    <div className="py-3 px-3 overflow-y-auto" style={{ height: '100%' }}>
      <h2 className="mb-4">{t('Settings')}</h2>

      {/* -- Appearance toggles -- */}
      <div className="mb-4">
        <h5>{t('Appearance')}</h5>
        <div className="form-check mb-2">
          <input
            className="form-check-input"
            type="checkbox"
            id="darkModeToggle"
            checked={darkMode}
            onChange={toggleDarkMode}
          />
          <label className="form-check-label" htmlFor="darkModeToggle">
            {t('Dark Mode')}
          </label>
        </div>
        <div className="form-check mb-2">
          <input
            className="form-check-input"
            type="checkbox"
            id="showPopupsToggle"
            checked={showPopups}
            onChange={togglePopups}
          />
          <label className="form-check-label" htmlFor="showPopupsToggle">
            {t('Show popups')}
          </label>
        </div>
      </div>

      {/* -- Registered DEXes -- */}
      <div className="mb-4">
        <h5>{t('Registered DEXes')}</h5>
        {exchangeList.length === 0
? (
          <p className="text-secondary">{t('No DEXes registered')}</p>
        )
: (
          <div className="mb-2">
            {exchangeList.map(xc => (
              <div
                key={xc.host}
                className="d-flex align-items-center p-2 pointer border-bottom"
                onClick={() => navigate(dexSettingsPath(xc.host))}
              >
                <span className="flex-grow-1">{xc.host}</span>
                <span className="ico-settings fs14" />
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-primary" onClick={() => { setRegStep('dexAddress'); setShowAddDex(true) }}>
          {t('Add a DEX')}
        </button>
      </div>

      {/* -- Fiat rate sources -- */}
      {fiatRateSources.length > 0 && (
        <div className="mb-4">
          <h5>{t('Fiat Exchange Rate Sources')}</h5>
          {fiatRateSources.map((src: any) => (
            <div key={src.id} className="form-check mb-1">
              <input
                className="form-check-input"
                type="checkbox"
                id={`ratesrc-${src.id}`}
                checked={!src.disabled}
                disabled={!!fiatSourcesLoading[src.id]}
                onChange={() => toggleRateSource(src.id, !src.disabled)}
              />
              <label className="form-check-label" htmlFor={`ratesrc-${src.id}`}>
                {src.id}
              </label>
            </div>
          ))}
        </div>
      )}

      {/* -- Security -- */}
      <div className="mb-4">
        <h5>{t('Security')}</h5>
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-secondary" onClick={() => setShowChangePW(true)}>
            {t('Change App Password')}
          </button>
          <button className="btn btn-outline-secondary" onClick={() => setShowResetPW(true)}>
            {t('Reset App Password')}
          </button>
        </div>
      </div>

      {/* -- Account management -- */}
      <div className="mb-4">
        <h5>{t('Account Management')}</h5>
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-secondary" onClick={() => { setImportFile(null); setImportError(''); setShowImportAccount(true) }}>
            {t('Import Account')}
          </button>
          <button className="btn btn-outline-secondary" onClick={() => { setExportSeedResult(null); setExportSeedError(''); setExportSeedPW(''); setShowExportSeed(true) }}>
            {t('Export Seed')}
          </button>
          <button className="btn btn-outline-secondary" onClick={exportLogs}>
            {t('Export Logs')}
          </button>
        </div>
      </div>

      {/* -- Desktop notifications -- */}
      <div className="mb-4">
        <h5>{t('Desktop Notifications')}</h5>
        {ntfnPermissionBlocked
? (
          <p className="text-danger fs14">{t('Browser notifications are blocked. Please enable them in your browser settings.')}</p>
        )
: (
          <>
            <div className="form-check mb-2">
              <input
                className="form-check-input"
                type="checkbox"
                id="browserNtfnEnabled"
                checked={!!ntfnSettings.browserNtfnEnabled}
                onChange={toggleBrowserNtfn}
              />
              <label className="form-check-label" htmlFor="browserNtfnEnabled">
                {t('Enable browser notifications')}
              </label>
            </div>
            {ntfnSettings.browserNtfnEnabled && (
              <div className="ps-3">
                {Object.entries(noteTypes).map(([noteType, label]) => (
                  <div key={noteType} className="form-check mb-1">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id={`ntfn-${noteType}`}
                      checked={ntfnSettings[noteType] !== false}
                      onChange={() => toggleNtfnType(noteType)}
                    />
                    <label className="form-check-label" htmlFor={`ntfn-${noteType}`}>
                      {t(label)}
                    </label>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* -- Companion app -- */}
      <div className="mb-4">
        <h5>{t('Companion App')}</h5>
        <button className="btn btn-outline-secondary" onClick={() => setShowCompanionApp(true)}>
          {t('Companion App Settings')}
        </button>
      </div>

      {/* -- Game code -- */}
      <div className="mb-4">
        <h5>{t('Game Code')}</h5>
        <button className="btn btn-outline-secondary" onClick={() => setShowGameCode(true)}>
          {t('Redeem Game Code')}
        </button>
      </div>

      {/* -- Order history -- */}
      <div className="mb-4">
        <h5>{t('Order History')}</h5>
        <button className="btn btn-outline-secondary" onClick={() => navigate(ROUTES.ORDERS)}>
          {t('view')}
        </button>
      </div>

      {/* -- Sign out -- */}
      <div className="mb-4">
        <h5>{t('Sign Out')}</h5>
        {signOutError && (
          <div className="fs15 text-danger mb-2">{signOutError}</div>
        )}
        <button
          className="btn btn-outline-danger"
          onClick={handleSignOut}
          disabled={signOutLoading}
        >
          {signOutLoading ? '...' : t('Sign Out')}
        </button>
      </div>

      {/* ==== OVERLAYS ==== */}

      {/* -- Add DEX overlay -- */}
      <FormOverlay show={showAddDex} onClose={closeAddDex}>
        {regStep === 'dexAddress' && (
          <DEXAddressForm onSuccess={handleDexAddressSuccess} />
        )}

        {regStep === 'feeAsset' && regExchange && (
          <FeeAssetSelectionForm
            exchange={regExchange}
            certFile={regCertFile}
            onSuccess={handleFeeAssetSuccess}
          />
        )}

        {regStep === 'newWallet' && regAssetID !== null && (
          <NewWalletForm
            assetID={regAssetID}
            onSuccess={handleNewWalletSuccess}
            onBack={() => setRegStep('feeAsset')}
          />
        )}

        {regStep === 'walletWait' && regExchange && regAssetID !== null && (
          <WalletWaitForm
            exchange={regExchange}
            assetID={regAssetID}
            bondFeeBuffer={regBondFeeBuffer}
            tier={regTier}
            onSuccess={handleWalletWaitSuccess}
            onBack={async () => setRegStep('feeAsset')}
          />
        )}

        {regStep === 'confirm' && regExchange && regAssetID !== null && (
          <ConfirmRegistrationForm
            exchange={regExchange}
            certFile={regCertFile}
            bondAssetID={regAssetID}
            tier={regTier}
            fees={regBondFeeBuffer}
            onSuccess={handleConfirmSuccess}
            onBack={async () => setRegStep('feeAsset')}
          />
        )}
      </FormOverlay>

      {/* -- Change password overlay -- */}
      <FormOverlay show={showChangePW} onClose={closeChangePW}>
        <div className="fs20 mb-3">{t('Change App Password')}</div>
        <div className="mb-2">
          <label className="form-label">{t('Current Password')}</label>
          <input
            type="password"
            className="form-control"
            value={currentPW}
            onChange={e => setCurrentPW(e.target.value)}
            autoFocus
            disabled={changePWLoading}
          />
        </div>
        <div className="mb-2">
          <label className="form-label">{t('New Password')}</label>
          <input
            type="password"
            className="form-control"
            value={newPW}
            onChange={e => setNewPW(e.target.value)}
            disabled={changePWLoading}
          />
        </div>
        <div className="mb-2">
          <label className="form-label">{t('Confirm New Password')}</label>
          <input
            type="password"
            className="form-control"
            value={confirmNewPW}
            onChange={e => setConfirmNewPW(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitChangePassword() }}
            disabled={changePWLoading}
          />
        </div>
        {changePWError && (
          <div className="fs15 text-danger mb-2">{changePWError}</div>
        )}
        {/* Disable + spinner during the password-change round trip,
            matching the SP-06 export-seed pattern and vanilla
            `settings.ts` `changeAppPW()` (L450) `app().loading()`. */}
        <button
          className="btn btn-primary w-100"
          onClick={submitChangePassword}
          disabled={changePWLoading}
        >
          {changePWLoading ? '...' : t('Submit')}
        </button>
      </FormOverlay>

      {/* -- Reset password overlay -- */}
      <FormOverlay show={showResetPW} onClose={() => setShowResetPW(false)}>
        <AppPassResetForm onSuccess={handleResetPWSuccess} />
      </FormOverlay>

      {/* -- Import account overlay -- */}
      <FormOverlay show={showImportAccount} onClose={closeImportAccount}>
        <div className="fs20 mb-3">{t('Import Account')}</div>
        <div className="mb-3">
          <input
            ref={accountFileRef}
            type="file"
            className="form-control"
            accept=".json"
            onChange={handleImportFileChange}
            disabled={importLoading}
          />
          {/* SP-01: show a persistent "none selected" label when no
              file is chosen, mirroring vanilla `settings.ts`
              `clearAccountFile()` (L339) which sets
              `selectedAccount.textContent = intl.prep(intl.ID_NONE_SELECTED)`.
              Without this, removing a previously-chosen file leaves
              no visible feedback that the form is now empty. */}
          {importFile
            ? (
            <div className="fs14 mt-1 d-flex align-items-center gap-2">
              <span>{importFile.name}</span>
              <button
                className="btn btn-sm btn-outline-danger"
                onClick={() => { setImportFile(null); if (accountFileRef.current) accountFileRef.current.value = '' }}
                disabled={importLoading}
              >
                {t('Remove')}
              </button>
            </div>
              )
            : (
            <div className="fs14 mt-1 text-secondary">{t('NONE_SELECTED')}</div>
              )}
        </div>
        {importError && (
          <div className="fs15 text-danger mb-2">{importError}</div>
        )}
        <button
          className="btn btn-primary w-100"
          onClick={submitImportAccount}
          disabled={importLoading || !importFile}
        >
          {importLoading
? '...'
: t('Import')}
        </button>
      </FormOverlay>

      {/* -- Export seed overlay -- */}
      <FormOverlay show={showExportSeed} onClose={closeExportSeed}>
        {!exportSeedResult
? (
          <>
            <div className="fs20 mb-3">{t('Export Seed')}</div>
            <div className="mb-2">
              <label className="form-label">{t('App Password')}</label>
              <input
                type="password"
                className="form-control"
                value={exportSeedPW}
                onChange={e => setExportSeedPW(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitExportSeed() }}
                autoFocus
                disabled={exportSeedLoading}
              />
            </div>
            {exportSeedError && (
              <div className="fs15 text-danger mb-2">{exportSeedError}</div>
            )}
            {/* SP-06: disable + spinner during password check, matching
                vanilla's `app().loading()` overlay around the
                `/api/exportseed` round trip. */}
            <button
              className="btn btn-primary w-100"
              onClick={submitExportSeed}
              disabled={exportSeedLoading || !exportSeedPW}
            >
              {exportSeedLoading ? '...' : t('Submit')}
            </button>
          </>
        )
: (
          <>
            <div className="fs20 mb-3">{t('Your Seed')}</div>
            {exportSeedResult.legacy && (
              <pre className="border rounded p-2 text-break user-select-all fs14">
                {exportSeedResult.legacy}
              </pre>
            )}
            {exportSeedResult.mnemonic && (
              <pre className="border rounded p-2 text-break user-select-all fs14">
                {exportSeedResult.mnemonic}
              </pre>
            )}
            <button className="btn btn-secondary w-100 mt-2" onClick={closeExportSeed}>
              {t('Close')}
            </button>
          </>
        )}
      </FormOverlay>

      {/* -- Companion app overlay -- */}
      <FormOverlay show={showCompanionApp} onClose={closeCompanionApp}>
        <div className="fs20 mb-3">{t('Companion App')}</div>
        {isPaired
? (
          <div>
            <p className="fs15 text-success mb-2">{t('Companion app is paired')}</p>
            <button className="btn btn-outline-danger w-100" onClick={unpairCompanionApp}>
              {t('Unpair')}
            </button>
          </div>
        )
: (
          <div>
            {onionUrl !== ''
? (
              <div>
                <p className="fs14 mb-2">{t('Scan the QR code with the companion app.')}</p>
                <div className="text-center mb-2">
                  <img src="/generatecompanionappqrcode" alt="QR code" style={{ maxWidth: '200px' }} />
                </div>
              </div>
            )
: (
              <p className="fs15 text-warning">{t('Tor is not enabled. Enable Tor to use the companion app.')}</p>
            )}
          </div>
        )}
      </FormOverlay>

      {/* -- Game code overlay -- */}
      <FormOverlay show={showGameCode} onClose={closeGameCode}>
        <div className="fs20 mb-3">{t('Redeem Game Code')}</div>
        <div className="mb-2">
          <label className="form-label">{t('Code')}</label>
          <input
            type="text"
            className="form-control"
            value={gameCode}
            onChange={e => setGameCode(e.target.value)}
            autoFocus
          />
        </div>
        <div className="mb-2">
          <label className="form-label">{t('Message (optional)')}</label>
          <input
            type="text"
            className="form-control"
            value={gameCodeMsg}
            onChange={e => setGameCodeMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitGameCode() }}
          />
        </div>
        <button
          className="btn btn-primary w-100"
          onClick={submitGameCode}
          disabled={!gameCode}
        >
          {t('Submit')}
        </button>

        {/* SP-07: render the success block with vanilla's structure
            (settings.tmpl L177-184): "Game code redeemed" header,
            "Transaction" label with anchor link to the DCR explorer,
            "Value: X DCR" formatted via `formatCoinValueAtom` against
            DCR's unit info. Mirrors vanilla `settings.ts`
            `submitGameCode()` (L504-528) which uses
            `setCoinHref(dcrBipID, ...)` + `Doc.formatCoinAtom(win, ui)`.
            Both success and error blocks live AFTER the submit
            button to match vanilla's `gameCodeSuccess` / `gameCodeErr`
            ordering in `settings.tmpl`. */}
        {gameCodeSuccess && (() => {
          const dcrAsset = assets[DCRAssetID]
          const dcrUI = dcrAsset?.unitInfo
          const net = user?.net ?? 0
          const explorerHref = explorerURL(DCRAssetID, gameCodeSuccess.coinString, net)
          return (
            <div className="mt-3 pt-3 border-top">
              <div className="fs15 text-success mb-2">{t('Game code redeemed')}</div>
              <div className="fs14 mb-1">{t('Transaction')}</div>
              {explorerHref
                ? (
                <a
                  href={explorerHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fs14 text-break d-block mb-2"
                >
                  {gameCodeSuccess.coinString}
                </a>
                  )
                : (
                <div className="fs14 text-break mb-2">{gameCodeSuccess.coinString}</div>
                  )}
              <div className="fs14">
                {t('Value')}: <span>{formatCoinAtom(gameCodeSuccess.win, dcrUI)}</span>{' '}
                <span className="fs12 text-secondary">DCR</span>
              </div>
            </div>
          )
        })()}

        {gameCodeError && (
          <div className="fs15 text-danger mt-2 text-break">{gameCodeError}</div>
        )}
      </FormOverlay>

      {/* -- Force sign-out confirmation overlay -- */}
      <FormOverlay
        show={showForceSignOut}
        onClose={() => { if (!signOutLoading) setShowForceSignOut(false) }}
      >
        <div className="fs20 mb-3">{t('Sign Out')}</div>
        <div className="fs15 mb-3 text-danger">{t('FORCE_SIGN_OUT_WARNING')}</div>
        <div className="d-flex gap-2">
          <button
            className="btn btn-secondary flex-grow-1"
            onClick={() => setShowForceSignOut(false)}
            disabled={signOutLoading}
          >
            {t('Cancel')}
          </button>
          <button
            className="btn btn-outline-danger flex-grow-1"
            onClick={handleForceSignOut}
            disabled={signOutLoading}
          >
            {signOutLoading ? '...' : t('Sign Out')}
          </button>
        </div>
      </FormOverlay>
    </div>
  )
}
