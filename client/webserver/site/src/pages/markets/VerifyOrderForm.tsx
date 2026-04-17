import {
  formatRateAtomToRateStep,
  formatCoinAtomToLotSizeBaseCurrency,
  formatCoinAtomToLotSizeQuoteCurrency,
  formatFiat, atomToConventional, shortSymbol
} from '../../hooks/useFormatters'
import { baseToQuote } from '../../components/AccountUtils'
import type { Market, UnitInfo } from '../../stores/types'

// ---------------------------------------------------------------------------
// VerifyOrderForm — confirmation modal shown after the user submits the
// main order form. Pure props in, callbacks out; no side effects.
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
  const buySellStr = isSell ? t('Sell') : t('Buy')
  const orderDesc = `Limit ${buySellStr} Order`
  const orderTypeLabel = order?.tifnow ? `${orderDesc} (immediate)` : orderDesc

  // The `order_disclaimer` i18n key contains `<span class="red">IMPORTANT</span>`
  // presentational HTML, so we need `dangerouslySetInnerHTML`.
  const disclaimerHtml = t('order_disclaimer', {
    brand: 'Bison Wallet',
    baseTicker: buiUnit,
    quoteTicker: quiUnit,
  })

  // Fiat estimate: both the `youSpend` and `youGet` sides depend on the
  // trade direction (buy = base is youGet, quote is youSpend; sell
  // reverses). Pick the matching atomic qty + fiat rate + unit-info
  // for each side's conversion below.
  let youSpendText = ''
  let youGetText = ''
  let youSpendAtom = 0
  let youSpendFiatRate = 0
  let youSpendUnitInfo: UnitInfo | null = null
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
      youSpendAtom = baseQty
      youSpendFiatRate = baseFiatRate
      youSpendUnitInfo = bui
      youGetAtom = quoteQty
      youGetFiatRate = quoteFiatRate
      youGetUnitInfo = qui
    } else {
      // Buy: spend quote, get base.
      youSpendText = formatCoinAtomToLotSizeQuoteCurrency(quoteQty, bui, qui, currentMkt.lotsize, currentMkt.ratestep)
      youGetText = formatCoinAtomToLotSizeBaseCurrency(baseQty, bui, currentMkt.lotsize)
      youSpendUnit = quiUnit
      youGetUnit = buiUnit
      youSpendAtom = quoteQty
      youSpendFiatRate = quoteFiatRate
      youSpendUnitInfo = qui
      youGetAtom = baseQty
      youGetFiatRate = baseFiatRate
      youGetUnitInfo = bui
    }
  }

  // Hide each fiat row independently when its rate is unavailable.
  const showSpendFiat = youSpendFiatRate > 0 && youSpendUnitInfo !== null
  const showGetFiat = youGetFiatRate > 0 && youGetUnitInfo !== null
  const spendFiatText = showSpendFiat
    ? formatFiat(atomToConventional(youSpendAtom, youSpendUnitInfo ?? undefined)[0] * youSpendFiatRate)
    : ''
  const getFiatText = showGetFiat
    ? formatFiat(atomToConventional(youGetAtom, youGetUnitInfo ?? undefined)[0] * youGetFiatRate)
    : ''

  return (
    <form id="verifyForm" className="modal-form" autoComplete="off">
      <button type="button" className="form-close-btn" onClick={onClose} aria-label="Close"><span className="ico-cross"></span></button>
      {order && bui && qui && currentMkt && (
        <>
          <div className="d-flex justify-content-between align-items-center fs14 pe-4">
            <span id="vOrderType" className="grey">{orderTypeLabel}</span>
            <span id="vOrderHost" className="grey">{order.host}</span>
          </div>
          <div id="verifyLimit" className="mt-3">
            <div className="d-flex align-items-center justify-content-between">
              <span className="grey fs18 flex-grow-1 text-start">{t('Price')}</span>
              <span id="vRate" className="fs18 demi">{rateDisplay}</span>
              <span className="grey fs18 ms-2">
                <sup>{quiUnit}</sup>/<sub>{buiUnit}</sub>
              </span>
            </div>
            <div className="d-flex align-items-center mt-3">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Spend')}</span>
              <span id="youSpend" className="fs18 demi">{'-' + youSpendText}</span>
              <span id="youSpendTicker" className="grey fs18 ms-2">{youSpendUnit}</span>
            </div>
            {showSpendFiat && (
              <span className="d-flex justify-content-end grey fs14 mt-1">
                ~${spendFiatText}
              </span>
            )}
            <div className="d-flex align-items-center mt-3">
              <span className="grey fs18 flex-grow-1 text-start">{t('You Get')}</span>
              <span id="youGet" className="fs18 demi">{'+' + youGetText}</span>
              <span id="youGetTicker" className="grey fs18 ms-2">{youGetUnit}</span>
            </div>
            {showGetFiat && (
              <span className="d-flex justify-content-end grey fs14 mt-1">
                ~${getFiatText}
              </span>
            )}
          </div>
        </>
      )}
      <div className="flex-stretch-column mt-3">
        {/* While submitting, hide the submit button and show a loader
            block instead. */}
        {!submitting && (
          <button
            id="vSubmit"
            type="button"
            className={`justify-content-center fs18 go ${isSell ? 'sellred-bg' : 'buygreen-bg'}`}
            onClick={onSubmit}
          >
            <span id="vSideSubmit">{buySellStr}</span>
            {' '}
            <span>{shortSymbol(baseSymbol)}</span>
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

      {/* Disclaimer + ack toggle. When acked, the disclaimer block is
          hidden and a "view warnings" link is shown in its place;
          clicking that un-acks and re-opens the block. */}
      {!disclaimerAcked && (
        <>
          <div
            id="disclaimer"
            className="disclaimer fs17 pt-3 mt-3 border-top"
            dangerouslySetInnerHTML={{ __html: disclaimerHtml }}
          />
          <button
            id="disclaimerAck"
            type="button"
            className="d-flex justify-content-center align-items-center small grey mt-3 w-100"
            onClick={onAckDisclaimer}
          >
            <span className="ico-check me-2"></span>
            <span>{t('acknowledge_and_hide')}</span>
          </button>
        </>
      )}
      {disclaimerAcked && (
        <button
          id="showDisclaimer"
          type="button"
          className="d-flex justify-content-center align-items-center small grey mt-3 w-100"
          onClick={onUnackDisclaimer}
        >
          <span className="ico-plus me-2"></span>
          <span>{t('show_disclaimer')}</span>
        </button>
      )}
    </form>
  )
}
