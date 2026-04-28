// useWalletMsg hosts the shared wallet-readiness message helper used by the
// markets UI (OrderForm / MarketsPage / RightPanel) to render the inline
// "why can't the user trade right now" cascade, plus a single-wallet
// connecting-state predicate used by WalletsPage.
//
// The name follows the `useFormatters.ts` convention of hosting pure helpers
// under `hooks/` even when they're not literal React hooks - it keeps the
// import path consistent (`hooks/<domain>`) and groups shared display logic.

import { WalletState } from '../stores/types'
import { shortSymbol } from './useFormatters'

type TFn = (key: string, opts?: Record<string, string>) => string

/**
 * tradePairWalletMsg returns the i18n'd wallet-readiness cascade message for
 * a trade pair. Priority order:
 *
 *   1. both wallets missing   → NO_WALLET_MSG
 *   2. one wallet missing     → CREATE_ASSET_WALLET_MSG
 *   3. a wallet is disabled   → ENABLE_ASSET_WALLET_MSG (user-blocking)
 *   4. a wallet is connecting → CONNECTING_WALLET       (transient)
 *   5. trade-safety blocked   → TRADE_DISABLED_PROVIDERS (RPC redundancy too low)
 *   6. otherwise              → '' (empty string)
 *
 * "Disabled" means the user has explicitly turned the wallet off and must
 * take action. "Connecting" (`!running && !disabled`) is the transient boot
 * window - Core's `Running` bool flips true the moment the per-wallet
 * `Connect` returns. Surfacing a user-facing "enable…" cascade during that
 * window (which is what the old code did via `disabled || !running`) was
 * misleading; the wallet is already enabled and just hasn't finished
 * dialing yet.
 *
 * "Trade-safety blocked" applies to RPC-multiplexed wallets (eth/polygon)
 * when fewer than min(2, total) providers are healthy. Set by Core via
 * the ProviderHealthNote → handleProviderHealth flow; the wallet's
 * Trade()/MultiTrade() endpoints also enforce this, so the UI gate is
 * a UX hint, not a hard guarantee.
 *
 * Disabled-on-either-side wins over connecting-on-either-side so that an
 * explicitly-disabled wallet always surfaces its actionable message, even
 * if the counterpart is still booting.
 *
 * Symbols are routed through `shortSymbol()` so token suffixes
 * (`usdc.polygon` → `USDC`) and the POLYGON→POL display rename are applied
 * consistently across the three call sites. Callers pass the raw asset
 * symbols.
 */
export function tradePairWalletMsg (
  t: TFn,
  baseWallet: WalletState | undefined,
  quoteWallet: WalletState | undefined,
  baseSymbol: string,
  quoteSymbol: string
): string {
  const bs = shortSymbol(baseSymbol)
  const qs = shortSymbol(quoteSymbol)
  if (!baseWallet && !quoteWallet) return t('NO_WALLET_MSG', { asset1: bs, asset2: qs })
  if (!baseWallet) return t('CREATE_ASSET_WALLET_MSG', { asset: bs })
  if (!quoteWallet) return t('CREATE_ASSET_WALLET_MSG', { asset: qs })
  if (baseWallet.disabled) return t('ENABLE_ASSET_WALLET_MSG', { asset: bs })
  if (quoteWallet.disabled) return t('ENABLE_ASSET_WALLET_MSG', { asset: qs })
  if (!baseWallet.running) return t('CONNECTING_WALLET', { asset: bs })
  if (!quoteWallet.running) return t('CONNECTING_WALLET', { asset: qs })
  // RPC-multiplexed wallets (eth/polygon) report tradeSafe=false when
  // their provider redundancy threshold isn't met. Surface that here so
  // the buy/sell button is grayed out with a tooltip explaining why.
  // Non-RPC-multiplexed wallets always have tradeSafe=true, so this is
  // a no-op for them.
  if (baseWallet.tradeSafe === false) return t('TRADE_DISABLED_PROVIDERS', { asset: bs })
  if (quoteWallet.tradeSafe === false) return t('TRADE_DISABLED_PROVIDERS', { asset: qs })
  return ''
}

/**
 * walletConnecting is true when a wallet exists, isn't user-disabled, but
 * hasn't finished connecting yet (`running === false`). The transient boot
 * window: `Running` flips to true the instant the wallet's `Connect` returns
 * successfully inside Core, so this is the cleanest signal a consumer can
 * gate a "connecting…" indicator on.
 *
 * Returns false for `undefined` wallets (a not-yet-created wallet isn't
 * connecting - it's missing; callers should branch on that separately).
 */
export function walletConnecting (wallet: WalletState | undefined): boolean {
  if (!wallet) return false
  return !wallet.disabled && !wallet.running
}
