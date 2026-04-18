import { useTranslation } from 'react-i18next'
import type { WalletState } from '../../stores/types'
import { useMarketPageContext } from './MarketPageContext'
import { OrderForm } from './OrderForm'

// ---------------------------------------------------------------------------
// TradeForms -- the buy/sell OrderForm pair with the cannot-trade overlay.
// Reads selected / currentMkt / bui / qui from MarketPageContext.
// ---------------------------------------------------------------------------

export interface TradeFormsProps {
  walletMap: Record<number, WalletState>
  baseSymbol: string
  quoteSymbol: string
  baseFiatRate: number
  quoteFiatRate: number
  bookRateAtom: number
  bookRateVersion: number
  cantTradeReason: string | null
  // Non-empty string when login warmup is in progress (WS already
  // connected but auth not yet complete, or WS still dialing). Used
  // both to show the spinner overlay and to pick the specific label
  // ("Connecting…" vs "Authenticating…"). Empty string means not in
  // warmup.
  warmupMsg: string
  authFailedMsg: string | null
}

export function TradeForms ({
  walletMap,
  baseSymbol,
  quoteSymbol,
  baseFiatRate,
  quoteFiatRate,
  bookRateAtom,
  bookRateVersion,
  cantTradeReason,
  warmupMsg,
  authFailedMsg
}: TradeFormsProps) {
  const { t } = useTranslation()
  const { selected, currentMkt, bui, qui } = useMarketPageContext()

  return (
    /* Buy / Sell forms (side by side). MP-61 (deferred half):
        the section is `position-relative` so the
        `.cannot-trade-overlay` (rendered as a sibling below) can
        cover the forms when `cantTradeReason` is non-null. The
        forms themselves render on `selected` (unchanged from
        before this batch) -- the overlay handles suppression
        visually without unmounting, so the user's in-progress
        input survives wallet-state degradation. The overlay
        condition implicitly requires `currentMkt` to be truthy
        via the `cantTradeReason` cascade's early return. */
    <section className="d-flex position-relative">
      <OrderForm
        key={`buy-${selected.host}-${selected.baseID}-${selected.quoteID}`}
        side="buy"
        selected={selected}
        currentMkt={currentMkt}
        bui={bui}
        qui={qui}
        walletMap={walletMap}
        baseSymbol={baseSymbol}
        quoteSymbol={quoteSymbol}
        baseFiatRate={baseFiatRate}
        quoteFiatRate={quoteFiatRate}
        bookRateAtom={bookRateAtom}
        bookRateVersion={bookRateVersion}
      />
      <OrderForm
        key={`sell-${selected.host}-${selected.baseID}-${selected.quoteID}`}
        side="sell"
        selected={selected}
        currentMkt={currentMkt}
        bui={bui}
        qui={qui}
        walletMap={walletMap}
        baseSymbol={baseSymbol}
        quoteSymbol={quoteSymbol}
        baseFiatRate={baseFiatRate}
        quoteFiatRate={quoteFiatRate}
        bookRateAtom={bookRateAtom}
        bookRateVersion={bookRateVersion}
      />
      {/* UI-AUTH: DEX auth failed (bad password, bond wallet, etc.).
          Takes precedence over the warmup spinner and the generic
          cannot-trade cascade since it's a terminal state. */}
      {authFailedMsg && (
        <div className="cannot-trade-overlay flex-center flex-column fs16 text-danger p-3 text-center">
          <span className="ico-cross fs24 mb-2"></span>
          <div>{t('DEX_AUTH_FAILED')}</div>
          <div className="fs13 mt-2 grey">{authFailedMsg}</div>
        </div>
      )}
      {/* UI-AUTH: login-warmup window -- either the WS is still
          dialing ("Connecting…") or it's up but the authDEX
          goroutine hasn't flipped `authed` yet ("Authenticating…").
          Shows a spinner instead of the misleading "Create an
          account to trade" cascade branch. */}
      {!authFailedMsg && warmupMsg && (
        <div className="cannot-trade-overlay flex-center flex-column fs17 grey p-3 text-center">
          <div className="ico-spinner spinner fs24 mb-2"></div>
          <div>{warmupMsg}</div>
        </div>
      )}
      {/* MP-61 cannot-trade overlay. Subsumes the standalone
          `create_account_to_trade` notice that previously lived
          here as a sibling -- that case is now one branch of the
          `cantTradeReason` cascade. The condition simplifies to
          just `cantTradeReason` because the cascade returns
          `null` early when `!selected || !currentMkt`. */}
      {!authFailedMsg && !warmupMsg && cantTradeReason && (
        <div className="cannot-trade-overlay flex-center fs17 grey p-3 text-center">
          {cantTradeReason}
        </div>
      )}
    </section>
  )
}
