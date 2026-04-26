import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { Wave } from '../components/charts/Wave'
import { WalletConfigForm } from '../components/common/WalletConfigForm'
import type { WalletConfigFormHandle } from '../components/common/WalletConfigForm'
import { ROUTES } from '../router/routes'
import type { SupportedAsset, WalletDefinition } from '../stores/types'
import { logoPath } from '../hooks/useFormatters'

type Step = 'password' | 'quickConfig' | 'seedBackup'

interface WalletRow {
  asset: SupportedAsset
  walletDef: WalletDefinition
  checked: boolean
  // needsConfig is true when the chosen wallet definition has any required
  // configopts (e.g. XMR's `daemonaddress`). Such rows render an inline
  // WalletConfigForm when checked and default to unchecked so users
  // explicitly opt in (and aren't surprised by a creation failure mid-submit).
  needsConfig: boolean
}

/** Build a config map from a wallet definition's default values. */
function buildConfigFromDefaults (walletDef: WalletDefinition): Record<string, string> {
  const config: Record<string, string> = {}
  for (const opt of walletDef.configopts ?? []) {
    if (!opt.default) continue
    if (opt.isboolean) {
      config[opt.key] = opt.default ? '1' : '0'
      continue
    }
    if (opt.repeatable && config[opt.key]) {
      config[opt.key] += opt.repeatable + opt.default
    } else {
      config[opt.key] = String(opt.default)
    }
  }
  return config
}

