import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ReputationMeter } from '../../components/common/ReputationMeter'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// TierSection -- collapsible trading tier and reputation section (MP-35/MP-36).
// Owns the `showTradingTier` and `showReputation` toggle state internally.
// ---------------------------------------------------------------------------

export interface TierData {
  visible: boolean
  effectiveTier: number
  pendingStrength: number
  tier: number
  usedParcels: number
  parcelLimit: number
  parcelSize: number
  parcelSizeBaseStr: string
  parcelSizeQuoteStr: string | null
  baseUnit: string
  quoteUnit: string
  tradingLimitStr: string
  limitUsageStr: string
}

export interface TierSectionProps {
  tierData: TierData | null
  isRegistered: boolean
}

export function TierSection ({ tierData, isRegistered }: TierSectionProps) {
  const { t } = useTranslation()
  const { selected } = useMarketPageContext()

  const [showTradingTier, setShowTradingTier] = useState(false)
  const [showReputation, setShowReputation] = useState(false)

  if (!tierData || !tierData.visible || !isRegistered) return null

  return (
    <div>
      {/* MP-35: Parcel size shown in BOTH base and quote amounts */}
      <div
        className="p-2 grey fs15 hoverbg pointer"
        onClick={() => setShowTradingTier(!showTradingTier)}
      >
        <span className={`ico-${showTradingTier ? 'minus' : 'plus'} fs10 me-2`}></span>
        <span>{showTradingTier ? t('Hide trading tier info') : t('Show trading tier info')}</span>
      </div>
      {showTradingTier && (
        <div className="d-flex flex-stretch-column fs15 mx-2 mb-2 border">
          <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1 border-bottom">
            <div className="d-flex justify-content-between align-items-center">
              <span>{t('Parcel Size')}</span>
              <span>{tierData.parcelSize} {t('lots')}</span>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <span></span>
              <span>
                {tierData.parcelSizeBaseStr} <span className="grey">{tierData.baseUnit}</span>
              </span>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <span></span>
              <span>
                ~ {tierData.parcelSizeQuoteStr ?? '-'} <span className="grey">{tierData.quoteUnit}</span>
              </span>
            </div>
          </div>
          <div className="d-flex flex-column flex-grow-1 align-items-stretch p-1">
            <div className="d-flex justify-content-between align-items-center">
              <span>{t('Trading Tier')}</span>
              <span>{tierData.tier}</span>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <span>{t('Trading Limit')}</span>
              <span>{tierData.tradingLimitStr} {t('lots')}</span>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <span>{t('Current Usage')}</span>
              <span>{tierData.limitUsageStr}%</span>
            </div>
          </div>
        </div>
      )}

      {/* MP-36: Reputation meter, visible only when effectiveTier > 0 || pendingStrength > 0 */}
      <div
        className="p-2 grey fs15 hoverbg pointer"
        onClick={() => setShowReputation(!showReputation)}
      >
        <span className={`ico-${showReputation ? 'minus' : 'plus'} fs10 me-2`}></span>
        <span>{showReputation ? t('Hide reputation') : t('Show reputation')}</span>
      </div>
      {showReputation && (
        <div className="px-3 mb-3 border-bottom">
          <ReputationMeter host={selected.host} />
        </div>
      )}
    </div>
  )
}
