// Bridge formatting + amount-parsing helpers (B-L16).
//
// Direct port of vanilla `client/webserver/site/src/js/bridging/utils/bridgeUtils.ts`.
// Pure functions -- they take everything they need as arguments
// rather than reaching into the `app()` singleton.

import type { SupportedAsset, UnitInfo, BridgeFeesAndLimits } from '../../stores/types'

export function bridgeDisplayName (bridgeName: string, variant: 'short' | 'long' = 'short'): string {
  const b = bridgeName.toLowerCase()
  if (b.includes('across')) return variant === 'long' ? 'Across Bridge' : 'Across'
  if (b.includes('usdc')) return variant === 'long' ? 'CCTP Bridge' : 'CCTP'
  if (b.includes('polygon')) return variant === 'long' ? 'Polygon Bridge' : 'Polygon'
  return bridgeName
}

// bridgeLogoPath maps bridge identifiers to the icon shipped in
// /img/coins/. Mirrors vanilla. Falls back to the unmodified
// {bridgeName}.png.
export function bridgeLogoPath (bridgeName: string): string {
  const b = bridgeName.toLowerCase()
  if (b.includes('polygon')) return '/img/coins/polygon.png'
  if (b.includes('usdc')) return '/img/coins/usdc.png'
  if (b.includes('across')) return '/img/coins/across.png'
  return assetLogoPath(bridgeName)
}

// assetLogoPath mirrors WalletsPage.tsx's local `logoPath` helper,
// which strips token-network suffixes (`weth.bsc` → `weth`) and
// special-cases `weth` → `eth`. Re-implemented here to keep the
// bridging module self-contained.
export function assetLogoPath (symbol: string): string {
  let s = symbol.split('.')[0]
  if (s === 'weth') s = 'eth'
  return `/img/coins/${s}.png`
}

// networkInfo resolves an asset ID to a (name, symbol) pair using
// the parent-chain identity for tokens (so e.g. usdc-erc20 →
// "Ethereum"). Mirrors vanilla.
export function networkInfo (
  assetID: number,
  assets: Record<number, SupportedAsset>
): { name: string; symbol: string } {
  const asset = assets[assetID]
  if (!asset) return { name: `Network ${assetID}`, symbol: '' }
  if (asset.token) {
    const parent = assets[asset.token.parentID]
    return { name: parent?.name || asset.name, symbol: parent?.symbol || asset.symbol }
  }
  return { name: asset.name, symbol: asset.symbol }
}

// getFeeAsset returns the asset that pays the gas/network fees for
// the given assetID -- the parent chain for tokens, the asset itself
// for base assets.
export function getFeeAsset (
  assetID: number,
  assets: Record<number, SupportedAsset>
): SupportedAsset | null {
  const asset = assets[assetID]
  if (!asset) return null
  if (asset.token) {
    return assets[asset.token.parentID] || null
  }
  return asset
}

export function formatDateTime (timestampSec: number): string {
  if (!timestampSec) return '-'
  const date = new Date(timestampSec * 1000)
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function trimStringWithEllipsis (str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  const left = Math.floor(maxLen / 2)
  const right = maxLen - left
  return `${str.substring(0, left)}...${str.substring(str.length - right)}`
}

// decimalsFromFactor converts a power-of-10 conversion factor into
// the number of decimal places. Returns null for non-power-of-10
// factors (which is unusual but handled by the parsing/formatting
// fall-back).
function decimalsFromFactor (conversionFactor: number): number | null {
  if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) return null
  const pow = Math.log10(conversionFactor)
  const digits = Math.round(pow)
  if (Math.abs(pow - digits) > 1e-12) return null
  if (Math.pow(10, digits) !== conversionFactor) return null
  return digits
}

function isSafeIntegerString (s: string): boolean {
  if (!/^\d+$/.test(s)) return false
  if (s.length <= 15) return true
  const n = Number(s)
  return Number.isSafeInteger(n) && String(Math.trunc(n)) === s.replace(/^0+/, '')
}

