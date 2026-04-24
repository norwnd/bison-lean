import { useTranslation } from 'react-i18next'
import { CandleChart, CandleReporters } from '../../components/charts/CandleChart'
import { Wave } from '../../components/charts/Wave'
import {
  formatCoinAtomToLotSizeBaseCurrency,
  formatRateAtomToRateStep, shortSymbol
} from '../../hooks/useFormatters'
import type { CandlesPayload, Candle, Market, UnitInfo } from '../../stores/types'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// ChartPanel -- candle chart section with duration buttons, loading overlay,
// error message, and mouse-candle readout. Reads currentMkt / bui / qui from
// MarketPageContext.
// ---------------------------------------------------------------------------

// Fixed slot order for the 2x2 duration-buttons grid. Row-major: first two
// entries fill the top row, last two the bottom. A slot whose dur isn't in
// the server-reported `candleDurs` renders as a disabled button.
const CANDLE_DUR_SLOTS = ['24h', '8h', '1h', '5m']

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

  // Readout candle -- hovered candle, or latest when the user isn't
  // hovering. Null when there's nothing to show (error, no market, no data).
  const candles = candleData?.candles
  const readoutCandle: Candle | null = !chartErrMsg && currentMkt && bui && qui && candles && candles.length > 0
    ? (mouseCandle ?? candles[candles.length - 1])
    : null

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
              {/* Fixed 2x2 slots (row-major: 24h/8h over 1h/5m) so the
                  layout reads the same regardless of which bin sizes the
                  connected server publishes. Any slot whose dur isn't in
                  the server-reported candleDurs is rendered disabled --
                  e.g. 8h is a forward-compat placeholder until the server
                  extends its BinSizes. */}
              {CANDLE_DUR_SLOTS.map(dur => {
                const enabled = candleDurs.includes(dur)
                const selected = enabled && candleDur === dur
                return (
                  <button
                    key={dur}
                    className={`candle-dur-bttn${selected ? ' selected' : ''}`}
                    onClick={() => setCandleDur(dur)}
                    disabled={!enabled}
                  >
                    {dur}
                  </button>
                )
              })}
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
        {readoutCandle && currentMkt && bui && qui && (
          <>
            <OhlcvReadout candle={readoutCandle} market={currentMkt} bui={bui} qui={qui} />
            <VolumeReadout candle={readoutCandle} market={currentMkt} bui={bui} />
          </>
        )}
      </div>
    </section>
  )
}

// Top-left readout with High / Low / Range for the hovered candle (or the
// latest candle when the user isn't hovering). Values inherit the candle's
// up/down color.
interface OhlcvReadoutProps {
  candle: Candle
  market: Market
  bui: UnitInfo
  qui: UnitInfo
}

function OhlcvReadout ({ candle, market, bui, qui }: OhlcvReadoutProps) {
  const up = candle.endRate >= candle.startRate
  const cls = up ? 'up' : 'down'
  const rangePct = candle.lowRate > 0 ? ((candle.highRate - candle.lowRate) / candle.lowRate) * 100 : 0
  return (
    <div className="candle-ohlcv">
      <span className={cls}>High: {formatRateAtomToRateStep(candle.highRate, bui, qui, market.ratestep)}</span>
      <span className={cls}>Low: {formatRateAtomToRateStep(candle.lowRate, bui, qui, market.ratestep)}</span>
      <span className={cls}>Range: {rangePct.toFixed(2)}%</span>
    </div>
  )
}

// Volume readout rendered over the chart's lower volume section. Neutral
// color (no candle direction tint). Shows the base amount + asset symbol.
interface VolumeReadoutProps {
  candle: Candle
  market: Market
  bui: UnitInfo
}

function VolumeReadout ({ candle, market, bui }: VolumeReadoutProps) {
  const volStr = formatCoinAtomToLotSizeBaseCurrency(candle.matchVolume, bui, market.lotsize)
  const asset = shortSymbol(market.basesymbol)
  return (
    <div className="candle-volume-readout">
      <span>Volume: {volStr} {asset}</span>
    </div>
  )
}
