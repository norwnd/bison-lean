import type { SupportedAsset } from '../../stores/types'
import { shortSymbol, logoPath } from '../../hooks/useFormatters'

interface Props {
  asset: SupportedAsset
  // When true, the parent-chain indicator (for tokens) renders as a
  // small inline logo. When false (default), it renders as a <sup>
  // with the uppercase parent symbol. Matches vanilla's `useLogo`
  // argument to `Doc.symbolize(asset, useLogo)`.
  useLogo?: boolean
}

// AssetSymbol renders a token-aware ticker display. For non-token
// assets (DCR, BTC, etc.), it's just the uppercase ticker. For tokens
// (usdc.polygon, weth.base, etc.), it's the token's ticker followed
// by a small parent-chain indicator — either a logo (when `useLogo`
// is true) or a superscript with the parent's symbol.
//
// Port of vanilla `Doc.symbolize(asset, useLogo)` from `doc.ts`
// (L677-703). The `.token-parent` img/sup CSS classes already exist
// in `css/utilities.scss` (L178-189) and carry the offset styling
// that pulls the parent indicator into the baseline-adjacent visual
// slot. Used in contexts where a styled two-part display is wanted
// — wallets page token allowance forms, markets page base/quote
// pairs, etc.
export function AssetSymbol ({ asset, useLogo = false }: Props) {
  const ticker = shortSymbol(asset.unitInfo?.conventional?.unit || asset.symbol)
  const parts = asset.symbol.split('.')
  const isToken = parts.length === 2

  if (!isToken) return <span>{ticker}</span>

  const parentSymbol = parts[1]
  return (
    <span>
      <span>{ticker}</span>
      {useLogo
        ? <img src={logoPath(parentSymbol)} className="token-parent" alt="" />
        : <sup className="token-parent">{parentSymbol.toUpperCase()}</sup>}
    </span>
  )
}
