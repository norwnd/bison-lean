import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { Wave } from '../components/charts/Wave'
import { ROUTES } from '../router/routes'
import type { SupportedAsset, WalletDefinition } from '../stores/types'

type Step = 'password' | 'quickConfig' | 'seedBackup'

interface ServerRow {
  host: string
  checked: boolean
}

interface WalletRow {
  asset: SupportedAsset
  walletType: string
  checked: boolean
}

function logoPath (symbol: string): string {
  const base = symbol.split('.')[0]
  return `/img/coins/${base === 'weth' ? 'eth' : base}.png`
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

  // QuickConfig stage state.
  const [servers, setServers] = useState<ServerRow[]>([])
  const [wallets, setWallets] = useState<WalletRow[]>([])
  const [quickConfigLoading, setQuickConfigLoading] = useState(false)
  const [quickConfigMessage, setQuickConfigMessage] = useState('')
  const [failedHosts, setFailedHosts] = useState<string[]>([])
  const [failedWallets, setFailedWallets] = useState<string[]>([])
  const [showErrors, setShowErrors] = useState(false)

  // Seed backup stage state.
  const [seedRevealed, setSeedRevealed] = useState(false)

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

    const hosts: string[] = res.hosts ?? []
    const responseMnemonic: string | undefined = res.mnemonic
    setSavedPassword(password)
    setPassword('')
    setPasswordConfirm('')
    setSeed('')
    setMnemonic(responseMnemonic)

    // Build server rows.
    setServers(hosts.map(host => ({ host, checked: true })))

    // Build wallet rows from fetched user data.
    const user = await fetchUser()
    if (user) {
      const walletRows: WalletRow[] = []
      for (const asset of Object.values(user.assets)) {
        if (asset.token) continue
        const winfo = asset.info
        if (!winfo) continue
        let autoConfigurable: WalletDefinition | null = null
        for (const wDef of winfo.availablewallets) {
          if (!wDef.seeded) continue
          if (wDef.configopts?.some(o => o.required)) continue
          autoConfigurable = wDef
          break
        }
        if (!autoConfigurable) continue
        walletRows.push({
          asset,
          walletType: autoConfigurable.type,
          checked: true,
        })
      }
      setWallets(walletRows)
    }

    setStep('quickConfig')
  }, [password, passwordConfirm, seed, t, fetchUser])

  // ---------- Stage 2: QuickConfig ----------

  const toggleServer = useCallback((index: number) => {
    setServers(prev => prev.map((s, i) => i === index ? { ...s, checked: !s.checked } : s))
  }, [])

  const toggleWallet = useCallback((index: number) => {
    setWallets(prev => prev.map((w, i) => i === index ? { ...w, checked: !w.checked } : w))
  }, [])

  const submitQuickConfig = useCallback(async () => {
    setQuickConfigLoading(true)
    setShowErrors(false)
    const hostFailures: string[] = []
    const walletFailures: string[] = []

    // Add servers in parallel.
    setQuickConfigMessage(t('Adding servers...'))
    const serverPromises = servers
      .filter(s => s.checked)
      .map(async (s) => {
        const res = await postJSON('/api/adddex', { addr: s.host, appPW: savedPassword })
        if (!checkResponse(res)) hostFailures.push(s.host)
      })
    await Promise.all(serverPromises)

    // Create wallets in parallel.
    setQuickConfigMessage(t('Creating wallets...'))
    const walletPromises = wallets
      .filter(w => w.checked)
      .map(async (w) => {
        const { asset, walletType } = w
        // Find the wallet definition to build config from defaults.
        const winfo = asset.info
        let walletDef: WalletDefinition | null = null
        if (winfo) {
          for (const wDef of winfo.availablewallets) {
            if (wDef.type === walletType) { walletDef = wDef; break }
          }
        }
        const config = walletDef ? buildConfigFromDefaults(walletDef) : {}
        const res = await postJSON('/api/newwallet', {
          assetID: asset.id,
          appPass: savedPassword,
          config,
          walletType,
        })
        if (!checkResponse(res)) walletFailures.push(asset.name)
      })
    await Promise.all(walletPromises)

    setQuickConfigLoading(false)
    setQuickConfigMessage('')
    await fetchUser()

    if (hostFailures.length + walletFailures.length > 0) {
      setFailedHosts(hostFailures)
      setFailedWallets(walletFailures)
      setShowErrors(true)
      return
    }

    if (mnemonic) {
      setStep('seedBackup')
    } else {
      navigate(ROUTES.WALLETS)
    }
  }, [servers, wallets, savedPassword, t, fetchUser, mnemonic, navigate])

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
              <span>{t('Set App Password')}</span>
            </header>

            <div className="px-2">
              <div className="fs18 py-3">{t('reg_set_app_pw_msg', { brand: 'Bison Wallet' })}</div>

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
                <label htmlFor="appPWAgain">{t('Password Again')}</label>
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
                    {t('Restoration Seed')}
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
                    {t('seed_same_wallet_warning')}
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
                  <span>{t('Quick Configuration')}</span>
                </header>

                <div className="px-2 pt-3">
                  <div className="fs18 mb-2">{t('quickconfig_wallet_header')}</div>
                  <div className="mt-2">
                    {wallets.map((wRow, idx) => (
                      <label key={wRow.asset.id} className="p-1 d-flex justify-content-start align-items-center hoverbg pointer">
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
                    ))}
                  </div>

                  <div className="fs18 mt-3 pt-3 border-top">{t('quickconfig_server_header')}</div>
                  <div>
                    {servers.map((srv, idx) => (
                      <label key={srv.host} className="d-flex justify-content-start align-items-center p-1 hoverbg pointer my-1">
                        <input
                          type="checkbox"
                          className="form-check-input"
                          checked={srv.checked}
                          onChange={() => toggleServer(idx)}
                        />
                        <span className="ms-2 fs18 lh1">{srv.host}</span>
                      </label>
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
                    <span className="fs16">{t('quickconfig_wallet_error_header')}</span>
                    <div className="p-2 my-1">
                      {failedWallets.map(name => (
                        <div key={name}>{name}</div>
                      ))}
                    </div>
                  </div>
                )}

                {failedHosts.length > 0 && (
                  <div className="my-1">
                    <span className="fs16">{t('quickconfig_server_error_header')}</span>
                    <div className="p-2 my-1">
                      {failedHosts.map(host => (
                        <div key={host}>{host}</div>
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
            <span>{t('Backup App Seed')}</span>
          </header>

          {!seedRevealed
? (
            <div className="px-2 pt-3">
              <div className="fs18 mb-3">
                {t('SEED_BACKUP_MSG')}
              </div>
              <div className="flex-stretch-column pt-2">
                <button className="feature" onClick={() => setSeedRevealed(true)}>
                  {t('Backup Now')}
                </button>
              </div>
              <div className="d-flex justify-content-end pt-3">
                <div
                  className="d-block plainlink fs15 flex-center hoverbg pointer"
                  onClick={finishSeedBackup}
                >
                  <span>{t('Skip this step for now')}</span>
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
              <div className="fs18 mb-3">{t('save_seed_instructions')}</div>
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
