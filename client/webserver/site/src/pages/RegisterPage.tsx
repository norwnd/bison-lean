import { useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { DEXAddressForm } from '../components/common/DEXAddressForm'
import { FeeAssetSelectionForm } from '../components/common/FeeAssetSelectionForm'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletWaitForm } from '../components/common/WalletWaitForm'
import { ConfirmRegistrationForm } from '../components/common/ConfirmRegistrationForm'
import { ROUTES } from '../router/routes'
import type { Exchange } from '../stores/types'
import { PrepaidBondID } from '../stores/types'

type Step = 'dexAddress' | 'feeAsset' | 'newWallet' | 'walletWait' | 'confirm'

export default function RegisterPage () {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const assets = useAuthStore(s => s.assets)

  const [step, setStep] = useState<Step>('dexAddress')
  const [exchange, setExchange] = useState<Exchange | null>(null)
  const [certFile, setCertFile] = useState('')
  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(null)
  const [tier, setTier] = useState(1)
  const [bondsFeeBuffer, setBondsFeeBuffer] = useState(0)

  const prefilledHost = searchParams.get('host') ?? undefined

  const getBondsFeeBuffer = useCallback(async (assetID: number): Promise<number> => {
    const res = await postJSON('/api/bondsfeebuffer', { assetID })
    if (!checkResponse(res)) return 0
    return res.feeBuffer
  }, [])

  const registerDEXSuccess = useCallback(async () => {
    await fetchUser()
    navigate(ROUTES.MARKETS)
  }, [fetchUser, navigate])

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

  return (
    <div className="d-flex align-items-center justify-content-center py-5">
      <div className="col-12 col-sm-10 col-md-8 col-lg-6">
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
