import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON } from '../../services/api'
import { checkResponse } from '../../hooks/useApi'
import { useAuthStore } from '../../stores/useAuthStore'
import { useNotifications } from '../../hooks/useNotifications'
import { formatCoinValue, formatFiatConversion } from '../../hooks/useFormatters'
import { explorerURL } from '../CoinExplorers'
import type { BalanceNote } from '../../stores/types'

function logoPath (symbol: string): string {
  symbol = symbol.split('.')[0]
  if (symbol === 'weth') symbol = 'eth'
  return `/img/coins/${symbol}.png`
}

interface Props {
  assetID: number
  host: string
  onSuccess?: () => void
}

export function TokenApprovalForm ({ assetID, host, onSuccess }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const user = useAuthStore(s => s.user)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [feeEstimate, setFeeEstimate] = useState('')
  const [txFee, setTxFee] = useState(0)
  const [parentID, setParentID] = useState(0)
  const [, setBalance] = useState(0)
  const [balanceStr, setBalanceStr] = useState('')
  const [parentTicker, setParentTicker] = useState('')
  const [parentName, setParentName] = useState('')
  const [depositAddress, setDepositAddress] = useState('')
  const [showAddress, setShowAddress] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [txID, setTxID] = useState('')
  const [txURL, setTxURL] = useState<string | null>(null)

  // Listen for balance updates.
  useNotifications({
    balance: (note) => {
      const n = note as BalanceNote
      if (n.assetID !== parentID) return
      const parentAsset = assets[parentID]
      if (!parentAsset) return
      const avail = n.balance.available
      setBalance(avail)
      setBalanceStr(formatCoinValue(avail, parentAsset.unitInfo))
      if (avail >= txFee) {
        setShowAddress(false)
      }
    },
  })

  // Build token symbol display.
  const tokenAsset = assets[assetID]
  const tokenSymbolParts = tokenAsset?.symbol.split('.') ?? []
  const isToken = tokenSymbolParts.length === 2
  const tokenTicker = tokenAsset?.unitInfo.conventional.unit ?? ''
  const tokenParentSymbol = isToken ? tokenSymbolParts[1] : ''

  // Fetch fee estimate on mount / when asset changes.
  useEffect(() => {
    if (!tokenAsset?.token) return
    const pID = tokenAsset.token.parentID
    setParentID(pID)
    setError('')
    setSubmitted(false)
    setTxID('')
    setTxURL(null)

    const exchange = exchanges[host]
    if (!exchange) return
    const exchangeAsset = exchange.assets[assetID]
    if (!exchangeAsset) return
    const protocolVersion = exchangeAsset.version

    const fetchFee = async () => {
      const res = await postJSON('/api/approvetokenfee', {
        assetID: tokenAsset.id,
        version: protocolVersion,
        approving: true,
      })
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to estimate fee')
        return
      }
      const parentAsset = assets[pID]
      if (!parentAsset) return
      const ui = parentAsset.unitInfo
      const wallet = parentAsset.wallet
      const fee = res.txFee as number
      setTxFee(fee)

      let feeText = `${formatCoinValue(fee, ui)} ${ui.conventional.unit}`
      const rate = fiatRatesMap[pID]
      if (rate) {
        feeText += ` (${formatFiatConversion(fee, rate, ui)} USD)`
      }
      setFeeEstimate(feeText)

      if (wallet) {
        const avail = wallet.balance.available
        setBalance(avail)
        setBalanceStr(formatCoinValue(avail, ui))
        setParentTicker(ui.conventional.unit)
        setParentName(parentAsset.name)
        if (avail < fee) {
          setShowAddress(true)
          setDepositAddress(wallet.address)
        } else {
          setShowAddress(false)
        }
      }
    }
    fetchFee()
  }, [assetID, host, assets, exchanges, fiatRatesMap])

  const approve = useCallback(async () => {
    if (!tokenAsset) return
    setError('')
    setLoading(true)
    const res = await postJSON('/api/approvetoken', {
      assetID: tokenAsset.id,
      dexAddr: host,
    })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Approval failed')
      return
    }
    setTxID(res.txID)
    const net = user?.net ?? 0
    const url = explorerURL(tokenAsset.id, res.txID, net)
    setTxURL(url)
    setSubmitted(true)
    if (onSuccess) onSuccess()
  }, [tokenAsset, host, user, onSuccess])

  if (!tokenAsset) return null

  return (
    <div>
      {/* Token symbol header */}
      <div className="d-flex align-items-center gap-2 mb-3">
        <span className="fs18 fw-bold">
          {tokenTicker.toUpperCase()}
          {isToken && (
            <img src={logoPath(tokenParentSymbol)} alt={tokenParentSymbol} width={15} height={15} className="ms-1 token-parent" />
          )}
        </span>
      </div>

      {!submitted
        ? (
        <div>
          {/* Fee estimate */}
          {feeEstimate && (
            <div className="mb-2">
              <span className="fs14 text-secondary">{t('Estimated Fee')}: </span>
              <span className="fs14">{feeEstimate}</span>
            </div>
          )}

          {/* Balance */}
          {balanceStr && (
            <div className="mb-2">
              <span className="fs14 text-secondary">{parentName} {t('Balance')}: </span>
              <span className="fs14">{balanceStr} {parentTicker}</span>
            </div>
          )}

          {/* Deposit address if insufficient funds */}
          {showAddress && (
            <div className="mb-2 p-2 border rounded bg-light">
              <div className="fs14 text-warning mb-1">
                {t('Insufficient balance. Deposit to your {{parentName}} wallet:', { parentName })}
              </div>
              <code className="text-break fs14">{depositAddress}</code>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="fs15 text-danger mb-2">{error}</div>
          )}

          {/* Submit button */}
          <button
            type="button"
            className="btn btn-primary w-100"
            onClick={approve}
            disabled={loading}
          >
            {loading ? '...' : t('Approve')}
          </button>
        </div>
      )
        : (
        <div>
          {/* Success: show txID */}
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Transaction ID')}: </span>
            {txURL
? (
              <a href={txURL} target="_blank" rel="noopener noreferrer" className="text-break">
                {txID}
              </a>
            )
: (
              <span className="text-break">{txID}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TokenApprovalForm
