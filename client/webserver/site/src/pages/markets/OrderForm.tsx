import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { orderDisclaimerAckedLK, fetchLocal, storeLocal } from '../../services/state'
import { FormOverlay } from '../../components/common/FormOverlay'
import Tooltip from '../../components/mmsettings/Tooltip'
import {
  formatRateAtomToRateStep,
  formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency,
  adjRateAtomBuy, adjRateAtomSell, shortSymbol
} from '../../hooks/useFormatters'
import { baseToQuote } from '../../components/AccountUtils'
import type { Market, UnitInfo, MaxOrderEstimate, WalletState } from '../../stores/types'
import { parseConvRate, parseConvQty } from './helpers'
import type { SelectedMarket } from './helpers'
import { VerifyOrderForm } from './VerifyOrderForm'

// ---------------------------------------------------------------------------
// OrderForm — fully independent buy/sell limit-order form
// ---------------------------------------------------------------------------

export interface OrderFormProps {
  side: 'buy' | 'sell'
  selected: SelectedMarket
  currentMkt: Market | null
  bui: UnitInfo | null
  qui: UnitInfo | null
  walletMap: Record<number, WalletState>
  baseSymbol: string
  quoteSymbol: string
  // MP-52: fiat rates for the verify-modal fiat total. Null/0 hides the
  // total row (vanilla `showFiatValue` hides the parent when rate=0).
  baseFiatRate: number
  quoteFiatRate: number
  bookRateAtom: number
  bookRateVersion: number
}

