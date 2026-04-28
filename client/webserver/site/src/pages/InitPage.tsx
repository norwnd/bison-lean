import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { Wave } from '../components/charts/Wave'
import { WalletConfigForm } from '../components/common/WalletConfigForm'
import type { WalletConfigFormHandle } from '../components/common/WalletConfigForm'
import { ROUTES } from '../router/routes'
import type { SupportedAsset, WalletDefinition, UserResponse } from '../stores/types'
import { logoPath } from '../hooks/useFormatters'

// Symbols of the wallets we pre-check on the QuickConfig form. Picked to
// match the most common starter set: native BTC, native DCR, native POL.
// Users can still uncheck or add more before submitting.
const PRECHECKED_SYMBOLS = new Set(['btc', 'dcr', 'polygon'])

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

/**
 * Build a config map from a wallet definition's default values. Mirrors
 * how `WalletConfigForm.getConfigMap` emits values, so a wallet created
 * here looks the same to Core as one created via the full form:
 *  - Boolean opts always emit '0' or '1' (a missing key is a distinct
 *    "unset" state to some wallets, so we never drop a bool default).
 *  - For other opts, only emit when the default is actually set (use
 *    null/undefined as the sentinel - falsy values like 0 and '' are
 *    valid defaults and would be lost under a `!opt.default` check).
 *  - Repeatable opts join multi-value defaults with the opt's separator.
 */
function buildConfigFromDefaults (walletDef: WalletDefinition): Record<string, string> {
  const config: Record<string, string> = {}
  for (const opt of walletDef.configopts ?? []) {
    if (opt.isboolean) {
      config[opt.key] = opt.default ? '1' : '0'
      continue
    }
    if (opt.default === null || opt.default === undefined) continue
    const v = String(opt.default)
    if (opt.repeatable && config[opt.key]) {
      config[opt.key] += opt.repeatable + v
    } else {
      config[opt.key] = v
    }
  }
  return config
}

/**
 * InitStepShell is the centred, narrow column the three init steps share
 * - a single source of truth for the layout means future tweaks
 * (responsive breakpoints, padding, etc.) only happen in one place.
 *
 * The body uses `position: fixed` (see main.scss), so the page itself
 * never scrolls. We therefore mark the outer wrapper as the scrollable
 * surface (`overflow-y: auto`) and wrap the content in a flex column
 * tall enough to vertically centre short steps while still letting the
 * QuickConfig list scroll when there are too many wallets to fit.
 *
 * `stepKey` swaps as the user advances between steps; we drop it onto
 * the slide-in column so React remounts that subtree on transition,
 * re-firing the `slide-in-from-right` keyframe so each step animates
 * in instead of swapping abruptly.
 *
 * `wide` opts the column out of the narrow `col-lg-4` default - used by
 * QuickConfig where the wallet list needs more horizontal room than the
 * password / seed-backup steps.
 */
function InitStepShell ({ children, stepKey, wide = false }: { children: React.ReactNode, stepKey: string, wide?: boolean }) {
  const colClass = wide ? 'col-10' : 'col-12 col-sm-8 col-md-6 col-lg-4'
  return (
    <div className="flex-grow-1" style={{ overflowY: 'auto', overflowX: 'hidden' }}>
      <div className="d-flex align-items-center justify-content-center py-5" style={{ minHeight: '100%' }}>
        <div key={stepKey} className={`${colClass} slide-in-from-right`}>
          {children}
        </div>
      </div>
    </div>
  )
}

