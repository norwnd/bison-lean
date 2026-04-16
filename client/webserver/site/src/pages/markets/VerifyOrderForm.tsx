import {
  formatRateAtomToRateStep,
  formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency,
  formatFiatConversion
} from '../../hooks/useFormatters'
import { baseToQuote } from '../../components/AccountUtils'
import type { Market, UnitInfo } from '../../stores/types'

// ---------------------------------------------------------------------------
// VerifyOrderForm — the confirmation modal shown after the user clicks the
// main order-form submit button. Extracted from OrderForm to keep the
// Batch 9 parity changes (MP-51..MP-55) isolated and independently
// testable. All inputs are props; no side effects beyond invoking the
// callbacks passed in.
// ---------------------------------------------------------------------------

export interface VerifyOrderFormProps {
  isSell: boolean
  order: {
    host: string
    rate: number
    qty: number
    tifnow?: boolean
  } | null
  bui: UnitInfo | null
  qui: UnitInfo | null
  currentMkt: Market | null
  baseSymbol: string
  buiUnit: string
  quiUnit: string
  baseFiatRate: number
  quoteFiatRate: number
  submitting: boolean
  orderError: string
  disclaimerAcked: boolean
  onAckDisclaimer: () => void
  onUnackDisclaimer: () => void
  onClose: () => void
  onSubmit: () => void
  t: (key: string, opts?: Record<string, string>) => string
}

