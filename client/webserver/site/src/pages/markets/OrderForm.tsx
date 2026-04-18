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

  // Fully independent form state. Both the display string (rateInput) and
  // the parsed/adjusted atom value (rateAtom) are first-class state. Keeping
  // atoms as state rather than refs means memos that depend on the atomic
  // value (previewTotal, rateMinMsg, the button's `enabled`) read the value
  // directly instead of using the string as a dep proxy, which would leave
  // them stale if a future code path mutates the atom without also calling
  // the string setter.
  const [rateInput, setRateInput] = useState('')
  const [qtyInput, setQtyInput] = useState('')
  const [rateAtom, setRateAtom] = useState(0)
  const [qtyAtom, setQtyAtom] = useState(0)
  const [sliderValue, setSliderValue] = useState(0)
  // Click-time validation: errorMsg is the post-click failure (insufficient
  // balance, etc.); inFlight is the depressed visual while max-est is in
  // flight after a click. Background validation is intentionally absent so
  // the button never flashes "calculating..." on its own.
  const [errorMsg, setErrorMsg] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const [showVerify, setShowVerify] = useState(false)
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
  // MP-17: market-switch guard. Snapshot `selected` at requestMax call time,
  // compare against `selectedRef.current` after the fetch returns; drop the
  // response if the market has changed. The OrderForm `key` prop normally
  // remounts the component on a market switch, but this guard is a defensive
  // safety net that mirrors vanilla's marketBefore/marketAfter check.
  const selectedRef = useRef(selected)
  useEffect(() => { selectedRef.current = selected }, [selected])
  // Mirror of walletMap for requestMax so its callback identity stays stable
  // across WS balance notes (every balance note creates a new walletMap
  // identity). Without this, requestMax would get a new identity on every
  // balance note, churning through every downstream callback that depends
  // on it (stepSubmit, syncSlider, etc.). Consumers reading via the ref
  // see the latest walletMap because event handlers run after effects.
  const walletMapRef = useRef(walletMap)
  useEffect(() => { walletMapRef.current = walletMap }, [walletMap])

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

  // Invalidate max caches when the relevant wallets change. Narrowed to
  // the base/quote wallet entries so unrelated WS balance notes don't
  // churn the cache — useMarketStore's immutable updates replace only
  // the notified asset's wallet, so these refs stay stable otherwise.
  const baseWallet = selected ? walletMap[selected.baseID] : undefined
  const quoteWallet = selected ? walletMap[selected.quoteID] : undefined
  useEffect(() => {
    maxCacheRef.current = {}
  }, [baseWallet, quoteWallet])

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
    setQtyAtom(currentMkt.lotsize)
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
    setRateAtom(adjusted)
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
    const wm = walletMapRef.current
    if (isSell) {
      const cached = maxCacheRef.current[0]
      if (cached) return cached
      const baseWallet = wm[selected.baseID]
      if (!baseWallet?.running) return null
      const res = await postJSON('/api/maxsell', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxSell) return null
      maxCacheRef.current[0] = res.maxSell
      return res.maxSell as MaxOrderEstimate
    } else {
      if (!rateAtom) return null
      const cached = maxCacheRef.current[rateAtom]
      if (cached) return cached
      const quoteWallet = wm[selected.quoteID]
      if (!quoteWallet?.running) return null
      const res = await postJSON('/api/maxbuy', {
        host: selected.host, base: selected.baseID, quote: selected.quoteID, rate: rateAtom
      })
      if (marketChanged()) return null
      if (!checkResponse(res) || !res.maxBuy) return null
      maxCacheRef.current[rateAtom] = res.maxBuy
      return res.maxBuy as MaxOrderEstimate
    }
  }, [selected, currentMkt, bui, qui, isSell, rateAtom])

  // Sync slider position from a given qty vs max estimate. Takes qty as a
  // parameter because callers often invoke it immediately after queuing a
  // setQtyAtom update, and state updates are asynchronous — reading the
  // captured qtyAtom from a closure would see the old value.
  const syncSlider = useCallback(async (qty: number) => {
    if (!currentMkt) return
    const lotsize = currentMkt.lotsize
    const currentLots = Math.floor(qty / lotsize)
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
    const parsed = parseConvRate(value, bui, qui)
    if (!parsed) {
      setRateAtom(0)
      return
    }
    const adjusted = isSell
      ? adjRateAtomSell(parsed, currentMkt.ratestep)
      : adjRateAtomBuy(parsed, currentMkt.ratestep)
    setRateAtom(adjusted)
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
    // `rateAtom` that handleRateChange stored — if they differ, the
    // input was rounded; if it parsed to 0, it was invalid (vanilla
    // L3030 animates errors in both cases).
    const typedAtom = parseConvRate(rateInput, bui, qui)
    if (typedAtom === 0) {
      // Empty is silent, anything else is a parse error worth flashing.
      if (rateInput.trim().length > 0) flashInvalid(priceBoxRef.current)
      return
    }
    if (typedAtom !== rateAtom) {
      flashInvalid(priceBoxRef.current)
    }
    if (rateAtom > 0) {
      setRateInput(formatRateAtomToRateStep(rateAtom, bui, qui, currentMkt.ratestep, isSell))
    }
  }, [bui, qui, currentMkt, isSell, rateInput, rateAtom, flashInvalid])

  const handleRateStep = useCallback((direction: 1 | -1) => {
    if (!bui || !qui || !currentMkt) return
    const step = currentMkt.ratestep
    let current = rateAtom || 0
    current += step * direction
    if (current < step) current = step
    const adjusted = isSell
      ? adjRateAtomSell(current, step)
      : adjRateAtomBuy(current, step)
    setRateAtom(adjusted)
    setRateInput(formatRateAtomToRateStep(adjusted, bui, qui, step, isSell))
    if (!isSell) maxCacheRef.current = {}
  }, [bui, qui, currentMkt, isSell, rateAtom])

  const handleQtyChange = useCallback((value: string) => {
    setQtyInput(value)
    if (!bui || !currentMkt) return
    // MP-16: If the value ends with a decimal separator, wait for the user to
    // finish typing before processing. Matches vanilla qty field handlers.
    if (value.length > 0) {
      const last = value.charAt(value.length - 1)
      if (last === '.' || last === ',') return
    }
    const parsed = parseConvQty(value, bui)
    if (!parsed) {
      setQtyAtom(0)
      return
    }
    const lots = Math.floor(parsed / currentMkt.lotsize)
    const next = lots * currentMkt.lotsize
    setQtyAtom(next)
    syncSlider(next)
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
    if (typedAtom !== qtyAtom) {
      flashInvalid(qtyBoxRef.current)
    }
    if (qtyAtom > 0) {
      setQtyInput(formatCoinAtomToLotSizeBaseCurrency(qtyAtom, bui, currentMkt.lotsize))
    }
    syncSlider(qtyAtom)
  }, [bui, currentMkt, syncSlider, qtyInput, qtyAtom, flashInvalid])

  const handleQtyStep = useCallback((direction: 1 | -1) => {
    if (!bui || !currentMkt) return
    const lotsize = currentMkt.lotsize
    let current = qtyAtom || 0
    current += lotsize * direction
    if (current < lotsize) current = lotsize
    const lots = Math.floor(current / lotsize)
    const next = lots * lotsize
    setQtyAtom(next)
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(next, bui, lotsize))
    syncSlider(next)
  }, [bui, currentMkt, syncSlider, qtyAtom])

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
    setQtyAtom(adjQty)
    setQtyInput(formatCoinAtomToLotSizeBaseCurrency(adjQty, bui, lotsize))
  }, [bui, currentMkt, requestMax])

  // Cheap, synchronous "rate below min" check. This is the only validation
  // we surface as a persistent message before the user clicks — it doesn't
  // require a server round-trip, so showing it eagerly costs nothing and
  // helps the user fix the input. Insufficient-balance and similar checks
  // require requestMax() and are deferred to click time.
  const rateMinMsg = useMemo(() => {
    if (!currentMkt || !bui || !qui) return ''
    if (!rateAtom) return ''
    if (rateAtom < currentMkt.minimumRate) {
      return t('RATE_BELOW_MIN_MSG', {
        minRate: formatRateAtomToRateStep(currentMkt.minimumRate, bui, qui, currentMkt.ratestep, isSell)
      })
    }
    return ''
  }, [rateAtom, currentMkt, bui, qui, isSell, t])

  // Reactive error clearing: when the inputs change OR the relevant wallet
  // state changes, the previous click's error may no longer apply (user
  // adjusted qty, balance update arrived, etc.). Clear it so the user can
  // try again. We deliberately avoid re-running validation here — the
  // next click does that. Narrowed to base/quote wallets so unrelated WS
  // balance notes don't clear errors unnecessarily.
  useEffect(() => {
    setErrorMsg('')
  }, [rateInput, qtyInput, baseWallet, quoteWallet])

  // Preview total
  const previewTotal = useMemo(() => {
    if (!rateAtom || !qtyAtom || !bui || !qui || !currentMkt) return ''
    const total = baseToQuote(rateAtom, qtyAtom)
    return formatCoinAtomToLotSizeQuoteCurrency(total, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
  }, [rateAtom, qtyAtom, bui, qui, currentMkt])

  // MP-13: Wallet-readiness gate. Mirrors vanilla displayMessageIfMissingWallet
  // priority order — both missing > base missing > quote missing > base
  // disabled/not-running > quote disabled/not-running. When set, this message
  // is shown on the submit button and gates it disabled.
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

  // Submit order: step 1 — click-time validation. The button label/disabled
  // state only gates on cheap synchronous checks (wallet ready, rate above
  // min, non-zero rate/qty); the expensive max-est fetch happens here so
  // the button never flashes a "calculating..." text on its own. While the
  // fetch is in flight the button shows a depressed visual (`inFlight`)
  // and can't be re-clicked (disabled). On failure we set `errorMsg`,
  // which the button shows in place of its label until the user changes
  // an input or a balance update arrives (see the reactive-clear effect).
  const stepSubmit = useCallback(async () => {
    if (!selected || !currentMkt || !bui || !qui) return
    if (!rateAtom || !qtyAtom) return
    setErrorMsg('')
    setInFlight(true)
    const maxEst = await requestMax()
    setInFlight(false)
    const enough = isSell
      ? maxEst && qtyAtom <= maxEst.swap.value
      : maxEst && qtyAtom <= maxEst.swap.lots * currentMkt.lotsize
    if (!enough) {
      setErrorMsg(t('INSUFFICIENT_BALANCE'))
      return
    }
    verifiedOrderRef.current = {
      host: selected.host, isLimit: true, sell: isSell,
      base: selected.baseID, quote: selected.quoteID,
      qty: qtyAtom, rate: rateAtom, tifnow: false, options: {}
    }
    setShowVerify(true)
  }, [selected, currentMkt, bui, qui, isSell, requestMax, rateAtom, qtyAtom, t])

  // Called by VerifyOrderForm after a successful order submit. Resets the
  // form state and closes the modal; VerifyOrderForm owns the POST + its
  // own submitting/error state.
  const handleOrderSuccess = useCallback(() => {
    setShowVerify(false)
    setQtyAtom(currentMkt?.lotsize ?? 0)
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
          const defaultLabel = `${isSell ? t('Sell') : t('Buy')} ${shortSymbol(baseSymbol)}`
          // Priority: wallet readiness > sync rate-min check > last click error.
          // The button never shows "calculating..." — it keeps the default
          // label and applies the `submit-pressed` visual for the entire
          // time the user is "mid-order": while the async max-est is in
          // flight, and continuing through the verify-modal lifetime until
          // it closes. This gives stable click feedback regardless of how
          // fast the max-est fetch resolves (e.g. warm cache = instant).
          const msg = walletMsg || rateMinMsg || errorMsg
          const pressed = inFlight || showVerify
          const enabled = !msg && !pressed && !!rateAtom && !!qtyAtom &&
            !!selected && !!currentMkt && !!bui && !!qui
          // Always wrap in Tooltip so the button doesn't remount when msg
          // toggles empty↔non-empty. Tooltip is a no-op on empty content.
          return (
            <Tooltip content={msg}>
              <button
                type="button"
                className={`flex-center border pointer hoverbg border-rounded3 m-1 mt-auto submit fs18 text-center ${isSell ? 'sellred-bg' : 'buygreen-bg'}${pressed ? ' submit-pressed' : ''}`}
                disabled={!enabled}
                onClick={stepSubmit}
              >
                <span className="overflow-ellipsis text-nowrap" style={{ minWidth: 0, maxWidth: '100%' }}>
                  {msg || defaultLabel}
                </span>
              </button>
            </Tooltip>
          )
        })()}
      </form>

      {/* Order verification modal */}
      <FormOverlay bare show={showVerify} onClose={() => setShowVerify(false)}>
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
          disclaimerAcked={disclaimerAcked}
          onAckDisclaimer={ackDisclaimer}
          onUnackDisclaimer={unackDisclaimer}
          onClose={() => setShowVerify(false)}
          onSuccess={handleOrderSuccess}
          t={t}
        />
      </FormOverlay>
    </>
  )
}
