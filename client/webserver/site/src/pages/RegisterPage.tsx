import { useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { DEXAddressForm } from '../components/common/DEXAddressForm'
import { DiscoverAccountForm } from '../components/common/DiscoverAccountForm'
import { FeeAssetSelectionForm } from '../components/common/FeeAssetSelectionForm'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletWaitForm } from '../components/common/WalletWaitForm'
import { ConfirmRegistrationForm } from '../components/common/ConfirmRegistrationForm'
import { LoginForm } from '../components/common/LoginForm'
import { ROUTES } from '../router/routes'
import type { Exchange } from '../stores/types'
import { PrepaidBondID } from '../stores/types'

// RP-01: include 'discoverAcct' as the entry point when a `host` URL
// param is provided (deep-link flow). The DiscoverAccountForm
// auto-submits on mount and either advances to fee asset selection
// (`onSuccess`) or, if the account is already paid, navigates
// straight out via the parent's `registerDEXSuccess` (`onPaid`).
type Step = 'discoverAcct' | 'dexAddress' | 'feeAsset' | 'newWallet' | 'walletWait' | 'confirm'

export default function RegisterPage () {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const assets = useAuthStore(s => s.assets)
  // RP-02: read auth state so we can fall back to a LoginForm when
  // the app is initialized but the user isn't logged in (e.g. they
  // restarted mid-registration). Mirrors vanilla `register.ts` L43-46
  // which constructs a `LoginForm` if `page.loginForm` is rendered
  // by the Go template (only emitted when `inited && !authed`).
  const authed = useAuthStore(s => s.authed)
  const inited = useAuthStore(s => s.inited)

  const prefilledHost = searchParams.get('host') ?? undefined
  // RP-03: vanilla `RegistrationPageData.backTo` (register.ts L23 +
  // L195) lets a deep link specify where to land after registration
  // succeeds. Defaults to /markets when not provided.
  const backTo = searchParams.get('backTo') ?? undefined

  // RP-01: start at the discover step when a host is pre-specified.
  const [step, setStep] = useState<Step>(prefilledHost ? 'discoverAcct' : 'dexAddress')
  const [exchange, setExchange] = useState<Exchange | null>(null)
  const [certFile, setCertFile] = useState('')
  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(null)
  const [tier, setTier] = useState(1)
  const [bondsFeeBuffer, setBondsFeeBuffer] = useState(0)

  const getBondsFeeBuffer = useCallback(async (assetID: number): Promise<number> => {
    const res = await postJSON('/api/bondsfeebuffer', { assetID })
    if (!checkResponse(res)) return 0
    return res.feeBuffer
  }, [])

  const registerDEXSuccess = useCallback(async () => {
    await fetchUser()
    // RP-03: use the explicit backTo target when provided, otherwise
    // fall back to the markets page. Mirrors vanilla `registerDEXSuccess`
    // (register.ts L195) `app().loadPage(this.data.backTo || 'markets')`.
    // RP-04: vanilla also called `app().updateMenuItemsDisplay()` here
    // to refresh the header nav after the new DEX connection. React's
    // Header reads `authed` + `exchanges` reactively from `useAuthStore`,
    // so the `fetchUser()` above already triggers a re-render of the
    // menu without an explicit imperative call. Resolved implicitly.
    navigate(backTo ?? ROUTES.MARKETS)
  }, [fetchUser, navigate, backTo])

  // RP-01: handler for DiscoverAccountForm onSuccess (account exists
  // but not yet paid). Mirrors vanilla register.ts `requestFeepayment`
  // which advances to the fee asset selection step.
  const handleDiscoverSuccess = useCallback((xc: Exchange) => {
    setExchange(xc)
    setCertFile('')
    setStep('feeAsset')
  }, [])

  // DEXAddressForm success: received exchange and cert, move to fee asset selection.
  const handleDexAddressSuccess = useCallback((xc: Exchange, cert: string) => {
    setExchange(xc)
    setCertFile(cert)
    setStep('feeAsset')
  }, [])

  // FeeAssetSelectionForm success: asset and tier selected, determine next step.
  const handleFeeAssetSuccess = useCallback(async (assetID: number, selectedTier: number) => {
    if (assetID === PrepaidBondID) {
      await registerDEXSuccess()
      return
    }

    setSelectedAssetID(assetID)
    setTier(selectedTier)

    const asset = assets[assetID]
    const wallet = asset?.wallet
    if (!exchange) return

    const bondAsset = exchange.bondAssets[asset.symbol]
    const feeBuffer = await getBondsFeeBuffer(assetID)
    setBondsFeeBuffer(feeBuffer)

    if (wallet) {
      if (wallet.synced && wallet.balance.available >= 2 * bondAsset.amount + feeBuffer) {
        setStep('confirm')
        return
      }
      setStep('walletWait')
      return
    }

    setStep('newWallet')
  }, [assets, exchange, getBondsFeeBuffer, registerDEXSuccess])

  // NewWalletForm success: wallet created, check if ready or wait.
  const handleNewWalletSuccess = useCallback(async (assetID: number) => {
    if (!exchange) return
    const user = await fetchUser()
    if (!user) return

    const asset = user.assets[assetID]
    const wallet = asset?.wallet
    const bondAsset = exchange.bondAssets[asset.symbol]

    const feeBuffer = await getBondsFeeBuffer(assetID)
    setBondsFeeBuffer(feeBuffer)
    setSelectedAssetID(assetID)

    if (wallet && wallet.synced && wallet.balance.available >= 2 * bondAsset.amount + feeBuffer) {
      setStep('confirm')
      return
    }
    setStep('walletWait')
  }, [exchange, fetchUser, getBondsFeeBuffer])

  // WalletWaitForm success: wallet is synced and funded.
  const handleWalletWaitSuccess = useCallback(async () => {
    setStep('confirm')
  }, [])

  // ConfirmRegistrationForm success: bond posted.
  const handleConfirmSuccess = useCallback(async () => {
    await registerDEXSuccess()
  }, [registerDEXSuccess])

  // Back handlers for navigation between steps.
  const handleWalletWaitBack = useCallback(async () => {
    setStep('feeAsset')
  }, [])

  const handleConfirmBack = useCallback(async () => {
    setStep('feeAsset')
  }, [])

  // RP-02: fall back to a login form when the app is initialized
  // but the user isn't authenticated. After successful login,
  // `authed` flips true via the auth store and this component
  // re-renders into the registration flow with the same URL params
  // (host/backTo) intact -- exactly what vanilla achieved by
  // initializing both forms in the same page constructor.
  if (inited && !authed) {
    return (
      <div className="d-flex align-items-center justify-content-center py-5">
        <div className="col-12 col-sm-8 col-md-6 col-lg-4">
          {/* RP-02 flow: LoginForm has no success callback — once
              `authed` flips true, this component re-renders and the
              branch below (the registration flow) takes over. */}
          <LoginForm />
        </div>
      </div>
    )
  }

  return (
    <div className="d-flex align-items-center justify-content-center py-5">
      <div className="col-12 col-sm-10 col-md-8 col-lg-6">
        {/* RP-01: deep-link discovery step. Auto-submits on mount.
            On success, advances to fee asset selection. On `paid`
            (account already registered), `registerDEXSuccess`
            navigates straight to backTo / markets. */}
        {step === 'discoverAcct' && prefilledHost && (
          <DiscoverAccountForm
            addr={prefilledHost}
            onSuccess={handleDiscoverSuccess}
            onPaid={registerDEXSuccess}
          />
        )}

        {step === 'dexAddress' && (
          <DEXAddressForm
            onSuccess={handleDexAddressSuccess}
            knownExchanges={prefilledHost ? [prefilledHost] : []}
          />
        )}

        {step === 'feeAsset' && exchange && (
          <FeeAssetSelectionForm
            exchange={exchange}
            certFile={certFile}
            onSuccess={handleFeeAssetSuccess}
          />
        )}

        {step === 'newWallet' && selectedAssetID !== null && (
          <NewWalletForm
            assetID={selectedAssetID}
            onSuccess={handleNewWalletSuccess}
            onBack={() => setStep('feeAsset')}
          />
        )}

        {step === 'walletWait' && exchange && selectedAssetID !== null && (
          <WalletWaitForm
            exchange={exchange}
            assetID={selectedAssetID}
            bondFeeBuffer={bondsFeeBuffer}
            tier={tier}
            onSuccess={handleWalletWaitSuccess}
            onBack={handleWalletWaitBack}
          />
        )}

        {step === 'confirm' && exchange && selectedAssetID !== null && (
          <ConfirmRegistrationForm
            exchange={exchange}
            certFile={certFile}
            bondAssetID={selectedAssetID}
            tier={tier}
            fees={bondsFeeBuffer}
            onSuccess={handleConfirmSuccess}
            onBack={handleConfirmBack}
          />
        )}
      </div>
    </div>
  )
}
