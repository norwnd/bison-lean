import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { formatBestWeCan } from '../../hooks/useFormatters'
import { bondReserveMultiplier } from '../AccountUtils'
import type { Exchange } from '../../stores/types'

function logoPath (symbol: string): string {
  const base = symbol.split('.')[0]
  return `/img/coins/${base === 'weth' ? 'eth' : base}.png`
}

interface Props {
  exchange: Exchange
  certFile: string
  bondAssetID: number
  tier: number
  fees: number
  onSuccess: () => Promise<void>
  onBack: () => Promise<void>
}

export function ConfirmRegistrationForm ({
  exchange, certFile, bondAssetID, tier, fees, onSuccess, onBack
}: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const displayInfo = useMemo(() => {
    const asset = assets[bondAssetID]
    if (!asset) return null
    const { conversionFactor, unit } = asset.unitInfo.conventional
    const bondAsset = exchange.bondAssets[asset.symbol]
    if (!bondAsset) return null
    const bondLock = bondAsset.amount * tier * bondReserveMultiplier
    const bondLockConventional = bondLock / conversionFactor
    const fiatRate = fiatRatesMap[bondAssetID]
    const fiatBondLock = fiatRate ? formatBestWeCan(bondLockConventional * fiatRate) : null
    const feeReserves = fees ? formatBestWeCan(fees / conversionFactor) : null
    return {
      symbol: asset.symbol,
      unit,
      bondLockFormatted: formatBestWeCan(bondLockConventional),
      fiatBondLock,
      feeReserves,
    }
  }, [bondAssetID, tier, fees, exchange, assets, fiatRatesMap])

  const submitForm = async () => {
    const asset = assets[bondAssetID]
    if (!asset) {
      setError(t('SELECT_WALLET_FOR_FEE_PAYMENT'))
      return
    }
    setError('')
    const bondAsset = exchange.bondAssets[asset.wallet?.symbol ?? asset.symbol]
    const dexAddr = exchange.host

    let form: any
    let url: string
    const existingExchange = exchanges[exchange.host]
    if (!existingExchange || existingExchange.viewOnly) {
      form = {
        addr: dexAddr,
        cert: certFile,
        bond: bondAsset.amount * tier,
        asset: bondAsset.id,
      }
      url = '/api/postbond'
    } else {
      form = {
        host: dexAddr,
        targetTier: tier,
        bondAssetID: bondAssetID,
      }
      url = '/api/updatebondoptions'
    }

    setLoading(true)
    const res = await postJSON(url, form)
    setLoading(false)

    if (!checkResponse(res)) {
      setError(res.msg)
      return
    }
    await onSuccess()
  }

  return (
    <div className="px-3 py-2">
      <div className="fs20 mb-2">{t('Confirm Registration')}</div>

      <div className="fs15 mb-1">
        <strong>{t('Host')}:</strong> {exchange.host}
      </div>

      {displayInfo && (
        <>
          <div className="d-flex align-items-center gap-2 fs15 mb-1">
            <strong>{t('Bond Asset')}:</strong>
            <img className="micro-icon" src={logoPath(displayInfo.symbol)} alt="" />
          </div>

          <div className="fs15 mb-1">
            <strong>{t('Trading Tier')}:</strong> {tier}
          </div>

          <div className="fs15 mb-1">
            <strong>{t('Bond Lock')}:</strong> {displayInfo.bondLockFormatted} {displayInfo.unit}
            {displayInfo.fiatBondLock && (
              <span className="ms-1">(~${displayInfo.fiatBondLock})</span>
            )}
          </div>

          {displayInfo.feeReserves && (
            <div className="fs15 mb-1">
              <strong>{t('Fee Reserves')}:</strong> {displayInfo.feeReserves} {displayInfo.unit}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="fs15 text-danger mb-2">{error}</div>
      )}

      <div className="d-flex gap-2 mt-3">
        <button
          className="btn btn-secondary"
          onClick={onBack}
          disabled={loading}
        >
          {t('Back')}
        </button>
        <button
          className="btn btn-primary"
          onClick={submitForm}
          disabled={loading}
        >
          {loading ? '...' : t('Submit')}
        </button>
      </div>
    </div>
  )
}
