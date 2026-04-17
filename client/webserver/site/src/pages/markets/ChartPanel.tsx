import { useTranslation } from 'react-i18next'
import { CandleChart, CandleReporters } from '../../components/charts/CandleChart'
import { Wave } from '../../components/charts/Wave'
import {
  formatCoinAtomToLotSizeBaseCurrency, formatRateAtomToRateStep
} from '../../hooks/useFormatters'
import type { CandlesPayload, Candle } from '../../stores/types'
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
              (matches vanilla Doc.hide(page.candleDurBttnBox)). */}
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
            <Wave message={t('waiting for candlesticks')} backgroundColor={true} />
          )}
          {/* MP-21: Canvas is made `visibility: hidden` (not just
              opacity 0) while loading so it doesn't intercept mouse
              events or the legend readout. Matches vanilla's
              `.invisible` class usage. */}
          <div
            style={{
              width: '100%',
              height: '100%',
              visibility: candleLoading || chartErrMsg ? 'hidden' : 'visible'
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
        {!chartErrMsg && mouseCandle && (
          <div className="grey p-1 border-bottom border-start" style={{ position: 'absolute', top: 0, right: 0 }}>
            <div className="d-flex align-items-center">
              <span className="ico-target fs11 me-1"></span>
              <span>
                S: {formatRateAtomToRateStep(mouseCandle.startRate, bui, qui, currentMkt.ratestep)},
                E: {formatRateAtomToRateStep(mouseCandle.endRate, bui, qui, currentMkt.ratestep)},
                L: {formatRateAtomToRateStep(mouseCandle.lowRate, bui, qui, currentMkt.ratestep)},
                H: {formatRateAtomToRateStep(mouseCandle.highRate, bui, qui, currentMkt.ratestep)},
                V: {formatCoinAtomToLotSizeBaseCurrency(mouseCandle.matchVolume, bui, currentMkt.lotsize)}
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
