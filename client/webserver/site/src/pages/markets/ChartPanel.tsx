import { useTranslation } from 'react-i18next'
import { CandleChart, CandleReporters } from '../../components/charts/CandleChart'
import { Wave } from '../../components/charts/Wave'
import {
  formatCoinAtomToLotSizeBaseCurrency, formatRateAtomToRateStep
} from '../../hooks/useFormatters'
import type { CandlesPayload, Candle, Market, UnitInfo } from '../../stores/types'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// ChartPanel -- candle chart section with duration buttons, loading overlay,
// error message, and mouse-candle readout. Reads currentMkt / bui / qui from
// MarketPageContext.
// ---------------------------------------------------------------------------

export interface ChartPanelProps {
  candleData: CandlesPayload | null
  candleDurs: string[]
  candleDur: string
  setCandleDur: (dur: string) => void
  candleLoading: boolean
  chartErrMsg: string
  mouseCandle: Candle | null
  currentMktId: string
  candleReporters: CandleReporters
}

export function ChartPanel ({
  candleData,
  candleDurs,
  candleDur,
  setCandleDur,
  candleLoading,
  chartErrMsg,
  mouseCandle,
  currentMktId,
  candleReporters
}: ChartPanelProps) {
  const { t } = useTranslation()
  const { currentMkt, bui, qui } = useMarketPageContext()

  return (
    <section className="d-flex flex-stretch-column">
      <div className="flex-grow-1 flex-stretch-column position-relative">
        <div className="market-chart">
          {/* MP-18: Disconnection / disabled overlay. Shown when the
              exchange is disabled or the connection is down. Vanilla
              maps this to the #chartErrMsg element and uses
              CONNECTION_FAILED / DEX_DISABLED_MSG i18n keys. */}
          {chartErrMsg && (
            <div id="chartErrMsg" className="flex-center text-center fs18 p-3">
              {chartErrMsg}
            </div>
          )}
          {/* MP-21: Hide the duration buttons while candles are loading
              (matches vanilla Doc.hide(page.candleDurBttnBox)).
              Note: the chart is NOT gated on the DEX auth state -- like
              the order book, candles are public data that arrive as
              soon as the market is subscribed, regardless of whether
              the DEX auth round-trip has completed. */}
          {!candleLoading && !chartErrMsg && (
            <div id="candleDurBttnBox">
              {candleDurs.map(dur => (
                <button
                  key={dur}
                  className={`candle-dur-bttn${candleDur === dur ? ' selected' : ''}`}
                  onClick={() => setCandleDur(dur)}
                >
                  {dur}
                </button>
              ))}
            </div>
          )}
          {candleLoading && !chartErrMsg && (
            <Wave
              message={t('WAITING_FOR_CANDLESTICKS')}
              backgroundColor={true}
            />
          )}
          {/* MP-21: Canvas is made `visibility: hidden` (not just
              opacity 0) while loading so it doesn't intercept mouse
              events or the legend readout. Matches vanilla's
              `.invisible` class usage. */}
          <div
            style={{
              width: '100%',
              height: '100%',
              visibility: (candleLoading || chartErrMsg) ? 'hidden' : 'visible'
            }}
          >
            <CandleChart
              data={candleData}
              market={currentMkt}
              baseUnitInfo={bui}
              quoteUnitInfo={qui}
              mktId={currentMktId}
              reporters={candleReporters}
            />
          </div>
        </div>
        {!chartErrMsg && currentMkt && bui && qui && (candleData?.candles?.length ?? 0) > 0 && (
          <OhlcvReadout
            candle={mouseCandle ?? candleData!.candles[candleData!.candles.length - 1]}
            market={currentMkt}
            bui={bui}
            qui={qui}
          />
        )}
      </div>
    </section>
  )
}

// Binance-style top-left OHLCV readout. Renders the hovered candle, or
// falls back to the latest candle when the user isn't hovering (or while
// dragging). Value cells are colored per candle direction.
interface OhlcvReadoutProps {
  candle: Candle
  market: Market
  bui: UnitInfo
  qui: UnitInfo
}

function OhlcvReadout ({ candle, market, bui, qui }: OhlcvReadoutProps) {
  const up = candle.endRate >= candle.startRate
  const cls = up ? 'up' : 'down'
  const changeAbs = candle.endRate - candle.startRate
  const changePct = candle.startRate > 0 ? (changeAbs / candle.startRate) * 100 : 0
  const sign = changeAbs >= 0 ? '+' : '\u2212'
  const absStr = formatRateAtomToRateStep(Math.abs(changeAbs), bui, qui, market.ratestep)
  const pctStr = `${sign}${Math.abs(changePct).toFixed(2)}%`
  return (
    <div className="candle-ohlcv">
      <span className="label">O</span>
      <span className={cls}>{formatRateAtomToRateStep(candle.startRate, bui, qui, market.ratestep)}</span>
      <span className="label">H</span>
      <span className={cls}>{formatRateAtomToRateStep(candle.highRate, bui, qui, market.ratestep)}</span>
      <span className="label">L</span>
      <span className={cls}>{formatRateAtomToRateStep(candle.lowRate, bui, qui, market.ratestep)}</span>
      <span className="label">C</span>
      <span className={cls}>{formatRateAtomToRateStep(candle.endRate, bui, qui, market.ratestep)}</span>
      <span className={cls}>{sign}{absStr}</span>
      <span className={cls}>({pctStr})</span>
      <span className="label">Vol</span>
      <span className="label strong">{formatCoinAtomToLotSizeBaseCurrency(candle.matchVolume, bui, market.lotsize)}</span>
    </div>
  )
}
