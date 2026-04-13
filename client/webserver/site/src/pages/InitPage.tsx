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
          <div className="form-closer">
            <div className="px-3 py-2">
              <div className="fs20 mb-2">{t('Set App Password')}</div>

              <div className="mb-3">
                <label htmlFor="appPW">{t('Password')}</label>
                <input
                  id="appPW"
                  type="password"
                  className="form-control"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') document.getElementById('appPWAgain')?.focus() }}
                  autoFocus
                  disabled={passwordLoading}
                />
              </div>

              <div className="mb-3">
                <label htmlFor="appPWAgain">{t('Confirm Password')}</label>
                <input
                  id="appPWAgain"
                  type="password"
                  className="form-control"
                  value={passwordConfirm}
                  onChange={e => setPasswordConfirm(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitPassword() }}
                  disabled={passwordLoading}
                />
              </div>

              <div
                className="d-flex align-items-center gap-1 fs14 pointer mb-2"
                onClick={() => setShowSeedInput(!showSeedInput)}
              >
                <span className={showSeedInput ? 'ico-minus' : 'ico-plus'} />
                <span>{t('Restore from seed')}</span>
              </div>

              {showSeedInput && (
                <div className="mb-3">
                  <label htmlFor="seedInput">{t('Seed')}</label>
                  <textarea
                    id="seedInput"
                    className="form-control"
                    rows={3}
                    value={seed}
                    onChange={e => setSeed(e.target.value)}
                    disabled={passwordLoading}
                  />
                </div>
              )}

              {passwordError && (
                <div className="fs15 text-danger mb-2">{passwordError}</div>
              )}

              <button
                className="btn btn-primary w-100"
                onClick={submitPassword}
                disabled={passwordLoading}
              >
                {passwordLoading ? '...' : t('Submit')}
              </button>
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
          <div className="form-closer">
            <div className="px-3 py-2" style={{ position: 'relative', minHeight: quickConfigLoading ? '200px' : undefined }}>
              {quickConfigLoading && (
                <Wave message={quickConfigMessage} backgroundColor={true} />
              )}

              {!quickConfigLoading && !showErrors && (
                <>
                  <div className="fs20 mb-2">{t('Quick Configuration')}</div>

                  {servers.length > 0 && (
                    <div className="mb-3">
                      <div className="fs16 mb-1">{t('Servers')}</div>
                      {servers.map((srv, idx) => (
                        <label key={srv.host} className="d-flex align-items-center gap-2 p-1 pointer">
                          <input
                            type="checkbox"
                            className="form-check-input"
                            checked={srv.checked}
                            onChange={() => toggleServer(idx)}
                          />
                          <span className="fs15">{srv.host}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {wallets.length > 0 && (
                    <div className="mb-3">
                      <div className="fs16 mb-1">{t('Wallets')}</div>
                      {wallets.map((wRow, idx) => (
                        <label key={wRow.asset.id} className="d-flex align-items-center gap-2 p-1 pointer">
                          <input
                            type="checkbox"
                            className="form-check-input"
                            checked={wRow.checked}
                            onChange={() => toggleWallet(idx)}
                          />
                          <img
                            className="micro-icon"
                            src={logoPath(wRow.asset.symbol)}
                            alt=""
                          />
                          <span className="fs15">{wRow.asset.name}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  <button
                    className="btn btn-primary w-100"
                    onClick={submitQuickConfig}
                  >
                    {t('Submit')}
                  </button>
                </>
              )}

              {!quickConfigLoading && showErrors && (
                <>
                  <div className="fs20 mb-2">{t('Configuration Errors')}</div>

                  {failedHosts.length > 0 && (
                    <div className="mb-3">
                      <div className="fs16 mb-1 text-danger">{t('Failed to add servers')}</div>
                      {failedHosts.map(host => (
                        <div key={host} className="fs14">{host}</div>
                      ))}
                    </div>
                  )}

                  {failedWallets.length > 0 && (
                    <div className="mb-3">
                      <div className="fs16 mb-1 text-danger">{t('Failed to create wallets')}</div>
                      {failedWallets.map(name => (
                        <div key={name} className="fs14">{name}</div>
                      ))}
                    </div>
                  )}

                  <button
                    className="btn btn-primary w-100"
                    onClick={acknowledgeErrors}
                  >
                    {t('Continue')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // step === 'seedBackup'
  return (
    <div className="d-flex align-items-center justify-content-center py-5">
      <div className="col-12 col-sm-8 col-md-6 col-lg-4">
        <div className="form-closer">
          <div className="px-3 py-2">
            <div className="fs20 mb-2">{t('Back Up App Seed')}</div>

            {!seedRevealed
? (
              <div>
                <p className="fs15">
                  {t('SEED_BACKUP_MSG')}
                </p>
                <button
                  className="btn btn-primary w-100 mb-2"
                  onClick={() => setSeedRevealed(true)}
                >
                  {t('Show Seed')}
                </button>
                <button
                  className="btn btn-secondary w-100"
                  onClick={finishSeedBackup}
                >
                  {t('Skip')}
                </button>
              </div>
            )
: (
              <div>
                <div className="fs14 text-break user-select-all border rounded p-3 mb-3">
                  {mnemonic}
                </div>
                <button
                  className="btn btn-primary w-100"
                  onClick={finishSeedBackup}
                >
                  {t("I've backed it up")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
