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
  onOrderSubmitted: () => void
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
  onOrderSubmitted
}: TradeFormsProps) {
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
        onOrderSubmitted={onOrderSubmitted}
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
        onOrderSubmitted={onOrderSubmitted}
      />
      {/* MP-61 cannot-trade overlay. Subsumes the standalone
          `create_account_to_trade` notice that previously lived
          here as a sibling -- that case is now one branch of the
          `cantTradeReason` cascade. The condition simplifies to
          just `cantTradeReason` because the cascade returns
          `null` early when `!selected || !currentMkt`. */}
      {cantTradeReason && (
        <div className="cannot-trade-overlay flex-center fs17 grey p-3 text-center">
          {cantTradeReason}
        </div>
      )}
    </section>
  )
}