export function VerifyOrderForm ({
  isSell, order, bui, qui, currentMkt, baseSymbol, buiUnit, quiUnit,
  baseFiatRate, quoteFiatRate, submitting, orderError,
  disclaimerAcked, onAckDisclaimer, onUnackDisclaimer,
  onClose, onSubmit, t
}: VerifyOrderFormProps) {
  // MP-54: order type label. Vanilla (markets.ts L2436-2441) reads:
  //   const buySellStr = intl.prep(isSell ? ID_SELL : ID_BUY)
  //   const orderDesc  = `Limit ${buySellStr} Order`
  //   vOrderType = order.tifnow ? orderDesc + ' (immediate)' : orderDesc
  const buySellStr = isSell ? t('Sell') : t('Buy')
  const orderDesc = `Limit ${buySellStr} Order`
  const orderTypeLabel = order?.tifnow ? `${orderDesc} (immediate)` : orderDesc

  // MP-51: disclaimer HTML interpolation. The `order_disclaimer` i18n key
  // still contains `<span class="red">IMPORTANT</span>` presentational HTML,
  // so we need `dangerouslySetInnerHTML`. Brand and ticker placeholders are
  // now handled via react-i18next `{{ }}` interpolation in en-US.json.
  const disclaimerHtml = t('order_disclaimer', {
    brand: 'Bison Wallet',
    baseTicker: buiUnit,
    quoteTicker: quiUnit,
  })

  // MP-52: fiat total. Vanilla `showFiatValue` (markets.ts L2507-2513)
  // multiplies the atomic youGet qty by `fiatRatesMap[youGetAsset.id]` and
  // hides the parent if rate is 0. We compute `youGetAtom` and pick the
  // matching fiat rate based on which side of the trade is the `youGet`
  // asset (non-sell = base is youGet; sell = quote is youGet).
  let youSpendText = ''
  let youGetText = ''
  let youGetAtom = 0
  let youGetFiatRate = 0
  let youGetUnitInfo: UnitInfo | null = null
  let youSpendUnit = ''
  let youGetUnit = ''
  let rateDisplay = ''
  if (order && bui && qui && currentMkt) {
    rateDisplay = formatRateAtomToRateStep(
      order.rate, bui, qui, currentMkt.ratestep, isSell
    )
    const baseQty = order.qty
    const quoteQty = baseToQuote(order.rate, order.qty)
    if (isSell) {
      // Sell: spend base, get quote.
      youSpendText = formatCoinAtomToLotSizeBaseCurrency(baseQty, bui, currentMkt.lotsize)
      youGetText = formatCoinAtomToLotSizeQuoteCurrency(quoteQty, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
      youSpendUnit = buiUnit
      youGetUnit = quiUnit
      youGetAtom = quoteQty
      youGetFiatRate = quoteFiatRate
      youGetUnitInfo = qui
    } else {
      // Buy: spend quote, get base.
      youSpendText = formatCoinAtomToLotSizeQuoteCurrency(quoteQty, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
      youGetText = formatCoinAtomToLotSizeBaseCurrency(baseQty, bui, currentMkt.lotsize)
      youSpendUnit = quiUnit
      youGetUnit = buiUnit
      youGetAtom = baseQty
      youGetFiatRate = baseFiatRate
      youGetUnitInfo = bui
    }
  }

  // MP-52: only render the fiat row when we have a positive rate. Vanilla
  // hides the parent via `Doc.hide(display.parentElement)` when rate is 0.
  const showFiatTotal = youGetFiatRate > 0 && youGetUnitInfo !== null
  const fiatTotalText = showFiatTotal
    ? formatFiatConversion(youGetAtom, youGetFiatRate, youGetUnitInfo ?? undefined)
    : ''

  return (
    <form id="verifyForm" className="position-relative" autoComplete="off">
      <div className="form-closer" onClick={onClose}><span className="ico-cross"></span></div>
      <header id="vHeader" className={`fs18 ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}>
        {/* vBuySell: vanilla uses the gerund form (Selling/Buying) at
            markets.ts L2435. */}
        <span id="vBuySell" className="me-2">{isSell ? t('SELLING') : t('BUYING')}</span>
        {' '}
        <span>{baseSymbol}</span>
      </header>
      {order && bui && qui && currentMkt && (
        <>
          <div className="d-flex justify-content-between align-items-center fs14">
            {/* MP-54: vOrderType */}
            <span id="vOrderType" className="grey">{orderTypeLabel}</span>
            <span id="vOrderHost" className="grey">{order.host}</span>
          </div>
          <div id="verifyLimit">
            <div className="d-flex align-items-center justify-content-between">
              <span className="grey fs18 flex-grow-1 text-start">{t('Price')}</span>
              <span id="vRate" className="fs18 demi">{rateDisplay}</span>
              <span className="grey fs18 ms-2">
                <sup>{quiUnit}</sup>/<sub>{buiUnit}</sub>
              </span>
            </div>
            <div className="d-flex align-items-center mt-1">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Spend')}</span>
              {/* MP-55: prefix with `-`. Vanilla L2484. */}
              <span id="youSpend" className="fs18 demi">{'-' + youSpendText}</span>
              <span id="youSpendTicker" className="grey fs18 ms-2">{youSpendUnit}</span>
            </div>
            <div className="d-flex align-items-center mt-1">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Get')}</span>
              {/* MP-55: prefix with `+`. Vanilla L2486. */}
              <span id="youGet" className="fs18 demi">{'+' + youGetText}</span>
              <span id="youGetTicker" className="grey fs18 ms-2">{youGetUnit}</span>
            </div>
            {/* MP-52: fiat total — hidden when fiat rate unavailable. */}
            {showFiatTotal && (
              <span className="d-flex justify-content-end grey fs14">
                ~<span id="vFiatTotal" className="mx-1">{fiatTotalText}</span>USD
              </span>
            )}
          </div>
        </>
      )}
      <div className="flex-stretch-column">
        {/* MP-53: hide submit button entirely while submitting and show a
            separate loader block. Vanilla submitVerifiedOrder (L2862-2865)
            does the same: `Doc.hide(vSubmit); Doc.show(vLoader)`. */}
        {!submitting && (
          <button
            id="vSubmit"
            type="button"
            className={`justify-content-center fs18 go ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
            onClick={onSubmit}
          >
            <span id="vSideSubmit">{buySellStr}</span>
            {' '}
            <span>{baseSymbol}</span>
          </button>
        )}
        {submitting && (
          <div id="vLoader" className="loader flex-center">
            <div className="ico-spinner spinner"></div>
          </div>
        )}
      </div>
      {orderError && (
        <div id="vErr" className="fs17 p-3 text-center text-danger text-break">{orderError}</div>
      )}

      {/* MP-51: disclaimer block + ack toggle. Vanilla markets.tmpl
          L510-520 and markets.ts L479-491. When acked, the disclaimer
          block is hidden and a "view warnings" link is shown; clicking
          it un-acks and re-opens the block. */}
      {!disclaimerAcked && (
        <>
          <div
            id="disclaimer"
            className="disclaimer fs17 pt-3 mt-3 border-top"
            dangerouslySetInnerHTML={{ __html: disclaimerHtml }}
          />
          <div
            id="disclaimerAck"
            className="d-flex align-items-center grey text-center pointer hoverbg fs17"
            onClick={onAckDisclaimer}
          >
            <span className="ico-check fs12 me-1"></span>
            <span>{t('acknowledge_and_hide')}</span>
          </div>
        </>
      )}
      {disclaimerAcked && (
        <div
          id="showDisclaimer"
          className="d-flex align-items-center grey text-center pointer hoverbg fs17"
          onClick={onUnackDisclaimer}
        >
          <span className="ico-plus fs8 me-1 mt-1"></span>
          <span>{t('show_disclaimer')}</span>
        </div>
      )}
    </form>
  )
}
