import { useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useUIStore } from '../stores/useUIStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { DEXAddressForm } from '../components/common/DEXAddressForm'
import { FeeAssetSelectionForm } from '../components/common/FeeAssetSelectionForm'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletWaitForm } from '../components/common/WalletWaitForm'
import { ConfirmRegistrationForm } from '../components/common/ConfirmRegistrationForm'
import { AppPassResetForm } from '../components/common/AppPassResetForm'
import { ROUTES, dexSettingsPath } from '../router/routes'
import type { Exchange } from '../stores/types'
import { PrepaidBondID } from '../stores/types'

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

  // -- Import account --
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const accountFileRef = useRef<HTMLInputElement>(null)

  // -- Export seed --
  const [exportSeedPW, setExportSeedPW] = useState('')
  const [exportSeedError, setExportSeedError] = useState('')
  const [exportSeedResult, setExportSeedResult] = useState<{ legacy?: string; mnemonic?: string } | null>(null)

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

  // Fiat rate sources from user data.
  const fiatRateSources = useMemo(() => {
    if (!user) return []
    // user.fiatRates keys are asset IDs; the rate sources are on the user
    // object at the top level. Scan user for fiatRateSources field.
    return (user as any).fiatRateSources ?? []
  }, [user])

  // DEX list for navigation.
  const exchangeList = useMemo(() => Object.values(exchanges), [exchanges])

  // -- Notification handlers (none needed for settings, but kept for consistency) --
  useNotifications(useMemo(() => ({}), []))

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
    const res = await postJSON('/api/changeapppass', {
      appPW: currentPW,
      newAppPW: newPW,
    })
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
      setImportError(t('No file selected'))
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
    const res = await postJSON('/api/exportseed', { pass: exportSeedPW })
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
      setGameCodeError(t('No code provided'))
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

  const isPaired = companionAppPaired && !companionUnpaired

  return (
    <div className="py-3 px-3">
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

      {/* ==== OVERLAYS ==== */}

      {/* -- Add DEX overlay -- */}
      <FormOverlay show={showAddDex} onClose={closeAddDex}>
        <div className="col-12 col-sm-10 col-md-8 col-lg-6 mx-auto">
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
        </div>
      </FormOverlay>

      {/* -- Change password overlay -- */}
      <FormOverlay show={showChangePW} onClose={closeChangePW}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
          <div className="fs20 mb-3">{t('Change App Password')}</div>
          <div className="mb-2">
            <label className="form-label">{t('Current Password')}</label>
            <input
              type="password"
              className="form-control"
              value={currentPW}
              onChange={e => setCurrentPW(e.target.value)}
              autoFocus
            />
          </div>
          <div className="mb-2">
            <label className="form-label">{t('New Password')}</label>
            <input
              type="password"
              className="form-control"
              value={newPW}
              onChange={e => setNewPW(e.target.value)}
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
            />
          </div>
          {changePWError && (
            <div className="fs15 text-danger mb-2">{changePWError}</div>
          )}
          <button className="btn btn-primary w-100" onClick={submitChangePassword}>
            {t('Submit')}
          </button>
        </div>
      </FormOverlay>

      {/* -- Reset password overlay -- */}
      <FormOverlay show={showResetPW} onClose={() => setShowResetPW(false)}>
        <AppPassResetForm onSuccess={handleResetPWSuccess} />
      </FormOverlay>

      {/* -- Import account overlay -- */}
      <FormOverlay show={showImportAccount} onClose={closeImportAccount}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
          <div className="fs20 mb-3">{t('Import Account')}</div>
          <div className="mb-3">
            <input
              ref={accountFileRef}
              type="file"
              className="form-control"
              accept=".json"
              onChange={handleImportFileChange}
            />
            {importFile && (
              <div className="fs14 mt-1 d-flex align-items-center gap-2">
                <span>{importFile.name}</span>
                <button
                  className="btn btn-sm btn-outline-danger"
                  onClick={() => { setImportFile(null); if (accountFileRef.current) accountFileRef.current.value = '' }}
                >
                  {t('Remove')}
                </button>
              </div>
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
        </div>
      </FormOverlay>

      {/* -- Export seed overlay -- */}
      <FormOverlay show={showExportSeed} onClose={closeExportSeed}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
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
                />
              </div>
              {exportSeedError && (
                <div className="fs15 text-danger mb-2">{exportSeedError}</div>
              )}
              <button className="btn btn-primary w-100" onClick={submitExportSeed}>
                {t('Submit')}
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
        </div>
      </FormOverlay>

      {/* -- Companion app overlay -- */}
      <FormOverlay show={showCompanionApp} onClose={closeCompanionApp}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
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
        </div>
      </FormOverlay>

      {/* -- Game code overlay -- */}
      <FormOverlay show={showGameCode} onClose={closeGameCode}>
        <div className="px-4 py-3" style={{ minWidth: '320px' }}>
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
          {gameCodeError && (
            <div className="fs15 text-danger mb-2">{gameCodeError}</div>
          )}
          {gameCodeSuccess && (
            <div className="fs15 text-success mb-2">
              {t('Success!')} {t('TX')}: {gameCodeSuccess.coinString}
            </div>
          )}
          <button className="btn btn-primary w-100" onClick={submitGameCode}>
            {t('Submit')}
          </button>
        </div>
      </FormOverlay>
    </div>
  )
}