export function OrderForm ({
  side, selected, currentMkt, bui, qui, walletMap, baseSymbol, quoteSymbol,
  baseFiatRate, quoteFiatRate, bookRateAtom, bookRateVersion
}: OrderFormProps) {
  const { t } = useTranslation()
  const isSell = side === 'sell'
  const buiConv = bui?.conventional
  const quiConv = qui?.conventional

  // Fully independent form state
  const [rateInput, setRateInput] = useState('')
  const [qtyInput, setQtyInput] = useState('')
  const rateAtomRef = useRef(0)
  const qtyAtomRef = useRef(0)
  const [sliderValue, setSliderValue] = useState(0)
  const [submitEnabled, setSubmitEnabled] = useState(false)
  const [submitMsg, setSubmitMsg] = useState('')
  const [orderError, setOrderError] = useState('')
  const [showVerify, setShowVerify] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const verifiedOrderRef = useRef<any>(null)

  // MP-51: disclaimer ack state, persisted to localStorage. Vanilla
  // `setDisclaimerAckViz` (markets.ts L479-491) hides the disclaimer+ack
  // block once the user has acknowledged, and shows a "view warnings"
  // toggle that re-opens it. We mirror that with a single boolean —
  // initial read from `fetchLocal` runs once at mount via the lazy
  // initializer so we don't re-read on every render.
  const [disclaimerAcked, setDisclaimerAcked] = useState<boolean>(
    () => fetchLocal(orderDisclaimerAckedLK) === true
  )
  const ackDisclaimer = useCallback(() => {
    storeLocal(orderDisclaimerAckedLK, true)
    setDisclaimerAcked(true)
  }, [])
  const unackDisclaimer = useCallback(() => {
    storeLocal(orderDisclaimerAckedLK, false)
    setDisclaimerAcked(false)
  }, [])

  // Max estimation cache. Buy: keyed by rateAtom. Sell: keyed by 0.
  const maxCacheRef = useRef<Record<number, MaxOrderEstimate>>({})
  // Used only by the validate effect below to detect when a newer validate
  // has superseded an in-flight one. The requestMax market-switch guard uses
  // the separate `selectedRef` snapshot pattern instead of a counter.
  const maxReqIdRef = useRef(0)
  // MP-17: market-switch guard. Snapshot `selected` at requestMax call time,
  // compare against `selectedRef.current` after the fetch returns; drop the
  // response if the market has changed. The OrderForm `key` prop normally
  // remounts the component on a market switch, but this guard is a defensive
  // safety net that mirrors vanilla's marketBefore/marketAfter check.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Refs to the price/quantity input boxes so we can flash a red outline on
  // invalid submission. Matches the vanilla highlightOutlineRed animation.
  const priceBoxRef = useRef<HTMLDivElement | null>(null)
  const qtyBoxRef = useRef<HTMLDivElement | null>(null)
  // MP-70: refs to the actual <input> elements so the wrapper-level click
  // handlers (which let the user click anywhere in the price/qty box to
  // focus the input — vanilla `markets.ts` L366-368, L392-394) can call
  // `.focus()` directly. The visual `.selected` border state is handled
  // entirely by the SCSS `:focus-within` rule on `.order-form-input`,
  // so no JS class toggling is needed.
  const rateInputRef = useRef<HTMLInputElement | null>(null)
  const qtyInputRef = useRef<HTMLInputElement | null>(null)
  const flashInvalid = useCallback((el: HTMLElement | null) => {
    if (!el) return
    el.classList.remove('flash-invalid')
    // Force reflow so the animation restarts on repeated triggers.
    // eslint-disable-next-line no-void
    void el.offsetWidth
    el.classList.add('flash-invalid')
  }, [])

  // Invalidate max caches when wallets change (balance updates)
  useEffect(() => {
    maxCacheRef.current = {}
  }, [walletMap])

  // MP-15: Initialize qty to 1 lot when the market first becomes available.
  // Mirrors vanilla setBuyQtyDefault/setSellQtyDefault. The OrderForm is
  // remounted on market change via its `key` prop, so this logically runs
  // once per market. The `qtyInitRef` ref-guard is load-bearing though:
  // within a single instance, `currentMkt` and `bui` identities change
  // whenever the exchanges/assets store is mutated (e.g. spot-price WS
  // updates), and without the guard the effect would re-fire and clobber
  // whatever qty the user had typed. Rate initialization is handled
  // separately by the book-fill effect.
  const qtyInitRef = useRef(false)
  useEffect(() => {
    if (qtyInitRef.current || !currentMkt || !bui) return
    qtyInitRef.current = true
    qtyAtomRef.current = currentMkt.lotsize
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(currentMkt.lotsize, bui, currentMkt.lotsize))
    setSliderValue(0)
    maxCacheRef.current = {}
  }, [currentMkt, bui])

  // Fill rate from order book click
  useEffect(() => {
    if (bookRateVersion === 0 || !bookRateAtom || !bui || !qui || !currentMkt) return
    const adjusted = isSell
      ? adjRateAtomSell(bookRateAtom, currentMkt.ratestep)
      : adjRateAtomBuy(bookRateAtom, currentMkt.ratestep)
    rateAtomRef.current = adjusted
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, currentMkt.ratestep, isSell))
    if (!isSell) maxCacheRef.current = {}
  }, [bookRateVersion])

  // Request max estimate for this side
  const requestMax = useCallback(async (): Promise<MaxOrderEstimate | null> => {
    if (!selected || !currentMkt || !bui || !qui) return null
    const reqSelected = selected
    const marketChanged = () =>
      selectedRef.current.host !== reqSelected.host ||
      selectedRef.current.baseID !== reqSelected.baseID ||
      selectedRef.current.quoteID !== reqSelected.quoteID
    if (isSell) {
      const cached = maxCacheRef.current[0]
      if (cached) return cached
      const baseWallet = walletMap[selected.baseID]
      if (!baseWallet?.running) return null
      const res = await postJSON('/api/maxsell', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxSell) return null
      maxCacheRef.current[0] = res.maxSell
      return res.maxSell as MaxOrderEstimate
    } else {
      const rateAtom = rateAtomRef.current
      if (!rateAtom) return null
      const cached = maxCacheRef.current[rateAtom]
      if (cached) return cached
      const quoteWallet = walletMap[selected.quoteID]
      if (!quoteWallet?.running) return null
      const res = await postJSON('/api/maxbuy', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID, rate: rateAtom
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxBuy) return null
      maxCacheRef.current[rateAtom] = res.maxBuy
      return res.maxBuy as MaxOrderEstimate
    }
  }, [selected, currentMkt, bui, qui, isSell, walletMap])

  // Sync slider position from current qty vs max estimate
  const syncSlider = useCallback(async () => {
    if (!currentMkt) return
    const lotsize = currentMkt.lotsize
    const currentLots = Math.floor(qtyAtomRef.current / lotsize)
    if (currentLots <= 0) { setSliderValue(0); return }
    const maxEst = await requestMax()
    if (maxEst && maxEst.swap.lots > 0) {
      setSliderValue(Math.min(1, currentLots / maxEst.swap.lots))
    }
  }, [currentMkt, requestMax])

  const handleRateChange = useCallback((value: string) => {
    setRateInput(value)
    if (!bui || !qui || !currentMkt) return
    // MP-16: If the value ends with a decimal separator, wait for the user to
    // finish typing before processing. Matches vanilla rate field handlers.
    if (value.length > 0) {
      const last = value.charAt(value.length - 1)
      if (last === '.' || last === ',') return
    }
    const rateAtom = parseConvRate(value, bui, qui)
    if (!rateAtom) {
      rateAtomRef.current = 0
      setSubmitEnabled(false)
      return
    }
    const adjusted = isSell
      ? adjRateAtomSell(rateAtom, currentMkt.ratestep)
      : adjRateAtomBuy(rateAtom, currentMkt.ratestep)
    rateAtomRef.current = adjusted
    if (!isSell) maxCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell])

  const handleRateBlur = useCallback(() => {
    if (!bui || !qui || !currentMkt) return
    // MP-72: vanilla splits rate field handling into 'input' (live, fast
    // path for "perfect" inputs only) and 'change' (commit, slower path
    // that handles invalidity and rate-step rounding with an error
    // animation). React's handleRateChange is the live input path, this
    // is the commit path. Detect both invalid and rounded-down inputs by
    // re-parsing the typed value and comparing against the adjusted
    // value already stored in `rateAtomRef` by handleRateChange — if
    // they differ, the input was rounded; if it parsed to 0, it was
    // invalid (vanilla L3030 animates errors in both cases).
    const typedAtom = parseConvRate(rateInput, bui, qui)
    if (typedAtom === 0) {
      // Empty is silent, anything else is a parse error worth flashing.
      if (rateInput.trim().length > 0) flashInvalid(priceBoxRef.current)
      return
    }
    if (typedAtom !== rateAtomRef.current) {
      flashInvalid(priceBoxRef.current)
    }
    if (rateAtomRef.current > 0) {
      setRateInput(formatRateAtomToRateStep(rateAtomRef.current, bui, qui, currentMkt.ratestep, isSell))
    }
  }, [bui, qui, currentMkt, isSell, rateInput, flashInvalid])

  const handleRateStep = useCallback((direction: 1 | -1) => {
    if (!bui || !qui || !currentMkt) return
    const step = currentMkt.ratestep
    let current = rateAtomRef.current || 0
    current += step * direction
    if (current < step) current = step
    const adjusted = isSell
      ? adjRateAtomSell(current, step)
      : adjRateAtomBuy(current, step)
    rateAtomRef.current = adjusted
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, step, isSell))
    if (!isSell) maxCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell])

  const handleQtyChange = useCallback((value: string) => {
    setQtyInput(value)
    if (!bui || !currentMkt) return
    // MP-16: If the value ends with a decimal separator, wait for the user to
    // finish typing before processing. Matches vanilla qty field handlers.
    if (value.length > 0) {
      const last = value.charAt(value.length - 1)
      if (last === '.' || last === ',') return
    }
    const qtyAtom = parseConvQty(value, bui)
    if (!qtyAtom) {
      qtyAtomRef.current = 0
      setSubmitEnabled(false)
      return
    }
    const lots = Math.floor(qtyAtom / currentMkt.lotsize)
    qtyAtomRef.current = lots * currentMkt.lotsize
    syncSlider()
  }, [bui, currentMkt, syncSlider])

  const handleQtyBlur = useCallback(() => {
    if (!bui || !currentMkt) return
    // MP-72: same input/change split as the rate field — flash the
    // outline if the typed value is invalid or got rounded down to a
    // sub-lot value. Vanilla `qtyField{Buy,Sell}ChangeHandler` calls
    // `animateErrors(highlightOutlineRed(qtyBox*))` when parseQtyInput
    // returns invalid or rounded; mirror that here.
    const typedAtom = parseConvQty(qtyInput, bui)
    if (typedAtom === 0) {
      if (qtyInput.trim().length > 0) flashInvalid(qtyBoxRef.current)
      return
    }
    if (typedAtom !== qtyAtomRef.current) {
      flashInvalid(qtyBoxRef.current)
    }
    if (qtyAtomRef.current > 0) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, currentMkt.lotsize))
    }
    syncSlider()
  }, [bui, currentMkt, syncSlider, qtyInput, flashInvalid])

  const handleQtyStep = useCallback((direction: 1 | -1) => {
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    let current = qtyAtomRef.current || 0
    current += lotsize * direction
    if (current < lotsize) current = lotsize
    const lots = Math.floor(current / lotsize)
    qtyAtomRef.current = lots * lotsize
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtomRef.current, bui, lotsize))
    syncSlider()
  }, [bui, currentMkt, syncSlider])

  // Slider handler: slider value (0-1) -> qty via max lots estimate
  const handleSlider = useCallback(async (value: number) => {
    setSliderValue(value)
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    const maxEst = await requestMax()
    const maxLots = maxEst?.swap.lots ?? 0
    if (maxLots <= 0) return
    const lots = Math.max(1, Math.floor(maxLots * value))
    const adjQty = lots * lotsize
    qtyAtomRef.current = adjQty
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(adjQty, bui, lotsize))
  }, [bui, currentMkt, requestMax])

  // Validate and enable submit button
  useEffect(() => {
    if (!selected || !currentMkt || !bui || !qui) {
      setSubmitEnabled(false)
      return
    }
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom || !qtyAtom) {
      setSubmitEnabled(false)
      setSubmitMsg('')
      return
    }
    if (rateAtom < currentMkt.minimumRate) {
      setSubmitEnabled(false)
      setSubmitMsg(t('RATE_BELOW_MIN_MSG', {
        minRate: formatRateAtomToRateStep(currentMkt.minimumRate, bui, qui, currentMkt.ratestep, isSell)
      }))
      return
    }
    let cancelled = false
    const validate = async () => {
      setSubmitMsg(t('CALCULATING'))
      setSubmitEnabled(false)
      maxReqIdRef.current++
      const reqId = maxReqIdRef.current
      const maxEst = await requestMax()
      if (cancelled || reqId !== maxReqIdRef.current) return
      if (isSell) {
        if (!maxEst || qtyAtom > maxEst.swap.value) {
          setSubmitEnabled(false)
          setSubmitMsg(t('INSUFFICIENT_BALANCE'))
          return
        }
      } else {
        if (!maxEst || qtyAtom > maxEst.swap.lots * currentMkt.lotsize) {
          setSubmitEnabled(false)
          setSubmitMsg(t('INSUFFICIENT_BALANCE'))
          return
        }
      }
      setSubmitEnabled(true)
      setSubmitMsg('')
    }
    validate()
    return () => { cancelled = true }
  }, [selected, currentMkt, bui, qui, isSell, rateInput, qtyInput, requestMax, t])

  // Preview total
  const previewTotal = useMemo(() => {
    const rateAtom = rateAtomRef.current
    const qtyAtom = qtyAtomRef.current
    if (!rateAtom || !qtyAtom || !bui || !qui || !currentMkt) return ''
    const total = baseToQuote(rateAtom, qtyAtom)
    return formatCoinAtomToLotSizeQuoteCurrency(total, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
  }, [rateInput, qtyInput, bui, qui, currentMkt])

  // MP-13: Wallet-readiness gate. Mirrors vanilla displayMessageIfMissingWallet
  // priority order — both missing > base missing > quote missing > base
  // disabled/not-running > quote disabled/not-running. When set, this message
  // replaces submitMsg and the submit button is disabled.
  const walletMsg = useMemo(() => {
    if (!selected) return ''
    const baseW = walletMap[selected.baseID]
    const quoteW = walletMap[selected.quoteID]
    const bs = shortSymbol(baseSymbol)
    const qs = shortSymbol(quoteSymbol)
    if (!baseW && !quoteW) return t('NO_WALLET_MSG', { asset1: bs, asset2: qs })
    if (!baseW) return t('CREATE_ASSET_WALLET_MSG', { asset: bs })
    if (!quoteW) return t('CREATE_ASSET_WALLET_MSG', { asset: qs })
    if (baseW.disabled || !baseW.running) return t('ENABLE_ASSET_WALLET_MSG', { asset: bs })
    if (quoteW.disabled || !quoteW.running) return t('ENABLE_ASSET_WALLET_MSG', { asset: qs })
    return ''
  }, [selected, walletMap, baseSymbol, quoteSymbol, t])

  // Submit order: step 1 - show confirmation. All validation (zero rate/qty,
  // min-rate, insufficient balance, wallet readiness) is handled by the
  // validate effect + walletMsg, which gate `submitEnabled` + disabled on the
  // button. By the time this runs, the button was clickable, so no further
  // checks are needed here.
  const stepSubmit = useCallback(async () => {
    if (!selected || !currentMkt || !bui || !qui) return
    setOrderError('')
    verifiedOrderRef.current = {
      host: selected.host, isLimit: true, sell: isSell,
      base: selected.baseID, quote: selected.quoteID,
      qty: qtyAtomRef.current, rate: rateAtomRef.current, tifnow: false, options: {}
    }
    setShowVerify(true)
  }, [selected, currentMkt, bui, qui, isSell])

  // Submit order: step 2 - send to server
  const submitVerifiedOrder = useCallback(async () => {
    if (!verifiedOrderRef.current) return
    setSubmitting(true)
    setOrderError('')
    const res = await postJSON('/api/tradeasync', { order: verifiedOrderRef.current })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setOrderError(res.msg || 'Order submission failed')
      return
    }
    setShowVerify(false)
    qtyAtomRef.current = currentMkt?.lotsize ?? 0
    if (bui && currentMkt) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(currentMkt.lotsize, bui, currentMkt.lotsize))
    }
    setSliderValue(0)
    maxCacheRef.current = {}
  }, [currentMkt, bui])

  return (
    <>
      <form id={isSell ? 'orderFormSell' : 'orderFormBuy'} className="d-flex flex-stretch-column py-1" autoComplete="off">
        {/* Price input. MP-70: clicking anywhere in the wrapper focuses
            the input (vanilla L366-368). The visual focus border is
            handled by the SCSS `:focus-within` rule on
            `.order-form-input`, so no JS class toggling is needed. */}
        <div
          ref={priceBoxRef}
          className="d-flex align-items-center order-form-input select m-1"
          onClick={() => rateInputRef.current?.focus()}
        >
          <label className="form-label grey fs18 px-2">Price</label>
          <input
            ref={rateInputRef}
            type="text"
            className="text-end demi fs18 p-0"
            value={rateInput}
            onChange={e => handleRateChange(e.target.value)}
            onBlur={handleRateBlur}
            onKeyDown={e => {
              if (e.key === 'ArrowUp') { e.preventDefault(); handleRateStep(1) }
              if (e.key === 'ArrowDown') { e.preventDefault(); handleRateStep(-1) }
            }}
          />
          <span className="grey demi fs18 px-1">{quiConv?.unit ?? ''}</span>
          <div className="d-flex flex-stretch-column align-items-center justify-content-between arrows-up-down ps-0-5 pe-1 border-left">
            <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 border-bottom pointer" onClick={() => handleRateStep(1)}>
              <div className="arrow-up"></div>
            </div>
            <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 pointer" onClick={() => handleRateStep(-1)}>
              <div className="arrow-down"></div>
            </div>
          </div>
        </div>
        {/* Quantity input. MP-70: same focus-on-wrapper-click behavior
            as the price box (vanilla L392-394). */}
        <div
          ref={qtyBoxRef}
          className="d-flex align-items-center order-form-input select m-1"
          onClick={() => qtyInputRef.current?.focus()}
        >
          <label className="form-label grey fs18 px-2">Quantity</label>
          <input
            ref={qtyInputRef}
            type="text"
            className="text-end demi fs18 p-0"
            value={qtyInput}
            onChange={e => handleQtyChange(e.target.value)}
            onBlur={handleQtyBlur}
            onKeyDown={e => {
              if (e.key === 'ArrowUp') { e.preventDefault(); handleQtyStep(1) }
              if (e.key === 'ArrowDown') { e.preventDefault(); handleQtyStep(-1) }
            }}
          />
          <span className="grey demi fs18 px-1">{buiConv?.unit ?? ''}</span>
          <div className="d-flex flex-stretch-column align-items-center justify-content-between arrows-up-down ps-0-5 pe-1 border-left">
            <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 border-bottom pointer" onClick={() => handleQtyStep(1)}>
              <div className="arrow-up"></div>
            </div>
            <div className="d-flex flex-grow-1 flex-stretch-column justify-content-center px-0-5 pointer" onClick={() => handleQtyStep(-1)}>
              <div className="arrow-down"></div>
            </div>
          </div>
        </div>
        {/* Slider with 5 mark indicators (0/25/50/75/100%). */}
        <div id={isSell ? 'qtySliderSell' : 'qtySliderBuy'} className="mt-2 mb-1 mx-2">
          <input
            type="range" min="0" max="1" step="0.01"
            value={sliderValue}
            onChange={e => handleSlider(parseFloat(e.target.value))}
            style={{ backgroundSize: `${sliderValue * 100}% 100%` }}
          />
          <div className="slider-mark slider-mark-0 mark-enabled"></div>
          <div className={`slider-mark slider-mark-25${sliderValue > 0.25 ? ' mark-enabled' : ''}`}></div>
          <div className={`slider-mark slider-mark-50${sliderValue > 0.50 ? ' mark-enabled' : ''}`}></div>
          <div className={`slider-mark slider-mark-75${sliderValue > 0.75 ? ' mark-enabled' : ''}`}></div>
          <div className={`slider-mark slider-mark-100${sliderValue >= 1.0 ? ' mark-enabled' : ''}`}></div>
        </div>
        {/* Preview total — the conversion display ("qty ⇄ previewTotal").
            All three cells gate on `previewTotal`: when no rate has been
            entered, the conversion is meaningless so we render an empty
            row (not the naked qty input echoed back). */}
        <div className="d-flex m-1">
          {isSell
            ? (
              <>
                <div className="d-flex align-items-center justify-content-end me-1 demi fs18" style={{ flexBasis: '47%' }}>
                  {previewTotal && <>{qtyInput} {buiConv?.unit ?? ''}</>}
                </div>
                <span className="d-flex align-items-center justify-content-center mx-1 pt-0-5 fs22 grey" style={{ flexBasis: '6%' }}>{previewTotal ? '\u21C4' : ''}</span>
                <div className="d-flex align-items-center justify-content-start ms-1 demi fs18" style={{ flexBasis: '47%' }}>
                  {previewTotal && <>{previewTotal} {quiConv?.unit ?? ''}</>}
                </div>
              </>
            )
            : (
              <>
                <div className="d-flex align-items-center justify-content-end me-1 demi fs18" style={{ flexBasis: '47%' }}>
                  {previewTotal && <>{previewTotal} {quiConv?.unit ?? ''}</>}
                </div>
                <span className="d-flex align-items-center justify-content-center mx-1 pt-0-5 fs22 grey" style={{ flexBasis: '6%' }}>{previewTotal ? '\u21C4' : ''}</span>
                <div className="d-flex align-items-center justify-content-start ms-1 demi fs18" style={{ flexBasis: '47%' }}>
                  {previewTotal && <>{qtyInput} {buiConv?.unit ?? ''}</>}
                </div>
              </>
            )}
        </div>
        {(() => {
          const msg = walletMsg || submitMsg
          const defaultLabel = `${isSell ? t('Sell') : t('Buy')} ${shortSymbol(baseSymbol)}`
          const btn = (
            <button
              type="button"
              className={`flex-center border pointer hoverbg border-rounded3 m-1 mt-auto submit fs18 text-center ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
              disabled={!submitEnabled || !!walletMsg}
              onClick={stepSubmit}
            >
              <span className="overflow-ellipsis text-nowrap" style={{ minWidth: 0, maxWidth: '100%' }}>
                {msg || defaultLabel}
              </span>
            </button>
          )
          return msg ? <Tooltip content={msg}>{btn}</Tooltip> : btn
        })()}
      </form>

      {/* Order verification modal */}
      <FormOverlay show={showVerify} onClose={() => { setShowVerify(false); setOrderError('') }}>
        <VerifyOrderForm
          isSell={isSell}
          order={verifiedOrderRef.current}
          bui={bui}
          qui={qui}
          currentMkt={currentMkt}
          baseSymbol={baseSymbol}
          buiUnit={buiConv?.unit ?? ''}
          quiUnit={quiConv?.unit ?? ''}
          baseFiatRate={baseFiatRate}
          quoteFiatRate={quoteFiatRate}
          submitting={submitting}
          orderError={orderError}
          disclaimerAcked={disclaimerAcked}
          onAckDisclaimer={ackDisclaimer}
          onUnackDisclaimer={unackDisclaimer}
          onClose={() => { setShowVerify(false); setOrderError('') }}
          onSubmit={submitVerifiedOrder}
          t={t}
        />
      </FormOverlay>
    </>
  )
}
