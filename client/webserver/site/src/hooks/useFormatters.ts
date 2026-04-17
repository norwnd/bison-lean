import type { UnitInfo } from '../stores/types'

// Constants.
export const RateEncodingFactor = 1e8
const log10RateEncodingFactor = Math.round(Math.log10(RateEncodingFactor))
const languages = navigator.languages.filter((locale: string) => locale !== 'c')

// Formatter caches.
const intFormatter = new Intl.NumberFormat(languages, { maximumFractionDigits: 0, useGrouping: false })
const fourSigFigs = new Intl.NumberFormat(languages, { maximumSignificantDigits: 4, useGrouping: false })
const decimalFormatters: Record<string, Intl.NumberFormat> = {}
const fullPrecisionFormatters: Record<string, Intl.NumberFormat> = {}

function formatter (formatters: Record<string, Intl.NumberFormat>, min: number, max: number, locales?: string | string[]): Intl.NumberFormat {
  const k = `${min}-${max}`
  let fmt = formatters[k]
  if (!fmt) {
    fmt = new Intl.NumberFormat(locales ?? languages, {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      useGrouping: false
    })
    formatters[k] = fmt
  }
  return fmt
}

function decimalFormatter (prec: number) {
  return formatter(decimalFormatters, 2, prec)
}

function fullPrecisionFormatter (prec: number, locales?: string | string[]) {
  return formatter(fullPrecisionFormatters, 0, prec, locales)
}

function fullPrecisionFormatterWithPreservingZeroes (prec: number, locales?: string | string[]) {
  return formatter(fullPrecisionFormatters, prec, prec, locales)
}

export function atomToConventional (v: number, unitInfo?: UnitInfo): number {
  if (!unitInfo) return v
  return v / unitInfo.conventional.conversionFactor
}

// Exported pure functions — no hooks, just formatting utilities.

export function formatCoinAtom (vAtom: number, unitInfo?: UnitInfo): string {
  const v = atomToConventional(vAtom, unitInfo)
  if (Number.isInteger(v)) return intFormatter.format(v)
  const prec = unitInfo ? Math.round(Math.log10(unitInfo.conventional.conversionFactor)) : 8
  return decimalFormatter(prec).format(v)
}

export function formatFiat (value: number): string {
  return fullPrecisionFormatterWithPreservingZeroes(2).format(value)
}

export function formatBestWeCan (n: number, maxDecimals?: number): string {
  if (n >= 1000) return intFormatter.format(n)
  if (!maxDecimals) return fourSigFigs.format(n)
  return fullPrecisionFormatter(maxDecimals).format(n)
}

export function adjRateAtomBuy (rateAtom: number, rateStepAtom: number): number {
  return rateAtom - (rateAtom % rateStepAtom)
}

export function adjRateAtomSell (rateAtom: number, rateStepAtom: number): number {
  const adjusted = rateAtom - (rateAtom % rateStepAtom)
  if (rateAtom === adjusted) return rateAtom
  return adjusted + rateStepAtom
}

export function formatRateAtomToRateStep (rateAtom: number, bui: UnitInfo, qui: UnitInfo, rateStepAtom: number, sell?: boolean): string {
  const rateAtomAdj = sell ? adjRateAtomSell(rateAtom, rateStepAtom) : adjRateAtomBuy(rateAtom, rateStepAtom)
  const r = bui.conventional.conversionFactor / qui.conventional.conversionFactor
  const rateConv = rateAtomAdj * (r / RateEncodingFactor)
  return formatRateToRateStep(rateConv, bui, qui, rateStepAtom)
}

export function formatRateToRateStep (rateConv: number, bui: UnitInfo, qui: UnitInfo, rateStepAtom: number): string {
  const rateStepDigits = log10RateEncodingFactor - Math.floor(Math.log10(rateStepAtom)) -
    Math.floor(Math.log10(bui.conventional.conversionFactor) - Math.log10(qui.conventional.conversionFactor))
  if (rateStepDigits <= 0) return intFormatter.format(rateConv)
  return fullPrecisionFormatterWithPreservingZeroes(rateStepDigits).format(rateConv)
}

export function formatCoinAtomToLotSizeBaseCurrency (coinAtom: number, bui: UnitInfo, lotSizeAtom: number): string {
  const coin = atomToConventional(coinAtom, bui)
  const lotSize = atomToConventional(lotSizeAtom, bui)
  const lotSizeDigits = -(Math.floor(Math.log10(lotSize)))
  if (lotSizeDigits <= 0) return intFormatter.format(coin)
  return fullPrecisionFormatterWithPreservingZeroes(lotSizeDigits).format(coin)
}

export function formatCoinAtomToLotSizeQuoteCurrency (coinAtom: number, bui: UnitInfo, qui: UnitInfo, lotSizeAtom: number, rateStepAtom: number): string {
  const coin = atomToConventional(coinAtom, qui)
  const lotSize = atomToConventional(lotSizeAtom, bui)
  const lotSizeDigits = -(Math.floor(Math.log10(lotSize)))
  const rateStepDigits = log10RateEncodingFactor - Math.floor(Math.log10(rateStepAtom)) -
    Math.floor(Math.log10(bui.conventional.conversionFactor) - Math.log10(qui.conventional.conversionFactor))
  if (lotSizeDigits + rateStepDigits <= 0) return intFormatter.format(coin)
  return fullPrecisionFormatterWithPreservingZeroes(lotSizeDigits + rateStepDigits).format(coin)
}

// T18#5: formatProfit returns a USD profit string (always 2 decimals)
// together with the sell/buy color class to style it. Consolidated
// here from MMPage.tsx and MMArchivesPage.tsx, which had identical
// implementations modulo the result-field name (`cls` vs.
// `colorClass`). Call sites now unpack as `{ text, cls }`.
export function formatProfit (profit: number): { text: string; cls: string } {
  const s = formatFiat(Math.abs(profit))
  if (s === '0.00') return { text: '$0.00', cls: '' }
  if (profit < 0) return { text: `-$${s}`, cls: 'sellcolor' }
  return { text: `$${s}`, cls: 'buycolor' }
}

export function conventionalRate (baseID: number, quoteID: number, encRate: number, assets: Record<number, { unitInfo: UnitInfo }>): number {
  const bui = assets[baseID]?.unitInfo
  const qui = assets[quoteID]?.unitInfo
  if (!bui || !qui) return 0
  const r = bui.conventional.conversionFactor / qui.conventional.conversionFactor
  return encRate * r / RateEncodingFactor
}

// shortSymbol returns the ticker string to show in the UI for an asset symbol.
// Strips any parent-chain suffix (`usdc.polygon` → `USDC`) and renames the
// native Polygon asset from `POLYGON` to `POL` for display (internal symbol
// stays `polygon`; external exchanges like Binance already use `POL`).
export function shortSymbol (symbol: string): string {
  const s = symbol.split('.')[0].toUpperCase()
  if (s === 'POLYGON') return 'POL'
  return s
}

// logoPath returns the `/img/coins/` asset-icon URL for a given symbol.
// Strips any token-network suffix (`usdc.polygon` → `usdc`) and special-cases
// the `weth` → `eth` alias (all ETH tokens share the ETH logo).
export function logoPath (symbol: string): string {
  let s = symbol.split('.')[0].toLowerCase()
  if (s === 'weth') s = 'eth'
  return `/img/coins/${s}.png`
}