export default function InitPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [step, setStep] = useState<Step>('password')

  // Password stage state.
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [seed, setSeed] = useState('')
  const [showSeedInput, setShowSeedInput] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)

  // Kept across stages for quickConfig submissions.
  const [savedPassword, setSavedPassword] = useState('')
  const [mnemonic, setMnemonic] = useState<string | undefined>(undefined)

  // QuickConfig stage state. Known DEX servers are auto-added by /api/init,
  // so QuickConfig is wallet-only on the client.
  const [wallets, setWallets] = useState<WalletRow[]>([])
  const [quickConfigLoading, setQuickConfigLoading] = useState(false)
  const [quickConfigMessage, setQuickConfigMessage] = useState('')
  const [failedWallets, setFailedWallets] = useState<string[]>([])
  const [showErrors, setShowErrors] = useState(false)

  // Seed backup stage state.
  const [seedRevealed, setSeedRevealed] = useState(false)

  // Refs to inline WalletConfigForm instances, keyed by asset id. Populated
  // by the form's ref callback at mount; entries removed at unmount (when
  // the user unchecks a row). `submitQuickConfig` reads from this map for
  // required-config wallets only — defaulted wallets fall through to
  // `buildConfigFromDefaults`.
  const walletConfigRefs = useRef<Map<number, WalletConfigFormHandle>>(new Map())

  // ---------- Stage 1: Password ----------

  const submitPassword = useCallback(async () => {
    setPasswordError('')
    if (password === '') {
      setPasswordError(t('NO_PASS_ERROR_MSG'))
      return
    }
    if (password !== passwordConfirm) {
      setPasswordError(t('PASSWORD_NOT_MATCH'))
      return
    }

    setPasswordLoading(true)
    const res = await postJSON('/api/init', { pass: password, seed: seed })
    setPasswordLoading(false)

    if (!checkResponse(res)) {
      setPasswordError(res.msg)
      return
    }

    const responseMnemonic: string | undefined = res.mnemonic
    setSavedPassword(password)
    setPassword('')
    setPasswordConfirm('')
    setSeed('')
    setMnemonic(responseMnemonic)

    // Build wallet rows from fetched user data. Pick the first seeded
    // wallet definition for each asset — required-config wallets (e.g. XMR)
    // are now included too, but get an inline WalletConfigForm and start
    // unchecked so the user has to opt in.
    const user = await fetchUser()
    if (user) {
      const walletRows: WalletRow[] = []
      for (const asset of Object.values(user.assets)) {
        if (asset.token) continue
        const winfo = asset.info
        if (!winfo) continue
        let chosenDef: WalletDefinition | null = null
        for (const wDef of winfo.availablewallets) {
          if (!wDef.seeded) continue
          chosenDef = wDef
          break
        }
        if (!chosenDef) continue
        const needsConfig = !!chosenDef.configopts?.some(o => o.required)
        walletRows.push({
          asset,
          walletDef: chosenDef,
          checked: !needsConfig,
          needsConfig,
        })
      }
      setWallets(walletRows)
    }

    setStep('quickConfig')
  }, [password, passwordConfirm, seed, t, fetchUser])

  // ---------- Stage 2: QuickConfig ----------

  const toggleWallet = useCallback((index: number) => {
    setWallets(prev => prev.map((w, i) => i === index ? { ...w, checked: !w.checked } : w))
  }, [])

  const submitQuickConfig = useCallback(async () => {
    setQuickConfigLoading(true)
    setShowErrors(false)
    const walletFailures: string[] = []

    // Create wallets in parallel. For required-config rows, the user-supplied
    // values come from the inline WalletConfigForm via the ref map; for
    // auto-configurable rows we keep the default-derived config.
    setQuickConfigMessage(t('CREATING_WALLETS'))
    const walletPromises = wallets
      .filter(w => w.checked)
      .map(async (w) => {
        const { asset, walletDef, needsConfig } = w
        let config: Record<string, string>
        if (needsConfig) {
          const handle = walletConfigRefs.current.get(asset.id)
          config = handle?.getConfigMap(asset.id) ?? {}
        } else {
          config = buildConfigFromDefaults(walletDef)
        }
        const res = await postJSON('/api/newwallet', {
          assetID: asset.id,
          appPass: savedPassword,
          config,
          walletType: walletDef.type,
        })
        if (!checkResponse(res)) walletFailures.push(asset.name)
      })
    await Promise.all(walletPromises)

    setQuickConfigLoading(false)
    setQuickConfigMessage('')
    await fetchUser()

    if (walletFailures.length > 0) {
      setFailedWallets(walletFailures)
      setShowErrors(true)
      return
    }

    if (mnemonic) {
      setStep('seedBackup')
    } else {
      navigate(ROUTES.WALLETS)
    }
  }, [wallets, savedPassword, t, fetchUser, mnemonic, navigate])

  const acknowledgeErrors = useCallback(() => {
    if (mnemonic) {
      setStep('seedBackup')
    } else {
      navigate(ROUTES.WALLETS)
    }
  }, [mnemonic, navigate])

  // ---------- Stage 3: Seed Backup ----------

  const finishSeedBackup = useCallback(async () => {
    await fetchUser()
    navigate(ROUTES.WALLETS)
  }, [fetchUser, navigate])

  // ---------- Render ----------

  if (step === 'password') {
    return (
      <div className="d-flex align-items-center justify-content-center py-5">
        <div className="col-12 col-sm-8 col-md-6 col-lg-4">
          <div>
            <header className="flex-center py-3 lh1 border-bottom fs26">
              <span className="ico-locked fs20 grey me-2" />
              <span>{t('SET_APP_PASSWORD')}</span>
            </header>

            <div className="px-2">
              <div className="fs18 py-3">{t('REG_SET_APP_PW_MSG', { brand: 'Bison Wallet' })}</div>

              <div className="mt-3 border-top pt-3">
                <label htmlFor="appPW">{t('Password')}</label>
                <input
                  id="appPW"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') document.getElementById('appPWAgain')?.focus() }}
                  autoFocus
                  disabled={passwordLoading}
                />
              </div>

              <div className="pt-2">
                <label htmlFor="appPWAgain">{t('PASSWORD_AGAIN')}</label>
                <input
                  id="appPWAgain"
                  type="password"
                  autoComplete="off"
                  value={passwordConfirm}
                  onChange={e => setPasswordConfirm(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitPassword() }}
                  disabled={passwordLoading}
                />
              </div>

              <div className="d-flex pt-3">
                <div className="flex-grow-1 d-flex align-items-center">
                  <label
                    className="pointer d-flex align-items-center"
                    onClick={() => setShowSeedInput(!showSeedInput)}
                  >
                    <span className={`fs11 ${showSeedInput ? 'ico-minus' : 'ico-plus'} me-1`} />
                    {t('RESTORATION_SEED')}
                  </label>
                </div>
                <button
                  className="feature flex-grow-1 ms-2"
                  onClick={submitPassword}
                  disabled={passwordLoading}
                >
                  {passwordLoading ? '...' : t('Submit')}
                </button>
              </div>

              {showSeedInput && (
                <div className="pt-2">
                  <textarea
                    id="seedInput"
                    className="w-100 mono"
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    value={seed}
                    onChange={e => setSeed(e.target.value)}
                    disabled={passwordLoading}
                  />
                  <div className="pt-2 text-center fs15 text-warning">
                    {t('SEED_SAME_WALLET_WARNING')}
                  </div>
                </div>
              )}

              {passwordError && (
                <div className="fs15 text-center text-danger text-break pt-2">{passwordError}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'quickConfig') {
    return (
      <div className="d-flex align-items-center justify-content-center py-5">
        <div className="col-12 col-sm-8 col-md-6 col-lg-4">
          <div style={{ position: 'relative', minHeight: quickConfigLoading ? '200px' : undefined }}>
            {quickConfigLoading && (
              <Wave message={quickConfigMessage} backgroundColor={true} />
            )}

            {!quickConfigLoading && !showErrors && (
              <>
                <header className="flex-center py-3 lh1 border-bottom fs26">
                  <span className="ico-settings fs22 grey me-2" />
                  <span>{t('QUICK_CONFIGURATION')}</span>
                </header>

                <div className="px-2 pt-3">
                  <div className="fs18 mb-2">{t('QUICKCONFIG_WALLET_HEADER')}</div>
                  <div className="mt-2">
                    {wallets.map((wRow, idx) => (
                      <div key={wRow.asset.id} className="my-1">
                        <label className="p-1 d-flex justify-content-start align-items-center hoverbg pointer">
                          <input
                            type="checkbox"
                            className="form-check-input"
                            checked={wRow.checked}
                            onChange={() => toggleWallet(idx)}
                          />
                          <img
                            className="quickconfig-asset-logo mx-2"
                            src={logoPath(wRow.asset.symbol)}
                            alt=""
                          />
                          <span className="fs20">{wRow.asset.name}</span>
                        </label>
                        {wRow.checked && wRow.needsConfig && (
                          <div className="ms-4 ps-3 border-start mb-2">
                            <WalletConfigForm
                              ref={(handle) => {
                                if (handle) walletConfigRefs.current.set(wRow.asset.id, handle)
                                else walletConfigRefs.current.delete(wRow.asset.id)
                              }}
                              assetID={wRow.asset.id}
                              configOpts={wRow.walletDef.configopts ?? []}
                              sectionize={true}
                              activeOrders={false}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    className="feature my-2 w-100"
                    onClick={submitQuickConfig}
                  >
                    {t('Submit')}
                  </button>
                </div>
              </>
            )}

            {!quickConfigLoading && showErrors && (
              <div className="px-2 pt-3">
                {failedWallets.length > 0 && (
                  <div className="my-1">
                    <span className="fs16">{t('QUICKCONFIG_WALLET_ERROR_HEADER')}</span>
                    <div className="p-2 my-1">
                      {failedWallets.map(name => (
                        <div key={name}>{name}</div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="d-flex justify-content-end my-1">
                  <button className="go" onClick={acknowledgeErrors}>
                    {t('Continue')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // step === 'seedBackup'
  return (
    <div className="d-flex align-items-center justify-content-center py-5">
      <div className="col-12 col-sm-8 col-md-6 col-lg-4">
        <div>
          <header className="flex-center py-3 lh1 border-bottom fs26">
            <span>{t('BACKUP_APP_SEED')}</span>
          </header>

          {!seedRevealed
? (
            <div className="px-2 pt-3">
              <div className="fs18 mb-3">
                {t('SEED_BACKUP_MSG')}
              </div>
              <div className="flex-stretch-column pt-2">
                <button className="feature" onClick={() => setSeedRevealed(true)}>
                  {t('BACKUP_NOW')}
                </button>
              </div>
              <div className="d-flex justify-content-end pt-3">
                <div
                  className="d-block plainlink fs15 flex-center hoverbg pointer"
                  onClick={finishSeedBackup}
                >
                  <span>{t('SKIP_THIS_STEP_FOR_NOW')}</span>
                  <span
                    className="ico-info mx-1"
                    title="You can backup your seed at any time in the Settings view"
                  />
                </div>
              </div>
            </div>
          )
: (
            <div className="px-2 pt-3">
              <div className="fs18 mb-3">{t('SAVE_SEED_INSTRUCTIONS')}</div>
              <div className="mt-2 border-top flex-center">
                <div className="fs18 mono mx-auto user-select-all text-break py-3">
                  {mnemonic}
                </div>
              </div>
              <div className="d-flex justify-content-end">
                <button className="feature" onClick={finishSeedBackup}>
                  {t('Done')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
