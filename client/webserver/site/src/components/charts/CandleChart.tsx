import { useRef, useEffect, useCallback } from 'react'
import { useUIStore } from '../../stores/useUIStore'
import { Candle, CandlesPayload, Market, UnitInfo } from '../../stores/types'
import { formatRateAtomToRateStep, formatCoinAtomToLotSizeBaseCurrency } from '../../hooks/useFormatters'
import { fetchLocal, storeLocal, lastCandleZoomLevelLK } from '../../services/state'
import {
  Extents, Region, Theme, darkTheme, lightTheme,
  line as drawLine, dashedLine, pillLabel, clamp,
  LabelSet, makeYLabels, makeCandleTimeLabels, truncate, Point
} from './chartUtils'

// Default zoom (candle count) used on first load before any saved
// preference exists. Persisted across sessions via `lastCandleZoomLevelLK`.
const DEFAULT_ZOOM_CANDLES = 90

// Floor for zoom so the chart stays legible when users wheel in hard.
const MIN_ZOOM_CANDLES = 10

// Wheel-zoom multiplier per tick. ~0.041% per event -- keeps trackpad
// momentum-scrolls from snapping the viewport in huge jumps.
const ZOOM_WHEEL_FACTOR = 1.00041

// Pixels the mouse must move before a mousedown becomes a drag (prevents
// jitter on a quick click from triggering a pan).
const DRAG_THRESHOLD_PX = 3

// Ask the parent for more history once the visible window is within this
// many candles of the oldest loaded candle. Must stay strictly less than
// HISTORY_BATCH_SIZE so a normal-size response actually pushes the oldest
// candle past the threshold and re-arms a later trigger. A full batch of
// headroom is the goal so panning continues without visible staleness.
const HISTORY_PREFETCH_THRESHOLD = 500

// Number of candles requested per `loadoldercandles` batch. Exported
// because MarketsPage drives the actual WS fetch and latches the
// history-floor flag when the response is short (`received.length <
// HISTORY_BATCH_SIZE`). Colocated with HISTORY_PREFETCH_THRESHOLD so the
// batch-vs-threshold invariant stays visible in one place.
export const HISTORY_BATCH_SIZE = 1000

const CANDLE_FONT = '12px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
// Smaller font for X-axis date/time labels. The Y-axis gutter needs the
// full 12px for price/volume legibility, but X-axis dates are compact
// enough to use 10px without losing readability.
const X_LABEL_FONT = '10px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// Duration-buttons grid (#candleDurBttnBox in markets.scss) geometry.
// These values MUST stay in sync with the CSS. The canvas uses them to
// size the right gutter, draw a separator that matches the grid
// pixel-for-pixel, and clamp Y-axis pill positions so they never overlap
// the buttons.
const DUR_BTN_GRID_WIDTH = 84  // CSS: width
const DUR_BTN_GRID_RIGHT = 2   // CSS: right
// Gutter floor = grid width + right offset + 2px of left breathing room,
// so the grid always sits inside the yLabelsRegion with a little padding
// even when Y-labels are short.
const DUR_BTN_GRID_MIN_GUTTER = DUR_BTN_GRID_WIDTH + DUR_BTN_GRID_RIGHT + 2
// Y of the separator line drawn below the 2x2 grid. Derived from the CSS
// layout: 5 (top) + 21 (row-h) + 2 (gap) + 21 (row-h) = 49, + 5px so the
// line doesn't kiss the bottom of the button border.
const DUR_BTN_SEP_Y = 54
// Minimum Y-center for any pill rendered in the right gutter so the pill
// box clears the buttons. Separator Y + pill half-height (~9px for 12px
// CANDLE_FONT) + 1px breathing room.
const DUR_BTN_PILL_MIN_Y = DUR_BTN_SEP_Y + 10

export interface CandleReporters {
  mouse: (candle: Candle | null) => void
  // requestOlderHistory is invoked when the user pans or zooms such that
  // the visible window is near the start of the locally-cached history.
  // Fire-and-forget; the parent is responsible for debouncing, enforcing
  // history-floor state, and merging the response.
  requestOlderHistory: () => void
}

interface Props {
  data: CandlesPayload | null
  market: Market | null
  baseUnitInfo: UnitInfo | null
  quoteUnitInfo: UnitInfo | null
  mktId: string
  reporters: CandleReporters
}