// atomicToConventionalString formats an atomic amount as a decimal
// string suitable for an `<input type="number">`. Avoids
// `toLocaleString` so the result round-trips through
// `parseConventionalToAtomic`.
export function atomicToConventionalString (
  vAtomic: number,
  unitInfo: UnitInfo,
  trimZeros = true
): string {
  const factor = unitInfo.conventional.conversionFactor
  const decimals = decimalsFromFactor(factor)
  if (decimals === null) {
    const v = vAtomic / factor
    return String(v)
  }

  const atoms = Math.trunc(vAtomic)
  const neg = atoms < 0
  const absAtoms = Math.abs(atoms)
  const whole = Math.floor(absAtoms / factor)
  const frac = absAtoms - whole * factor
  let fracStr = String(frac).padStart(decimals, '0')
  if (trimZeros) fracStr = fracStr.replace(/0+$/, '')

  const sign = neg ? '-' : ''
  if (!fracStr || decimals === 0) return `${sign}${whole}`
  return `${sign}${whole}.${fracStr}`
}

// calculateMaxBridgeableAmount caps the user's max-bridgeable amount
// at availableBalance minus the initiation fee when bridging a base
// asset (the fee comes out of the same balance). Token bridges pay
// gas in the parent chain, so the full token balance can be bridged.
export function calculateMaxBridgeableAmount (
  sourceAssetID: number,
  availableBalance: number,
  feesAndLimits: BridgeFeesAndLimits | null,
  assets: Record<number, SupportedAsset>
): number {
  if (!feesAndLimits) return availableBalance

  const sourceAsset = assets[sourceAssetID]
  if (!sourceAsset) return availableBalance

  const isSourceBaseAsset = !sourceAsset.token
  if (!isSourceBaseAsset) {
    return availableBalance
  }

  const baseAssetID = sourceAsset.token ? sourceAsset.token.parentID : sourceAssetID
  const initiationFee = feesAndLimits.fees[baseAssetID] || 0
  const maxBridgeable = availableBalance - initiationFee

  return Math.max(0, maxBridgeable)
}

// parseConventionalToAtomic parses a user-entered decimal string to
// atomic units. Strict regex (no scientific notation) and explicit
// safe-integer checks so we never silently round on huge inputs.
export function parseConventionalToAtomic (
  amountStr: string,
  unitInfo: UnitInfo
): { atomic: number | null; error: string | null } {
  const s = amountStr.trim()
  if (!s) return { atomic: null, error: null }

  // Allow "1", "1.", ".1", "0.1". Disallow scientific notation.
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { atomic: null, error: 'Invalid amount' }

  const factor = unitInfo.conventional.conversionFactor
  const decimals = decimalsFromFactor(factor)
  if (decimals === null) {
    const n = Number(s)
    if (!Number.isFinite(n)) return { atomic: null, error: 'Invalid amount' }
    return { atomic: Math.round(n * factor), error: null }
  }

  const [wholeRaw, fracRaw = ''] = s.split('.')
  const wholeStr = wholeRaw === '' ? '0' : wholeRaw
  if (!isSafeIntegerString(wholeStr)) return { atomic: null, error: 'Amount too large' }
  const whole = Number(wholeStr)
  if (!Number.isSafeInteger(whole)) return { atomic: null, error: 'Amount too large' }
  if (whole > Math.floor(Number.MAX_SAFE_INTEGER / factor)) return { atomic: null, error: 'Amount too large' }

  // +1 char in the slice to capture the rounding digit.
  const fracPadded = (fracRaw + '0'.repeat(decimals + 1)).slice(0, decimals + 1)
  const fracMainStr = decimals > 0 ? fracPadded.slice(0, decimals) : ''
  const roundDigit = decimals > 0 ? fracPadded[decimals] : (fracRaw[0] || '0')
  const fracMain = fracMainStr ? Number(fracMainStr) : 0
  if (!Number.isSafeInteger(fracMain)) return { atomic: null, error: 'Invalid amount' }

  let atoms = whole * factor + fracMain
  if (roundDigit >= '5') atoms += 1
  if (!Number.isSafeInteger(atoms)) return { atomic: null, error: 'Amount too large' }
  return { atomic: atoms, error: null }
}