export default function InitPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const setInitInProgress = useAuthStore(s => s.setInitInProgress)

  const [step, setStep] = useState<Step>('password')

  // Make sure the InitGuard's "stay on /init mid-flow" override doesn't
  // outlive this page - if the user navigates away (browser back, etc.)
  // we want a future visit to /init to be subject to the normal redirect.
  useEffect(() => {
    return () => { setInitInProgress(false) }
  }, [setInitInProgress])

  // Password stage state. `password` doubles as the captured value used
  // by `submitQuickConfig` to authenticate /api/newwallet - the input
  // it backs is only rendered during step='password', so keeping it in
  // a single state cell is safe (no stale-render leak) and the value is
  // wiped explicitly in `finalize` before navigating away.
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [seed, setSeed] = useState('')
  const [showSeedInput, setShowSeedInput] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
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
  // required-config wallets only - defaulted wallets fall through to
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

    // Pin the user on /init for the rest of the flow: /api/init has now
    // flipped the server-side `inited` flag to true, and the next
    // fetchUser() call would otherwise let InitGuard bounce us straight
    // to /wallets before the QuickConfig and SeedBackup steps render.
    setInitInProgress(true)

    const responseMnemonic: string | undefined = res.mnemonic
    setMnemonic(responseMnemonic)

    // Pull the asset list directly so we can populate the wallet
    // checkboxes without going through the auth store - the store
    // update would notify InitGuard via `inited`, and even with the
    // initInProgress override we'd rather not trigger gratuitous
    // re-renders mid-flow.
    const userResp: UserResponse = await getJSON('/api/user')
    const userData = userResp.requestSuccessful ? userResp.user : undefined
    if (userData) {
      const walletRows: WalletRow[] = []
      for (const asset of Object.values(userData.assets)) {
        if (asset.token) continue
        const winfo = asset.info
        if (!winfo || winfo.availablewallets.length === 0) continue
        // Prefer a seeded wallet definition (auto-creatable from the
        // app seed); fall back to the first available def for assets
        // like daemon-based wallets that always need explicit config.
        let chosenDef: WalletDefinition | null = null
        for (const wDef of winfo.availablewallets) {
          if (wDef.seeded) {
            chosenDef = wDef
            break
          }
        }
        if (!chosenDef) chosenDef = winfo.availablewallets[0]
        const hasRequired = !!chosenDef.configopts?.some(o => o.required)
        const needsConfig = !chosenDef.seeded || hasRequired
        walletRows.push({
          asset,
          walletDef: chosenDef,
          checked: PRECHECKED_SYMBOLS.has(asset.symbol),
          needsConfig,
        })
      }
      walletRows.sort((a, b) => a.asset.name.localeCompare(b.asset.name))
      setWallets(walletRows)
    }

    setStep('quickConfig')
  }, [password, passwordConfirm, seed, t, setInitInProgress])

  // finalize is the single exit door from InitPage to /wallets. Wipes
  // the in-memory password / seed / mnemonic before navigating, then
  // refreshes the auth store so AuthGuard lets us into /wallets without
  // a guard ping-pong. `initInProgress` stays true until the unmount
  // cleanup clears it, which is what keeps InitGuard quiet between the
  // store update and the route change.
  const finalize = useCallback(async () => {
    setPassword('')
    setPasswordConfirm('')
    setSeed('')
    setMnemonic(undefined)
    await fetchUser()
    navigate(ROUTES.WALLETS)
  }, [fetchUser, navigate])

  // ---------- Stage 2: QuickConfig ----------

  const toggleWallet = useCallback((index: number) => {
    setWallets(prev => prev.map((w, i) => i === index ? { ...w, checked: !w.checked } : w))
  }, [])

  const submitQuickConfig = useCallback(async () => {
    setQuickConfigLoading(true)
    setShowErrors(false)
    setQuickConfigMessage(t('CREATING_WALLETS'))

    // Create wallets in parallel. For required-config rows, the user-
    // supplied values come from the inline WalletConfigForm via the ref
    // map; for auto-configurable rows we use the default-derived config.
    // Each promise reports its own outcome so we can collect failures
    // in the original wallet-list order (Promise.all preserves index
    // order, unlike a side-effecting push from racing callbacks).
    const checkedWallets = wallets.filter(w => w.checked)
    const results = await Promise.all(checkedWallets.map(async (w) => {
      const { asset, walletDef, needsConfig } = w
      const config = needsConfig
        ? walletConfigRefs.current.get(asset.id)?.getConfigMap(asset.id) ?? {}
        : buildConfigFromDefaults(walletDef)
      const res = await postJSON('/api/newwallet', {
        assetID: asset.id,
        appPass: password,
        config,
        walletType: walletDef.type,
      })
      return { name: asset.name, ok: checkResponse(res) }
    }))

    setQuickConfigLoading(false)
    setQuickConfigMessage('')

    const walletFailures = results.filter(r => !r.ok).map(r => r.name)
    if (walletFailures.length > 0) {
      setFailedWallets(walletFailures)
      setShowErrors(true)
      return
    }

    if (mnemonic) {
      setStep('seedBackup')
    } else {
      await finalize()
    }
  }, [wallets, password, t, mnemonic, finalize])

  const acknowledgeErrors = useCallback(() => {
    if (mnemonic) {
      setStep('seedBackup')
    } else {
      finalize()
    }
  }, [mnemonic, finalize])

  // ---------- Stage 3: Seed Backup ----------

  const finishSeedBackup = useCallback(() => {
    finalize()
  }, [finalize])

  // ---------- Render ----------

  if (step === 'password') {
    return (
      <InitStepShell stepKey={step}>
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
      </InitStepShell>
    )
  }

  if (step === 'quickConfig') {
    return (
      <InitStepShell stepKey={step} wide>
        <div style={{ position: 'relative', minHeight: quickConfigLoading ? '200px' : undefined }}>
          {quickConfigLoading && (
            <Wave message={quickConfigMessage} backgroundColor={true} />
          )}

          {!quickConfigLoading && !showErrors && (
            <div className="px-2 pt-3">
              <div className="fs18 mb-2">{t('QUICKCONFIG_WALLET_HEADER')}</div>
              {/* Lay the wallet checkboxes out in a responsive grid so
                  the list packs into multiple coins per row instead of
                  a single tall column. col-md-6/col-lg-4 gives 2 then 3
                  per row at the form's typical breakpoints. Items with
                  an inline config form (needsConfig + checked) just
                  grow vertically within their cell - Bootstrap stretches
                  the flex row to match, leaving empty space under the
                  shorter neighbours rather than breaking the grid. */}
              <div className="row g-2 mt-2">
                {wallets.map((wRow, idx) => (
                  <div key={wRow.asset.id} className="col-12 col-md-6 col-lg-4">
                    <label className="p-1 d-flex justify-content-start align-items-center hoverbg pointer">
                      <input
                        type="checkbox"
                        className="form-check-input"
                        checked={wRow.checked}
                        onChange={() => toggleWallet(idx)}
                      />
                      <img
                        className="mx-2"
                        src={logoPath(wRow.asset.symbol)}
                        alt=""
                        width={28}
                        height={28}
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
      </InitStepShell>
    )
  }

  // step === 'seedBackup'
  return (
    <InitStepShell stepKey={step}>
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
    </InitStepShell>
  )
}
