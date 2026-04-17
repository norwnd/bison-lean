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

function convertToConventional (v: number, unitInfo?: UnitInfo): [number, number] {
  let prec = 8
  if (unitInfo) {
    const f = unitInfo.conventional.conversionFactor
    v /= f
    prec = Math.round(Math.log10(f))
  }
  return [v, prec]
}

function formatSigFigsWithFormatters (
  intFmt: Intl.NumberFormat, sigFigFmt: Intl.NumberFormat,
  n: number, maxDecimals?: number, locales?: string | string[]
): string {
  if (n >= 1000) return intFmt.format(n)
  const s = sigFigFmt.format(n)
  if (typeof maxDecimals !== 'number') return s
  const fractional = sigFigFmt.formatToParts(n).filter((p: Intl.NumberFormatPart) => p.type === 'fraction')[0]?.value ?? ''
  if (fractional.length <= maxDecimals) return s
  return fullPrecisionFormatter(maxDecimals, locales).format(n)
}

// Exported pure functions — no hooks, just formatting utilities.

export function formatCoinValue (vAtomic: number, unitInfo?: UnitInfo): string {
  const [v, prec] = convertToConventional(vAtomic, unitInfo)
  if (Number.isInteger(v)) return intFormatter.format(v)
  return decimalFormatter(prec).format(v)
}

export function formatFourSigFigs (n: number, maxDecimals?: number): string {
  return formatSigFigsWithFormatters(intFormatter, fourSigFigs, n, maxDecimals)
}

export function formatBestWeCan (n: number, maxDecimals?: number): string {
  if (n >= 1000) return intFormatter.format(n)
  if (!maxDecimals) return fourSigFigs.format(n)
  return fullPrecisionFormatter(maxDecimals).format(n)
}

export function adjRateAtomsBuy (rateAtom: number, rateStepAtom: number): number {
  return rateAtom - (rateAtom % rateStepAtom)
}

export function adjRateAtomsSell (rateAtom: number, rateStepAtom: number): number {
  const adjusted = rateAtom - (rateAtom % rateStepAtom)
  if (rateAtom === adjusted) return rateAtom
  return adjusted + rateStepAtom
}

export function formatRateAtomToRateStep (rateAtom: number, bui: UnitInfo, qui: UnitInfo, rateStepAtom: number, sell?: boolean): string {
  const rateAtomAdj = sell ? adjRateAtomsSell(rateAtom, rateStepAtom) : adjRateAtomsBuy(rateAtom, rateStepAtom)
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
  const [coin] = convertToConventional(coinAtom, bui)
  const [lotSize] = convertToConventional(lotSizeAtom, bui)
  const lotSizeDigits = -(Math.floor(Math.log10(lotSize)))
  if (lotSizeDigits <= 0) return intFormatter.format(coin)
  return fullPrecisionFormatterWithPreservingZeroes(lotSizeDigits).format(coin)
}

export function formatCoinAtomToLotSizeQuoteCurrency (coinAtom: number, bui: UnitInfo, qui: UnitInfo, lotSizeAtom: number, rateStepAtom: number): string {
  const [coin] = convertToConventional(coinAtom, qui)
  const [lotSize] = convertToConventional(lotSizeAtom, bui)
  const lotSizeDigits = -(Math.floor(Math.log10(lotSize)))
  const rateStepDigits = log10RateEncodingFactor - Math.floor(Math.log10(rateStepAtom)) -
    Math.floor(Math.log10(bui.conventional.conversionFactor) - Math.log10(qui.conventional.conversionFactor))
  if (lotSizeDigits + rateStepDigits <= 0) return intFormatter.format(coin)
  return fullPrecisionFormatterWithPreservingZeroes(lotSizeDigits + rateStepDigits).format(coin)
}

export function formatFiatConversion (vAtomic: number, rate: number, unitInfo?: UnitInfo): string {
  if (!rate || rate === 0) return '—'
  const [v] = convertToConventional(vAtomic, unitInfo)
  return fullPrecisionFormatter(2).format(v * rate)
}

export function formatFiatValue (value: number): string {
  return fullPrecisionFormatterWithPreservingZeroes(2).format(value)
}

// T18#5: formatProfit returns a USD profit string (always 2 decimals)
// together with the sell/buy color class to style it. Consolidated
// here from MMPage.tsx and MMArchivesPage.tsx, which had identical
// implementations modulo the result-field name (`cls` vs.
// `colorClass`). Call sites now unpack as `{ text, cls }`.
export function formatProfit (profit: number): { text: string; cls: string } {
  const s = profit.toFixed(2)
  if (s === '-0.00' || s === '0.00') return { text: '$0.00', cls: '' }
  if (profit < 0) return { text: `-$${s.substring(1)}`, cls: 'sellcolor' }
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
