import { useTranslation } from 'react-i18next'
import {
  formatRateAtomToRateStep, formatRateToRateStep,
  formatBestWeCan, formatCoinAtomToLotSizeBaseCurrency,
  shortSymbol, logoPath
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
        <span className="fs14 grey px-2 border-right border-bottom">{t('Change24')}</span>
        <span className="fs14 grey px-2 border-right border-bottom">{t('Volume24')}</span>
        <span className="fs14 grey px-2 border-right border-bottom">{t('High24')}</span>
        <span className="fs14 grey ps-2 border-bottom">{t('Low24')}</span>

        <div className={`px-2 fs14 border-right${change24 >= 0 ? '' : ' text-danger'}`}>
          {spot ? `${change24 >= 0 ? '+' : ''}${change24.toFixed(1)}%` : '-'}
        </div>
        {/* MP-23: 24h volume unit switches between USD (when a fiat rate
             for the base asset is available) and the base asset's
             conventional unit. vol24 is in base atoms: USD branch divides
             by the base conversion factor and multiplies by baseFiatRate;
             base branch renders via the lot-size-aware formatter. */}
        <div className="d-flex justify-content-start align-items-center px-2 border-right">
          <div className="fs14">
            {spot && buiConv
              ? baseFiatRate > 0
                ? formatBestWeCan(vol24 / buiConv.conversionFactor * baseFiatRate)
                : formatCoinAtomToLotSizeBaseCurrency(vol24, bui, currentMkt.lotsize)
              : '-'}
          </div>
          <div className="fs14 grey ms-1">
            {spot && buiConv && baseFiatRate > 0 ? '$' : (buiConv?.unit ?? '$')}
          </div>
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
