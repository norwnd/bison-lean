import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { SupportedAsset, WalletTransaction } from '../../stores/types'
import { logoPath } from '../../hooks/useFormatters'

const traitNewAddresser = 1 << 1

export interface DepositAddressHandle {
  handleTx: (assetID: number, tx: WalletTransaction) => void
}

interface Props {
  assetID?: number
  assetIDs?: number[]
}

export const DepositAddress = forwardRef<DepositAddressHandle, Props>(function DepositAddress (
  { assetID: singleAssetID, assetIDs },
  ref
) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const walletMap = useAuthStore(s => s.walletMap)

  const [currentAssetID, setCurrentAssetID] = useState<number | null>(null)
  const [addr, setAddr] = useState('')
  const [displayAddr, setDisplayAddr] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const [addrUsed, setAddrUsed] = useState(false)
  const [showNetSelect, setShowNetSelect] = useState(false)
  const [unifiedReceivers, setUnifiedReceivers] = useState<Record<string, string> | null>(null)
  const [selectedReceiverType, setSelectedReceiverType] = useState('unified')

  const resolvedIDs = assetIDs ?? (singleAssetID !== undefined ? [singleAssetID] : [])

  // Parse and display an address, handling unified receivers.
  const setAddress = useCallback((rawAddr: string) => {
    setAddr(rawAddr)
    if (rawAddr.startsWith('unified:')) {
      const receivers = JSON.parse(rawAddr.substring('unified:'.length)) as Record<string, string>
      setUnifiedReceivers(receivers)
      const defaultType = 'unified'
      setSelectedReceiverType(defaultType)
      setDisplayAddr(receivers[defaultType] ?? Object.values(receivers)[0] ?? '')
    } else {
      setUnifiedReceivers(null)
      setDisplayAddr(rawAddr)
    }
  }, [])

  // Set the active asset.
  const setAsset = useCallback(async (assetID: number) => {
    setCurrentAssetID(assetID)
    setError('')
    setAddrUsed(false)
    setShowNetSelect(false)
    setUnifiedReceivers(null)

    const wallet = walletMap[assetID]
    if (!wallet) return

    const rawAddr = wallet.address
    setAddress(rawAddr)

    // Check if the address has been used (for wallets that support new addresses).
    if ((wallet.traits & traitNewAddresser) !== 0) {
      const res = await postJSON('/api/addressused', { assetID, addr: rawAddr })
      const used = checkResponse(res) && res.used
      setAddrUsed(Boolean(used))
    }
  }, [walletMap, setAddress])

  // On mount or when IDs change, set up the view.
  useEffect(() => {
    if (resolvedIDs.length === 0) return
    if (resolvedIDs.length === 1) {
      setAsset(resolvedIDs[0])
    } else {
      // Multi-network selection mode.
      setShowNetSelect(true)
    }
  }, [resolvedIDs.join(','), setAsset])

  const newDepositAddress = useCallback(async () => {
    if (currentAssetID === null) return
    setError('')
    setLoading(true)
    const res = await postJSON('/api/depositaddress', { assetID: currentAssetID })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to get new address')
      return
    }
    setAddress(res.address)
    setAddrUsed(false)
  }, [currentAssetID, setAddress])

  const copyAddress = useCallback(async () => {
    if (!displayAddr) return
    if (!window.isSecureContext) return
    try {
      await navigator.clipboard.writeText(displayAddr)
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 800)
    } catch (err) {
      console.error('Unable to copy:', err)
    }
  }, [displayAddr])

  // Expose handleTx for parent components to forward transaction notes.
  useImperativeHandle(ref, () => ({
    handleTx (txAssetID: number, tx: WalletTransaction) {
      if (txAssetID !== currentAssetID) return
      const wallet = walletMap[txAssetID]
      if (!wallet || (wallet.traits & traitNewAddresser) === 0) return
      if (tx.amount > 0 && tx.recipient === addr) setAddrUsed(true)
    },
  }), [currentAssetID, walletMap, addr])

  const currentAsset = currentAssetID !== null ? assets[currentAssetID] : null
  const currentWallet = currentAssetID !== null ? walletMap[currentAssetID] : null
  const supportsNewAddr = currentWallet ? (currentWallet.traits & traitNewAddresser) !== 0 : false

  // --- Network selection view ---
  if (showNetSelect) {
    const allAssets = resolvedIDs.map(id => assets[id]).filter(Boolean) as SupportedAsset[]
    allAssets.sort((a) => a.token ? 1 : -1)
    const first = allAssets[0]
    if (!first) return null

    return (
      <div>
        <div className="d-flex align-items-center gap-2 mb-3">
          <img src={logoPath(first.symbol)} alt={first.symbol} width={30} height={30} />
          <span className="fs18">{first.unitInfo.conventional.unit}</span>
        </div>
        <div className="fs15 mb-2">{t('Select network')}</div>
        <div className="d-flex flex-column gap-2">
          {allAssets.map(({ id, symbol, token, name }) => {
            const chainSymbol = token ? (assets[token.parentID]?.symbol ?? symbol) : symbol
            const chainName = token ? (assets[token.parentID]?.name ?? name) : name
            return (
              <button
                key={id}
                type="button"
                className="btn btn-outline-secondary d-flex align-items-center gap-2"
                onClick={() => setAsset(id)}
              >
                <img src={logoPath(chainSymbol)} alt={chainSymbol} width={20} height={20} />
                <span>{chainName}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // --- Main deposit address view ---
  if (!currentAsset) return null

  const parentAsset = currentAsset.token ? assets[currentAsset.token.parentID] : null

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-center gap-2 mb-3">
        <img src={logoPath(currentAsset.symbol)} alt={currentAsset.symbol} width={30} height={30} />
        <span className="fs18">{currentAsset.unitInfo.conventional.unit}</span>
      </div>

      {/* Token parent notice */}
      {currentAsset.token && parentAsset && (
        <div className="d-flex align-items-center gap-2 mb-2 p-2 border rounded bg-light">
          <img src={logoPath(parentAsset.symbol)} alt={parentAsset.symbol} width={20} height={20} />
          <span className="fs14">{t('Deposits arrive on {{parentName}}', { parentName: parentAsset.name })}</span>
        </div>
      )}

      {/* Unified receiver type selector */}
      {unifiedReceivers && (
        <div className="d-flex gap-1 mb-2">
          {Object.entries(unifiedReceivers).map(([recvType, recv]) => (
            <button
              key={recvType}
              type="button"
              className={`btn btn-sm ${recvType === selectedReceiverType ? 'btn-primary' : 'btn-outline-secondary'}`}
              onClick={() => {
                setSelectedReceiverType(recvType)
                setDisplayAddr(recv)
              }}
            >
              {recvType}
            </button>
          ))}
        </div>
      )}

      {/* QR code */}
      {displayAddr && (
        <div className="text-center mb-3">
          <img
            src={`/generateqrcode?address=${encodeURIComponent(displayAddr)}`}
            alt="QR"
            className="img-fluid"
            style={{ maxWidth: 200 }}
          />
        </div>
      )}

      {/* Address display */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <code className="text-break flex-grow-1 fs14">{displayAddr}</code>
        {window.isSecureContext && (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={copyAddress}
          >
            {copyFeedback ? t('Copied') : t('Copy')}
          </button>
        )}
      </div>

      {/* Address used warning */}
      {addrUsed && (
        <div className="fs14 text-warning mb-2">{t('This address has been used. Consider generating a new one.')}</div>
      )}

      {/* Error */}
      {error && (
        <div className="fs15 text-danger mb-2">{error}</div>
      )}

      {/* New address button */}
      {supportsNewAddr && (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={newDepositAddress}
          disabled={loading}
        >
          {loading ? '...' : t('New Deposit Address')}
        </button>
      )}
    </div>
  )
})

export default DepositAddress
