import { useTranslation } from 'react-i18next'
import {
  formatRateAtomToRateStep, formatRateToRateStep,
  formatFiat, shortSymbol, logoPath
} from '../../hooks/useFormatters'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// MarketStatsHeader -- the market stats strip rendered into the page header
// via createPortal. Reads currentMkt / bui / qui from MarketPageContext.
// ---------------------------------------------------------------------------

export interface MarketStatsHeaderProps {
  baseSymbol: string
  quoteSymbol: string
  externalPriceConv: number
  spotRate: number
  hasBisonPrice: boolean
  mostRecentMatchIsBuy: boolean | null
  change24: number
  vol24: number
  high24: number
  low24: number
  baseFiatRate: number
  spot: { rate?: number; change24?: number; vol24?: number; high24?: number; low24?: number } | undefined
  buiConv: { conversionFactor: number; unit: string } | undefined
  onToggleMarketList: () => void
}

export function MarketStatsHeader ({
  baseSymbol,
  quoteSymbol,
  externalPriceConv,
  spotRate,
  hasBisonPrice,
  mostRecentMatchIsBuy,
  change24,
  vol24,
  high24,
  low24,
  baseFiatRate,
  spot,
  buiConv,
  onToggleMarketList
}: MarketStatsHeaderProps) {
  const { t } = useTranslation()
  const { currentMkt, bui, qui } = useMarketPageContext()

  return (
    <div id="marketStats" className="d-flex align-items-center px-2">
      <div
        className="flex-center pointer hoverbg px-2"
        onClick={onToggleMarketList}
      >
        <div className="flex-center">
          <img className="small-icon" src={logoPath(baseSymbol)} alt="" />
          <img className="small-icon ms-1" src={logoPath(quoteSymbol)} alt="" />
        </div>
        <div className="d-flex align-items-end fs24 demi ms-1">
          <span>{shortSymbol(baseSymbol)}</span> / <span>{shortSymbol(quoteSymbol)}</span>
        </div>
      </div>

      <div className="d-flex flex-stretch-column ps-1 border-right">
        {/* MP-25: External price shown as the fiat ratio (quote-per-base),
             rendered only when both fiat rates are available. Matches
             vanilla `setCurrMarketPrice` which hides the pill when the
             ratio is unknown. */}
        {externalPriceConv > 0 && (
          <div title="Price on external markets such as Binance" className="d-flex align-items-center border-bottom pe-2 fs18 text-warning">
            {formatRateToRateStep(externalPriceConv, bui, qui, currentMkt.ratestep)}
          </div>
        )}
        {/* MP-24: Bison price matches vanilla `setCurrMarketPrice`:
              - source: `spot.rate` (last-trade price), NOT midGap -- shows
                `-` when no spot or no recent matches;
              - color: derived from the most recent match side;
              - rounding direction passed to the formatter also tracks
                that side;
              - no unit suffix -- vanilla renders only the raw number. */}
        <div
          title="Price last trade executed at"
          className={`d-flex align-items-center pe-2 fs18${hasBisonPrice && mostRecentMatchIsBuy ? ' buycolor' : hasBisonPrice && mostRecentMatchIsBuy === false ? ' sellcolor' : ''}`}
        >
          {hasBisonPrice
            ? formatRateAtomToRateStep(spotRate, bui, qui, currentMkt.ratestep, !mostRecentMatchIsBuy)
            : '-'}
        </div>
      </div>

      <div className="statgrid">
        <span className="fs14 grey px-2 border-right border-bottom">{t('CHANGE24')}</span>
        <span className="fs14 grey px-2 border-right border-bottom">{t('VOLUME24')}</span>
        <span className="fs14 grey px-2 border-right border-bottom">{t('HIGH24')}</span>
        <span className="fs14 grey ps-2 border-bottom">{t('LOW24')}</span>

        <div
          className="px-2 fs14 border-right"
          style={spot ? { color: change24 >= 0 ? 'var(--buy-color)' : 'var(--sell-color)' } : undefined}
        >
          {spot ? `${change24 >= 0 ? '+' : ''}${(change24 * 100).toFixed(1)}%` : '-'}
        </div>
        {/* 24h volume shown as the USD equivalent only -- the chart's
             readout keeps the base-amount breakdown; the header stays
             compact. Falls back to '-' when no fiat rate is available,
             matching the other header cells. vol24 is in base atoms. */}
        <div className="d-flex justify-content-start align-items-center px-2 border-right fs14">
          {spot && buiConv && baseFiatRate > 0
            ? <>${formatFiat(vol24 / buiConv.conversionFactor * baseFiatRate)}</>
            : '-'}
        </div>
        <div className="px-2 fs14 border-right">
          {high24 > 0
            ? formatRateAtomToRateStep(high24, bui, qui, currentMkt.ratestep)
            : '-'}
        </div>
        <div className="px-2 fs14">
          {low24 > 0
            ? formatRateAtomToRateStep(low24, bui, qui, currentMkt.ratestep)
            : '-'}
        </div>
      </div>
    </div>
  )
}
