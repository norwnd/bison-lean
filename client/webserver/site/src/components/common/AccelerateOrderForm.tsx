import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { Order, XYRange } from '../../stores/types'

interface EarlyAcceleration {
  timePast: number
  wasAcceleration: boolean
}

interface PreAccelerate {
  swapRate: number
  suggestedRate: number
  suggestedRange: XYRange
  earlyAcceleration?: EarlyAcceleration
}

interface Props {
  order: Order
  onSuccess: () => void
}

export function AccelerateOrderForm ({ order, onSuccess }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)

  const [acceleratedRate, setAcceleratedRate] = useState(0)
  const [earlyAcceleration, setEarlyAcceleration] = useState<EarlyAcceleration | undefined>()
  const [currencyUnit, setCurrencyUnit] = useState('')
  const [suggestedRange, setSuggestedRange] = useState<XYRange | null>(null)
  const [swapRate, setSwapRate] = useState(0)
  const [currentFeeRate, setCurrentFeeRate] = useState(0)

  const [feeEstimate, setFeeEstimate] = useState('')
  const [feeRateEstimate, setFeeRateEstimate] = useState('')
  const [showFeeEstimate, setShowFeeEstimate] = useState(false)

  const [txID, setTxID] = useState('')
  const [error, setError] = useState('')
  const [preError, setPreError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showEarlyConfirm, setShowEarlyConfirm] = useState(false)

  const updateAccelerationEstimate = useCallback(async (rate: number) => {
    const req = { orderID: order.id, newRate: rate }
    setLoading(true)
    const res = await postJSON('/api/accelerationestimate', req)
    setLoading(false)
    if (!checkResponse(res)) {
      setError(t('ORDER_ACCELERATION_FEE_ERR_MSG', { msg: res.msg }))
      return
    }
    const feeAssetID = order.sell ? order.baseID : order.quoteID
    const feeSymbol = order.sell ? order.baseSymbol : order.quoteSymbol
    const unitInfo = assets[feeAssetID]?.unitInfo
    if (unitInfo) {
      const feeConventional = res.fee / unitInfo.conventional.conversionFactor
      setFeeEstimate(`${feeConventional} ${feeSymbol}`)
    }
    setFeeRateEstimate(`${rate} ${currencyUnit}`)
    setShowFeeEstimate(true)
  }, [order, assets, currencyUnit, t])

  // Pre-accelerate on mount.
  useEffect(() => {
    const refresh = async () => {
      const res = await postJSON('/api/preaccelerate', order.id)
      if (!checkResponse(res)) {
        setPreError(t('ORDER_ACCELERATION_ERR_MSG', { msg: res.msg }))
        return
      }
      const pre: PreAccelerate = res.preAccelerate
      setEarlyAcceleration(pre.earlyAcceleration)
      setCurrencyUnit(pre.suggestedRange.yUnit)
      setSwapRate(pre.swapRate)
      setCurrentFeeRate(pre.suggestedRate)
      setSuggestedRange(pre.suggestedRange)
      setAcceleratedRate(pre.suggestedRange.start.y)
      setShowEarlyConfirm(false)
      setError('')
      setShowFeeEstimate(false)
      // Compute initial fee estimate with the starting rate.
      await updateAccelerationEstimate(pre.suggestedRange.start.y)
    }
    refresh()
  }, [order.id])

  const sendAccelerateRequest = useCallback(async () => {
    const req = { orderID: order.id, newRate: acceleratedRate }
    setLoading(true)
    const res = await postJSON('/api/accelerateorder', req)
    setLoading(false)
    if (checkResponse(res)) {
      setTxID(res.txID)
      setShowSuccess(true)
      setShowEarlyConfirm(false)
      onSuccess()
    } else {
      setError(t('ORDER_ACCELERATION_ERR_MSG', { msg: res.msg }))
      setShowEarlyConfirm(false)
    }
  }, [order.id, acceleratedRate, onSuccess, t])

  const submit = () => {
    if (earlyAcceleration) {
      setShowEarlyConfirm(true)
    } else {
      sendAccelerateRequest()
    }
  }

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!suggestedRange) return
    const { start, end } = suggestedRange
    const pct = Number(e.target.value) / 100
    const newY = Math.round(start.y + pct * (end.y - start.y))
    setAcceleratedRate(newY)
    updateAccelerationEstimate(newY)
  }

  const sliderValue = suggestedRange
    ? ((acceleratedRate - suggestedRange.start.y) / (suggestedRange.end.y - suggestedRange.start.y)) * 100
    : 0

  // Early acceleration confirmation view.
  if (showEarlyConfirm && earlyAcceleration) {
    const minutesPast = Math.floor(earlyAcceleration.timePast / 60)
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          {earlyAcceleration.wasAcceleration
? (
            <div className="fs15 mb-2">
              {t('Your last acceleration was only')} {minutesPast} {t('minutes ago.')}
              {' '}{t('Are you sure you want to accelerate again?')}
            </div>
          )
: (
            <div className="fs15 mb-2">
              {t('The swap transaction was broadcast only')} {minutesPast} {t('minutes ago.')}
              {' '}{t('Are you sure you want to accelerate?')}
            </div>
          )}
          <div className="d-flex gap-2">
            <button
              className="btn btn-secondary"
              onClick={() => { setShowEarlyConfirm(false) }}
            >
              {t('Back')}
            </button>
            <button className="btn btn-primary" onClick={sendAccelerateRequest}>
              {t('Confirm')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Success view.
  if (showSuccess) {
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          <div className="fs18 text-success mb-2">{t('Acceleration Successful')}</div>
          {txID && (
            <div className="fs14 mb-2">
              <strong>{t('Transaction ID')}:</strong>
              <div className="text-break user-select-all">{txID}</div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Pre-accelerate error view.
  if (preError) {
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          <div className="fs15 text-danger">{preError}</div>
        </div>
      </div>
    )
  }

  // Main configuration view.
  return (
    <div className="form-closer">
      <div className="px-3 py-2">
        <div className="fs20 mb-2">{t('Accelerate Order')}</div>

        <div className="fs14 mb-1">
          {t('Average fee rate')}: {swapRate} {currencyUnit}
        </div>
        <div className="fs14 mb-2">
          {t('Current fee rate')}: {currentFeeRate} {currencyUnit}
        </div>

        {/* Fee rate slider */}
        {suggestedRange && (
          <div className="mb-3">
            <label className="fs14 mb-1">{t('New fee rate')}</label>
            <input
              type="range"
              className="form-range"
              min={0}
              max={100}
              value={sliderValue}
              onChange={handleSliderChange}
              disabled={loading}
            />
            <div className="d-flex justify-content-between fs13 text-secondary">
              <span>{suggestedRange.start.y} {suggestedRange.yUnit}</span>
              <span>{suggestedRange.end.y} {suggestedRange.yUnit}</span>
            </div>
          </div>
        )}

        {/* Fee estimate */}
        {showFeeEstimate && (
          <div className="fs14 mb-2">
            <div>{t('Selected rate')}: {feeRateEstimate}</div>
            <div>{t('Estimated fee')}: {feeEstimate}</div>
          </div>
        )}

        {error && (
          <div className="fs15 text-danger mb-2">{error}</div>
        )}

        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={loading}
        >
          {loading ? '...' : t('Submit')}
        </button>
      </div>
    </div>
  )
}