export function CandleChart ({ data, market, baseUnitInfo, quoteUnitInfo, mktId, reporters }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const darkMode = useUIStore(s => s.darkMode)
  // Gates the one-shot zoom/pan initialisation inside the [data] effect.
  // Flipped to true after the first data payload for a given market/dur
  // and cleared back to false on market/dur change so the saved zoom is
  // reapplied to the fresh stream.
  const hasInitRef = useRef(false)
  // endStamp of the newest candle seen on the last data update. Used to
  // distinguish appends (newest advances) from prepends (newest stays,
  // oldest moves further back). Only appends shift panOffset -- panOffset
  // is measured from the newest, so prepends leave the user's view anchored
  // without adjustment.
  const prevNewestStampRef = useRef(0)
  // Total candle count for which we most recently fired
  // `reporters.requestOlderHistory`. We re-arm the trigger when `total`
  // grows (older candles arrived and extended the cache) so the next pan
  // into the new history edge can request more. Reset on market/dur
  // change via the effect below.
  const lastLoadOlderForTotalRef = useRef(0)
  const stateRef = useRef<{
    mousePos: Point | null
    numToShow: number
    panOffset: number
    dragStart: { x: number; panOffset: number } | null
    isDragging: boolean
    plotRegion: Region | null
    candleRegion: Region | null
    volumeRegion: Region | null
    xLabelsRegion: Region | null
    yLabelsRegion: Region | null
    rect: DOMRect | null
    // Logical (CSS-pixel) canvas dimensions. The backing-store is
    // `logicalW * dpr` × `logicalH * dpr`; drawing coords are in logical
    // pixels after the context transform is scaled by dpr.
    logicalW: number
    logicalH: number
    theme: Theme
  }>({
    mousePos: null,
    numToShow: 0,
    panOffset: 0,
    dragStart: null,
    isDragging: false,
    plotRegion: null,
    candleRegion: null,
    volumeRegion: null,
    xLabelsRegion: null,
    yLabelsRegion: null,
    rect: null,
    logicalW: 0,
    logicalH: 0,
    theme: darkMode ? darkTheme : lightTheme
  })

  useEffect(() => {
    stateRef.current.theme = darkMode ? darkTheme : lightTheme
  }, [darkMode])

  // Reset pan when market or duration changes - the candle index space
  // starts fresh so the old offset is meaningless.
  useEffect(() => {
    stateRef.current.panOffset = 0
    hasInitRef.current = false
    prevNewestStampRef.current = 0
    lastLoadOlderForTotalRef.current = 0
  }, [mktId, data?.dur])

  // Initialise / clamp zoom+pan on each data update. When new candles
  // append while the user is scrolled back, shift panOffset by the number
  // of appends so they keep seeing the same absolute slice of history.
  // Prepends (older-history pagination) don't shift panOffset because
  // panOffset is measured from the newest candle - a prepend grows the
  // index space at the far end, leaving the current view anchored.
  useEffect(() => {
    if (!data || !data.candles?.length) return
    const total = data.candles.length
    const s = stateRef.current
    const newestStamp = data.candles[total - 1].endStamp

    if (!hasInitRef.current) {
      // First data for this market/duration - initialise zoom from the
      // saved preference or a default. If the chart would boot maxed out
      // (desired >= total), back off to ~70% so the wheel has room to
      // zoom out. Without this, small markets silently no-op on zoom-out
      // because clamp snaps `newNum` back to total.
      const saved = fetchLocal(lastCandleZoomLevelLK)
      let desired = (typeof saved === 'number' && saved > 0)
        ? saved
        : (s.numToShow || DEFAULT_ZOOM_CANDLES)
      if (desired >= total) desired = Math.max(MIN_ZOOM_CANDLES, Math.floor(total * 0.7))
      s.numToShow = clamp(Math.round(desired), MIN_ZOOM_CANDLES, Math.max(total, MIN_ZOOM_CANDLES))
      hasInitRef.current = true
    } else {
      // Subsequent ticks within the same stream - preserve the user's
      // chosen zoom, just re-clamp to the new `total`. Running the init
      // here would undo an explicit zoom-to-max the moment the next
      // candle ticks in.
      s.numToShow = clamp(s.numToShow, MIN_ZOOM_CANDLES, Math.max(total, MIN_ZOOM_CANDLES))

      // Compute append count from the endStamp delta instead of the
      // overall length delta: only appended candles move the rightmost
      // index, so only they should shift panOffset. Prepends from
      // older-history pagination leave newestStamp unchanged, giving
      // appendCount=0 and leaving panOffset alone.
      const prevNewest = prevNewestStampRef.current
      if (newestStamp > prevNewest && s.panOffset > 0) {
        const appendCount = Math.round((newestStamp - prevNewest) / data.ms)
        if (appendCount > 0) s.panOffset += appendCount
      }
    }
    prevNewestStampRef.current = newestStamp
    s.panOffset = clamp(s.panOffset, 0, Math.max(0, total - s.numToShow))
  }, [data])

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    // Scale the backing store by devicePixelRatio so canvas text (axis
    // labels, volume numbers, dates) renders crisp on HiDPI displays.
    // The context is then scaled by the same factor, so all subsequent
    // drawing code works in logical/CSS pixels.
    const dpr = window.devicePixelRatio || 1
    const logicalW = parent.clientWidth
    const logicalH = parent.clientHeight
    canvas.width = Math.round(logicalW * dpr)
    canvas.height = Math.round(logicalH * dpr)
    canvas.style.width = `${logicalW}px`
    canvas.style.height = `${logicalH}px`
    const xLblHeight = 22
    // Initial Y-gutter width is a rough default; render() narrows or
    // widens it after the first pass of makeYLabels measures the actual
    // label text. DUR_BTN_GRID_MIN_GUTTER keeps just enough room for the
    // 2x2 button grid while compressing the gutter so the plot gets as
    // much width as possible.
    const yLblWidth = DUR_BTN_GRID_MIN_GUTTER

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Setting canvas.width/height above resets the context transform, so
    // re-apply the dpr scale on every resize.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const plotExtents = new Extents(0, logicalW - yLblWidth, 0, logicalH - xLblHeight)
    const xLblExtents = new Extents(0, logicalW - yLblWidth, logicalH - xLblHeight, logicalH)
    const yLblExtents = new Extents(logicalW - yLblWidth, logicalW, 0, logicalH - xLblHeight)
    const s = stateRef.current
    s.logicalW = logicalW
    s.logicalH = logicalH
    s.plotRegion = new Region(ctx, plotExtents)
    s.xLabelsRegion = new Region(ctx, xLblExtents)
    s.yLabelsRegion = new Region(ctx, yLblExtents)
    const ext = plotExtents
    s.candleRegion = new Region(ctx, new Extents(ext.x.min, ext.x.max, ext.y.min, ext.y.min + ext.yRange * 0.85))
    s.volumeRegion = new Region(ctx, new Extents(ext.x.min, ext.x.max, ext.y.min + 0.85 * ext.yRange, ext.y.max))
    s.rect = canvas.getBoundingClientRect()
  }, [])

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !data || !market || !baseUnitInfo || !quoteUnitInfo) return
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width === 0) return

    const s = stateRef.current
    if (!s.plotRegion || !s.candleRegion || !s.volumeRegion || !s.xLabelsRegion || !s.yLabelsRegion) return

    const { theme, mousePos, numToShow, panOffset, isDragging } = s
    // TEMPORARY WORKAROUND: the 3rd-party DEX server publishes an
    // anomalous 24h candle around 2026-02-10 UTC whose high rate dwarfs
    // the rest of the visible range and compresses every other candle
    // into a flat line near the bottom of the chart. Drop any 24h
    // candle whose startStamp falls in a 3-day window around Feb 10
    // UTC so the filter still catches the spike regardless of small
    // timezone-driven alignment differences. Non-chart UI (e.g. the
    // 24h volume header) still sees the full data. REMOVE once the
    // server data is corrected.
    const ANOMALY_24H_MIN = Date.UTC(2026, 1, 9)   // 2026-02-09 UTC inclusive
    const ANOMALY_24H_MAX = Date.UTC(2026, 1, 12)  // 2026-02-12 UTC exclusive
    const allCandles = (data.candles || []).filter(c =>
      !(data.ms === 86400000 &&
        c.startStamp >= ANOMALY_24H_MIN &&
        c.startStamp < ANOMALY_24H_MAX)
    )
    const candleWidth = data.ms
    const rateStep = market.ratestep

    ctx.clearRect(0, 0, s.logicalW, s.logicalH)
    if (numToShow === 0 || allCandles.length === 0) return

    const endIdx = allCandles.length - panOffset
    const startIdx = Math.max(0, endIdx - numToShow)
    const candles = allCandles.slice(startIdx, endIdx)
    if (candles.length === 0) return

    const candleWidthPadding = 0.2
    const start = (c: Candle) => truncate(c.endStamp, candleWidth)
    const end = (c: Candle) => start(c) + candleWidth
    const paddedStart = (c: Candle) => start(c) + candleWidthPadding * candleWidth
    const paddedWidth = (1 - 2 * candleWidthPadding) * candleWidth

    const candleFirst = candles[0]
    const candleLast = candles[candles.length - 1]
    const startStamp = start(candleFirst)
    const endStamp = end(candleLast)

    let [highPrice, lowPrice, highVol] = [candleFirst.highRate, candleFirst.lowRate, candleFirst.matchVolume]
    for (const c of candles) {
      if (c.highRate > highPrice) highPrice = c.highRate
      if (c.lowRate < lowPrice) lowPrice = c.lowRate
      if (c.matchVolume > highVol) highVol = c.matchVolume
    }

    // Right-side padding is applied only when the latest candle is in
    // view (panOffset === 0) so it doesn't sit flush against the Y-axis
    // gutter on first load. When the user has panned back in history the
    // rightmost visible candle is an older one, so we want candles to
    // fill the full plot width instead of leaving a dead strip on the
    // right.
    const xPadding = panOffset === 0 ? (endStamp - startStamp) * 0.05 : 0
    const yPadding = (highPrice - lowPrice) * 0.5
    // Clamp Y min to 0: rates are always > 0, so negative axis values
    // are never meaningful. Without this, anomalous data (e.g. a spike
    // candle with very high rate, or a wide volatile range where
    // yPadding > lowPrice) can push the bottom padding below zero and
    // surface negative price labels on the right gutter.
    const yMin = Math.max(0, lowPrice - yPadding)
    const chartExtents = new Extents(startStamp, endStamp + xPadding, yMin, highPrice + yPadding)
    if (lowPrice === highPrice) {
      chartExtents.y.min = Math.max(0, chartExtents.y.min - rateStep)
      chartExtents.y.max += rateStep
    }

    ctx.font = CANDLE_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = theme.axisLabel
    s.yLabelsRegion.extents.y.max = s.candleRegion.extents.y.max

    // Compute Y labels first - uses candleRegion.height() which doesn't
    // depend on gutter width, so it's safe to run before resizing regions.
    const yLabels = makeYLabels(ctx, s.candleRegion.height(), chartExtents.y.min, chartExtents.y.max, 50, rateStep,
      v => formatRateAtomToRateStep(v, baseUnitInfo, quoteUnitInfo, rateStep)
    )
    // Drop ticks that would render poorly, in a single pass so that the
    // grid line and its label stay coupled (plotYGrid and the label pass
    // share this list). Two cases are filtered:
    //  1. Ticks within a few pixels of the top (chart border or duration-
    //     buttons grid) or bottom (volume divider) edge - otherwise the
    //     grid line kisses the edge / the label collides with the
    //     buttons.
    //  2. The single tick closest to the live price - its label would stack
    //     under the coloured last-price pill. Done here (not in the label
    //     render loop) so the grid line is removed too; otherwise users see
    //     a naked grid line without a corresponding label after panning.
    const edgePadPx = 50
    const yFilterTools = s.candleRegion.translator(new Extents(0, 1, chartExtents.y.min, chartExtents.y.max))
    // Top floor also has to clear the duration-buttons grid so a label
    // center doesn't land inside a button row.
    const topEdgeY = Math.max(s.candleRegion.extents.y.min + edgePadPx, DUR_BTN_PILL_MIN_Y)
    const botEdgeY = s.candleRegion.extents.y.max - edgePadPx
    const globalLast = allCandles[allCandles.length - 1]
    let dropIdx = -1
    if (globalLast && yLabels.lbls.length > 0) {
      let minDist = Infinity
      yLabels.lbls.forEach((lbl, i) => {
        const d = Math.abs(lbl.val - globalLast.endRate)
        if (d < minDist) { minDist = d; dropIdx = i }
      })
    }
    yLabels.lbls = yLabels.lbls.filter((lbl, i) => {
      if (i === dropIdx) return false
      const ly = yFilterTools.y(lbl.val)
      return ly >= topEdgeY && ly <= botEdgeY
    })

    // Volume gutter tick shows 50% of the visible max volume, centered
    // vertically in the volume pane. Its width feeds into the gutter sizing
    // so the label shares the same column as the price labels without
    // clipping.
    const volLabelText = formatCoinAtomToLotSizeBaseCurrency(highVol / 2, baseUnitInfo, market.lotsize)
    const volLabelWidth = ctx.measureText(volLabelText).width

    // Snap the Y-gutter width to the widest label so prices/volume can't clip.
    // Adjusts the shared X-max across plot/candle/volume/xLabels regions
    // and the X-min of yLabelsRegion; Y coords are untouched. The
    // DUR_BTN_GRID_MIN_GUTTER floor keeps the gutter wide enough to host
    // the 2x2 duration-buttons grid without it overflowing into the plot.
    const requiredYLblWidth = Math.max(DUR_BTN_GRID_MIN_GUTTER, Math.ceil(Math.max(yLabels.widest, volLabelWidth)) + 10)
    const currentYLblWidth = s.logicalW - s.plotRegion.extents.x.max
    if (Math.abs(requiredYLblWidth - currentYLblWidth) > 2) {
      const newPlotMaxX = s.logicalW - requiredYLblWidth
      s.plotRegion.extents.x.max = newPlotMaxX
      s.candleRegion.extents.x.max = newPlotMaxX
      s.volumeRegion.extents.x.max = newPlotMaxX
      s.xLabelsRegion.extents.x.max = newPlotMaxX
      s.yLabelsRegion.extents.x.min = newPlotMaxX
    }

    // Identify the candle under the cursor (drives the OHLCV reporter and
    // the crosshair X snap). Must run AFTER the gutter-width adjustment so
    // the cursor-to-data mapping reflects the final plot width.
    let mouseCandle: Candle | null = null
    let mouseCandleCenterX: number | null = null
    if (mousePos && !isDragging) {
      const plotToolsX = s.plotRegion.translator(new Extents(chartExtents.x.min, chartExtents.x.max, 0, 1))
      const selectedStartStamp = truncate(plotToolsX.unx(mousePos.x), candleWidth)
      for (const c of candles) {
        if (start(c) === selectedStartStamp) {
          mouseCandle = c
          mouseCandleCenterX = plotToolsX.x(start(c) + candleWidth / 2)
          break
        }
      }
    }

    // X labels depend on plotRegion.width(), which may have just changed.
    const xLabels = makeCandleTimeLabels(candles, candleWidth, s.plotRegion.width(), 100)
    plotXGrid(s.plotRegion, xLabels, chartExtents.x.min, chartExtents.x.max, theme)
    plotYGrid(s.candleRegion, yLabels, chartExtents.y.min, chartExtents.y.max, theme)

    // Dividers: horizontal between candle + volume panes, vertical between
    // the plot area and the right-side price/volume gutter, and a short
    // horizontal segment inside the gutter that mirrors the 2x2 duration-
    // buttons grid and separates it from the price labels below. The
    // segment is sized to match the grid exactly (same left/right edges)
    // so it reads as a visual helper for the grid, not a continuation of
    // the vertical gutter divider.
    ctx.save()
    ctx.strokeStyle = theme.axisLabel
    ctx.globalAlpha = 0.4
    ctx.lineWidth = 1
    const divY = s.candleRegion.extents.y.max
    drawLine(ctx, s.plotRegion.extents.x.min, divY, s.logicalW, divY)
    const divX = s.plotRegion.extents.x.max
    drawLine(ctx, divX, s.plotRegion.extents.y.min, divX, s.plotRegion.extents.y.max)
    // Match the grid exactly: right-anchored with DUR_BTN_GRID_RIGHT
    // offset, DUR_BTN_GRID_WIDTH span, DUR_BTN_SEP_Y below the 2x2 rows.
    const gridRight = s.logicalW - DUR_BTN_GRID_RIGHT
    const gridLeft = gridRight - DUR_BTN_GRID_WIDTH
    drawLine(ctx, gridLeft, DUR_BTN_SEP_Y, gridRight, DUR_BTN_SEP_Y)
    ctx.restore()

    // Volume bars -- colored per candle with alpha. 15% headroom above the
    // tallest bar keeps bars from kissing the divider and leaves space for
    // the max-volume tick label.
    const volDataExtents = new Extents(chartExtents.x.min, chartExtents.x.max, 0, highVol * 1.15)
    s.volumeRegion.plot(volDataExtents, (vCtx, tools) => {
      for (const c of candles) {
        const up = c.endRate >= c.startRate
        vCtx.fillStyle = up ? theme.volumeUp : theme.volumeDown
        vCtx.fillRect(tools.x(paddedStart(c)), tools.y(0), tools.w(paddedWidth), tools.h(c.matchVolume))
      }
    })

    // Volume tick label on the right gutter: 50% of visible max volume,
    // centered vertically in the volume pane.
    const volLabelY = (s.volumeRegion.extents.y.min + s.volumeRegion.extents.y.max) / 2
    ctx.save()
    ctx.font = CANDLE_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = theme.axisLabel
    ctx.fillText(volLabelText, s.yLabelsRegion.extents.x.min + 5, volLabelY)
    ctx.restore()

    // Candles.
    s.candleRegion.plot(chartExtents, (cCtx, tools) => {
      cCtx.lineWidth = 1
      for (const c of candles) {
        const up = c.endRate >= c.startRate
        const color = up ? theme.candleUp : theme.candleDown
        const [x, y, w, h] = [tools.x(paddedStart(c)), tools.y(c.startRate), tools.w(paddedWidth), tools.h(c.endRate - c.startRate)]
        const [high, low, cx] = [tools.y(c.highRate), tools.y(c.lowRate), w / 2 + x]
        cCtx.strokeStyle = color
        cCtx.fillStyle = color
        cCtx.beginPath()
        cCtx.moveTo(cx, high)
        cCtx.lineTo(cx, low)
        cCtx.stroke()
        // Doji (open == close) - draw a 1px stub instead of an invisible rect.
        if (Math.abs(h) < 1) {
          cCtx.fillRect(x, y - 0.5, w, 1)
        } else {
          cCtx.fillRect(x, y, w, h)
          cCtx.strokeRect(x, y, w, h)
        }
      }
    })

    // Last-price line + right-gutter pill - always pinned to the latest
    // global candle, so the marker survives panning back in history.
    if (globalLast) {
      const lastUp = globalLast.endRate >= globalLast.startRate
      const inRange = globalLast.endRate >= chartExtents.y.min && globalLast.endRate <= chartExtents.y.max
      const candleYTools = s.candleRegion.translator(chartExtents)
      const rawY = candleYTools.y(globalLast.endRate)
      if (inRange) {
        s.candleRegion.plot(chartExtents, (lctx, tools) => {
          lctx.strokeStyle = lastUp ? theme.lastLineUp : theme.lastLineDown
          lctx.lineWidth = 1
          dashedLine(lctx, tools.x(chartExtents.x.min), rawY, tools.x(chartExtents.x.max), rawY, [4, 4])
        })
      }
      // Pill - if the price is off-range, clamp to the nearest edge so
      // the user can still see it. The lower bound also clears the
      // duration-buttons grid (DUR_BTN_PILL_MIN_Y) so the pill doesn't
      // overlap the buttons when the live price sits near the top of
      // the visible range.
      const candleRegYMin = s.candleRegion.extents.y.min
      const candleRegYMax = s.candleRegion.extents.y.max
      const pillY = clamp(rawY, Math.max(candleRegYMin + 10, DUR_BTN_PILL_MIN_Y), candleRegYMax - 10)
      const pillX = s.yLabelsRegion.extents.x.min + s.yLabelsRegion.width() / 2
      pillLabel(
        ctx, pillX, pillY,
        formatRateAtomToRateStep(globalLast.endRate, baseUnitInfo, quoteUnitInfo, rateStep),
        lastUp ? theme.lastLineUp : theme.lastLineDown,
        '#FFFFFF'
      )
    }

    // X labels (bottom axis).
    plotXLabels(s.xLabelsRegion, xLabels, chartExtents.x.min, chartExtents.x.max, theme)

    // Y labels (right gutter). yLabels.lbls was pre-filtered upstream so
    // both the grid line and its label disappear together.
    const xExtents = new Extents(chartExtents.x.min, chartExtents.x.max, 0, 1)
    const yExtents = new Extents(0, 1, chartExtents.y.min, chartExtents.y.max)
    const xTools = s.xLabelsRegion.translator(xExtents)
    s.yLabelsRegion.plot(yExtents, (yCtx, yTools) => {
      yCtx.textAlign = 'left'
      yCtx.textBaseline = 'middle'
      yCtx.font = CANDLE_FONT
      yCtx.fillStyle = theme.axisLabel
      const xPad = 5
      const xTextStart = xTools.x(endStamp + xPadding) + xPad
      yLabels.lbls.forEach((lbl) => {
        yCtx.fillText(lbl.txt, xTextStart, yTools.y(lbl.val))
      })
    }, true)

    // Crosshair + axis pills.
    if (mousePos && !isDragging && s.plotRegion.contains(mousePos.x, mousePos.y)) {
      const crossX = mouseCandleCenterX ?? mousePos.x
      ctx.save()
      ctx.strokeStyle = theme.crosshair
      ctx.lineWidth = 1
      dashedLine(ctx,
        crossX, s.plotRegion.extents.y.min,
        crossX, s.plotRegion.extents.y.max,
        [4, 4]
      )
      if (mousePos.y >= s.candleRegion.extents.y.min && mousePos.y <= s.candleRegion.extents.y.max) {
        dashedLine(ctx,
          s.plotRegion.extents.x.min, mousePos.y,
          s.plotRegion.extents.x.max, mousePos.y,
          [4, 4]
        )
        const yToolsPlot = s.candleRegion.translator(chartExtents)
        const priceAtCursor = yToolsPlot.uny(mousePos.y)
        const pillX = s.yLabelsRegion.extents.x.min + s.yLabelsRegion.width() / 2
        // Clamp the pill's Y below the duration-buttons grid. When the
        // cursor is in the top gutter area the pill decouples from the
        // crosshair dashed line and sits just below the buttons; the
        // label text still shows the price at the real cursor Y.
        const pillCrossY = Math.max(mousePos.y, DUR_BTN_PILL_MIN_Y)
        ctx.font = CANDLE_FONT
        pillLabel(
          ctx, pillX, pillCrossY,
          formatRateAtomToRateStep(priceAtCursor, baseUnitInfo, quoteUnitInfo, rateStep),
          theme.axisPillBg, theme.axisPillFg
        )
      } else if (highVol > 0 && mousePos.y >= s.volumeRegion.extents.y.min && mousePos.y <= s.volumeRegion.extents.y.max) {
        dashedLine(ctx,
          s.plotRegion.extents.x.min, mousePos.y,
          s.plotRegion.extents.x.max, mousePos.y,
          [4, 4]
        )
        const yToolsVol = s.volumeRegion.translator(volDataExtents)
        const volAtCursor = Math.max(0, yToolsVol.uny(mousePos.y))
        const pillX = s.yLabelsRegion.extents.x.min + s.yLabelsRegion.width() / 2
        ctx.font = CANDLE_FONT
        pillLabel(
          ctx, pillX, mousePos.y,
          formatCoinAtomToLotSizeBaseCurrency(volAtCursor, baseUnitInfo, market.lotsize),
          theme.axisPillBg, theme.axisPillFg
        )
      }
      if (mouseCandle && mouseCandleCenterX != null) {
        const pillY = s.xLabelsRegion.extents.y.min + s.xLabelsRegion.height() / 2
        ctx.font = X_LABEL_FONT
        pillLabel(
          ctx, crossX, pillY,
          formatCrosshairTime(mouseCandle.endStamp, candleWidth),
          theme.axisPillBg, theme.axisPillFg
        )
      }
      ctx.restore()
    }

    reporters.mouse(isDragging ? null : mouseCandle)
  }, [data, market, baseUnitInfo, quoteUnitInfo, reporters])

  // Trigger a load-older request when the visible window has pushed
  // within HISTORY_PREFETCH_THRESHOLD candles of the cached history edge.
  // De-duped by the last total we fired for, so subsequent pans don't
  // spam requests until more history actually arrives (which grows
  // `total`). `lastLoadOlderForTotalRef` is reset on market/dur change.
  const maybeRequestOlderHistory = useCallback(() => {
    const total = data?.candles?.length ?? 0
    if (total === 0) return
    const s = stateRef.current
    if (s.panOffset + s.numToShow < total - HISTORY_PREFETCH_THRESHOLD) return
    if (lastLoadOlderForTotalRef.current === total) return
    lastLoadOlderForTotalRef.current = total
    reporters.requestOlderHistory()
  }, [data, reporters])

  // Mouse + wheel + resize wiring.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const getPos = (e: MouseEvent): Point | null => {
      const s = stateRef.current
      if (!s.rect) return null
      return { x: e.clientX - s.rect.left, y: e.clientY - s.rect.top }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const s = stateRef.current
      const pos = getPos(e)
      if (!pos || !s.plotRegion?.contains(pos.x, pos.y)) return
      s.dragStart = { x: pos.x, panOffset: s.panOffset }
      s.isDragging = false
    }

    const onMouseMove = (e: MouseEvent) => {
      const s = stateRef.current
      const pos = getPos(e)
      if (!pos) return
      s.mousePos = pos
      if (s.dragStart && data && s.plotRegion) {
        const dx = pos.x - s.dragStart.x
        if (!s.isDragging && Math.abs(dx) > DRAG_THRESHOLD_PX) {
          s.isDragging = true
          canvas.style.cursor = 'grabbing'
        }
        if (s.isDragging) {
          const pxPerCandle = s.plotRegion.width() / Math.max(s.numToShow, 1)
          const deltaCandles = Math.round(dx / pxPerCandle)
          const total = data.candles?.length ?? 0
          s.panOffset = clamp(s.dragStart.panOffset + deltaCandles, 0, Math.max(0, total - s.numToShow))
          maybeRequestOlderHistory()
        }
      }
      render()
    }

    const onMouseUp = () => {
      const s = stateRef.current
      s.dragStart = null
      s.isDragging = false
      canvas.style.cursor = ''
      render()
    }

    const onMouseLeave = () => {
      const s = stateRef.current
      s.mousePos = null
      s.dragStart = null
      s.isDragging = false
      canvas.style.cursor = ''
      render()
    }

    const onWheel = (e: WheelEvent) => {
      // Claim the wheel so the page doesn't scroll while the cursor is
      // over the chart. Requires the listener to be non-passive (see
      // addEventListener call below).
      e.preventDefault()
      const s = stateRef.current
      if (!data || !s.plotRegion) return
      const total = data.candles?.length ?? 0
      if (total === 0) return
      const bigger = e.deltaY < 0
      const factor = bigger ? 1 / ZOOM_WHEEL_FACTOR : ZOOM_WHEEL_FACTOR
      // Guarantee at least a one-candle step per wheel tick - at small
      // numToShow values the ~1.5% multiplier rounds to zero, which would
      // otherwise make the wheel feel dead.
      let stepped = Math.round(s.numToShow * factor)
      if (stepped === s.numToShow) stepped = s.numToShow + (bigger ? -1 : 1)
      const newNum = clamp(stepped, MIN_ZOOM_CANDLES, Math.max(MIN_ZOOM_CANDLES, total))
      if (newNum === s.numToShow) return
      // Anchor the zoom to the cursor so the candle under the mouse stays
      // under the mouse (Binance behaviour). With no cursor, pin right edge.
      const width = s.plotRegion.width()
      const plotX0 = s.plotRegion.extents.x.min
      const cursorX = s.mousePos?.x
      const fraction = (cursorX != null && width > 0)
        ? clamp((cursorX - plotX0) / width, 0, 1)
        : 1
      const viewportStart = total - s.numToShow - s.panOffset
      const anchorIdx = viewportStart + fraction * s.numToShow
      const newViewportStart = anchorIdx - fraction * newNum
      s.numToShow = newNum
      s.panOffset = clamp(
        Math.round(total - newNum - newViewportStart),
        0,
        Math.max(0, total - newNum)
      )
      storeLocal(lastCandleZoomLevelLK, s.numToShow)
      maybeRequestOlderHistory()
      render()
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('mouseleave', onMouseLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    const observer = new ResizeObserver(() => {
      resize()
      render()
    })
    observer.observe(parent)

    resize()
    render()

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
    // `data` is intentionally omitted - `render`'s useCallback deps include
    // it, so `render`'s identity changes when candles update and this effect
    // re-runs, rebinding handlers with the fresh closure.
    // `maybeRequestOlderHistory` is included because the handlers reference
    // it; its identity also changes with `data`, which re-runs this effect.
  }, [resize, render, maybeRequestOlderHistory])

  useEffect(() => {
    resize()
    render()
    // `data` / `market` are folded into `render`'s identity. `darkMode`
    // stays because theme updates mutate stateRef without touching render.
  }, [darkMode, resize, render])

  return <canvas ref={canvasRef} />
}

function plotXGrid (plotRegion: Region, labels: LabelSet, minX: number, maxX: number, theme: Theme) {
  const extents = new Extents(minX, maxX, 0, 1)
  plotRegion.plot(extents, (ctx, tools) => {
    ctx.lineWidth = 1
    ctx.strokeStyle = theme.gridLines
    labels.lbls.forEach(lbl => {
      drawLine(ctx, tools.x(lbl.val), tools.y(0), tools.x(lbl.val), tools.y(1))
    })
  }, true)
}

function plotYGrid (region: Region, labels: LabelSet, minY: number, maxY: number, theme: Theme) {
  const extents = new Extents(0, 1, minY, maxY)
  region.plot(extents, (ctx, tools) => {
    ctx.lineWidth = 1
    ctx.strokeStyle = theme.gridLines
    labels.lbls.forEach(lbl => {
      drawLine(ctx, tools.x(0), tools.y(lbl.val), tools.x(1), tools.y(lbl.val))
    })
  }, true)
}

function plotXLabels (xLabelsRegion: Region, labels: LabelSet, minX: number, maxX: number, theme: Theme) {
  const extents = new Extents(minX, maxX, 0, 1)
  xLabelsRegion.plot(extents, (ctx, tools) => {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = X_LABEL_FONT
    ctx.fillStyle = theme.axisLabel
    const [leftEdge, rightEdge] = [tools.x(minX), tools.x(maxX)]
    const centerY = tools.y(0.5)
    labels.lbls.forEach(lbl => {
      const m = ctx.measureText(lbl.txt)
      const x = tools.x(lbl.val)
      if (x - m.width / 2 < leftEdge || x + m.width / 2 > rightEdge) return
      ctx.fillText(lbl.txt, x, centerY)
    })
  }, true)
}

function formatCrosshairTime (endStamp: number, dur: number): string {
  const d = new Date(endStamp - dur)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (dur >= 86400000) {
    return `${d.getFullYear()}/${mm}/${dd}`
  }
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}
