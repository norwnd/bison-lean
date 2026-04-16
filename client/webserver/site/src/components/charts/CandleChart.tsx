import { useRef, useEffect, useCallback } from 'react'
import { useUIStore } from '../../stores/useUIStore'
import { Candle, CandlesPayload, Market, UnitInfo } from '../../stores/types'
import { formatRateAtomToRateStep } from '../../hooks/useFormatters'
import { fetchLocal, storeLocal, lastCandleZoomLevelLK } from '../../services/state'
import {
  Extents, Region, Theme, darkTheme, lightTheme,
  line as drawLine, LabelSet, makeYLabels, makeCandleTimeLabels, truncate, Point
} from './chartUtils'

// Default zoom level (candle count) used when the user has no saved
// preference yet. The preference is persisted to localStorage under
// `lastCandleZoomLevelLK` and reused across market / duration switches
// and across browser sessions. Live candle updates do NOT reset the zoom.
const DEFAULT_ZOOM_CANDLES = 90

// Snap a target candle count to the nearest valid zoom level (preferring
// the largest level that does not exceed the target). Needed because
// saved preferences may not land exactly on a level when the candle count
// or duration changes.
function snapToZoomLevel (target: number, levels: number[]): number {
  if (levels.length === 0) return 0
  if (levels.includes(target)) return target
  let best = levels[0]
  for (const lvl of levels) {
    if (lvl > target) break
    best = lvl
  }
  return best
}

export interface CandleReporters {
  mouse: (candle: Candle | null) => void
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
  const stateRef = useRef<{
    mousePos: Point | null
    numToShow: number
    zoomLevels: number[]
    plotRegion: Region | null
    candleRegion: Region | null
    volumeRegion: Region | null
    xLabelsRegion: Region | null
    yLabelsRegion: Region | null
    rect: DOMRect | null
    theme: Theme
  }>({
    mousePos: null,
    numToShow: 0,
    zoomLevels: [],
    plotRegion: null,
    candleRegion: null,
    volumeRegion: null,
    xLabelsRegion: null,
    yLabelsRegion: null,
    rect: null,
    theme: darkMode ? darkTheme : lightTheme
  })

  // Update theme when darkMode changes
  useEffect(() => {
    stateRef.current.theme = darkMode ? darkTheme : lightTheme
  }, [darkMode])

  // Rebuild zoom levels on every data change. `numToShow` is derived from
  // the user's saved preference (localStorage) or DEFAULT_ZOOM_CANDLES on
  // first load, then preserved across live candle updates so the zoom
  // doesn't snap back every time a new epoch arrives.
  useEffect(() => {
    if (!data || !data.candles?.length) return
    const candles = data.candles
    const levels: number[] = []
    let lvl = Math.min(20, candles.length)
    while (lvl <= candles.length) {
      levels.push(lvl)
      lvl += 2
    }
    if (levels[levels.length - 1] !== candles.length) levels.push(candles.length)
    stateRef.current.zoomLevels = levels

    const saved = fetchLocal(lastCandleZoomLevelLK)
    const desired = (typeof saved === 'number' && saved > 0)
      ? saved
      : (stateRef.current.numToShow || DEFAULT_ZOOM_CANDLES)
    stateRef.current.numToShow = snapToZoomLevel(Math.min(desired, candles.length), levels)
  }, [data])

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    canvas.width = parent.clientWidth
    canvas.height = parent.clientHeight
    const xLblHeight = 30
    let yLblWidth = 80
    const yLblWidthByAsset: Record<string, number> = {
      'dcr_usdc.polygon': 48, 'dcr_usdt.polygon': 48, 'ltc_usdt.polygon': 54,
      'dcr_btc': 78, 'usdc.polygon_usdt.polygon': 56, 'btc_usdt.polygon': 70, 'dcr_polygon': 48
    }
    if (yLblWidthByAsset[mktId]) yLblWidth = yLblWidthByAsset[mktId]

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const plotExtents = new Extents(0, canvas.width - yLblWidth, 0, canvas.height - xLblHeight)
    const xLblExtents = new Extents(0, canvas.width - yLblWidth, canvas.height - xLblHeight, canvas.height)
    const yLblExtents = new Extents(canvas.width - yLblWidth, canvas.width, 0, canvas.height - xLblHeight)
    const s = stateRef.current
    s.plotRegion = new Region(ctx, plotExtents)
    s.xLabelsRegion = new Region(ctx, xLblExtents)
    s.yLabelsRegion = new Region(ctx, yLblExtents)
    const ext = plotExtents
    s.candleRegion = new Region(ctx, new Extents(ext.x.min, ext.x.max, ext.y.min, ext.y.min + ext.yRange * 0.85))
    s.volumeRegion = new Region(ctx, new Extents(ext.x.min, ext.x.max, ext.y.min + 0.85 * ext.yRange, ext.y.max))
    s.rect = canvas.getBoundingClientRect()
  }, [mktId])

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !data || !market || !baseUnitInfo || !quoteUnitInfo) return
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width === 0) return

    const s = stateRef.current
    if (!s.plotRegion || !s.candleRegion || !s.volumeRegion || !s.xLabelsRegion || !s.yLabelsRegion) return

    const { theme, mousePos, numToShow } = s
    const allCandles = data.candles || []
    const candleWidth = data.ms
    const rateStep = market.ratestep

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (numToShow === 0 || allCandles.length === 0) return

    const candles = allCandles.slice(allCandles.length - numToShow)
    const candleWidthPadding = 0.2
    const start = (c: Candle) => truncate(c.endStamp, candleWidth)
    const end = (c: Candle) => start(c) + candleWidth
    const paddedStart = (c: Candle) => start(c) + candleWidthPadding * candleWidth
    const paddedWidth = (1 - 2 * candleWidthPadding) * candleWidth

    const candleFirst = candles[0]
    const candleLast = candles[numToShow - 1]
    const startStamp = start(candleFirst)
    const endStamp = end(candleLast)

    let [highPrice, lowPrice, highVol] = [candleFirst.highRate, candleFirst.lowRate, candleFirst.matchVolume]
    for (const c of candles) {
      if (c.highRate > highPrice) highPrice = c.highRate
      if (c.lowRate < lowPrice) lowPrice = c.lowRate
      if (c.matchVolume > highVol) highVol = c.matchVolume
    }

    const xPadding = (endStamp - startStamp) * 0.05
    const yPadding = (highPrice - lowPrice) * 0.16
    const chartExtents = new Extents(startStamp, endStamp + xPadding, lowPrice, highPrice + yPadding)
    if (lowPrice === highPrice) {
      chartExtents.y.min -= rateStep
      chartExtents.y.max += rateStep
    }

    // Mouse highlight
    let mouseCandle: Candle | null = null
    if (mousePos) {
      s.plotRegion.plot(new Extents(chartExtents.x.min, chartExtents.x.max, 0, 1), (plotCtx, tools) => {
        const selectedStartStamp = truncate(tools.unx(mousePos.x), candleWidth)
        for (const c of candles) {
          if (start(c) === selectedStartStamp) {
            mouseCandle = c
            plotCtx.fillStyle = theme.gridLines
            plotCtx.fillRect(tools.x(start(c)), tools.y(0), tools.w(candleWidth), tools.h(1))
            break
          }
        }
      })
    }

    // Grid
    const xLabels = makeCandleTimeLabels(candles, candleWidth, s.plotRegion.width(), 100)
    plotXGrid(s.plotRegion, xLabels, chartExtents.x.min, chartExtents.x.max, theme)

    // Y labels
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '14px \'sans\', sans-serif'
    ctx.fillStyle = theme.axisLabel
    s.yLabelsRegion.extents.y.max = s.candleRegion.extents.y.max
    const yLabels = makeYLabels(ctx, s.candleRegion.height(), chartExtents.y.min, chartExtents.y.max, 50, rateStep,
      v => formatRateAtomToRateStep(v, baseUnitInfo, quoteUnitInfo, rateStep)
    )
    plotYGrid(s.candleRegion, yLabels, chartExtents.y.min, chartExtents.y.max, theme)

    // Volume bars
    const volDataExtents = new Extents(chartExtents.x.min, chartExtents.x.max, 0, highVol)
    s.volumeRegion.plot(volDataExtents, (vCtx, tools) => {
      vCtx.fillStyle = theme.gridBorder
      for (const c of candles) {
        vCtx.fillRect(tools.x(paddedStart(c)), tools.y(0), tools.w(paddedWidth), tools.h(c.matchVolume))
      }
    })

    // Candles
    s.candleRegion.plot(chartExtents, (cCtx, tools) => {
      cCtx.lineWidth = 1
      for (const c of candles) {
        const desc = c.startRate > c.endRate
        const [x, y, w, h] = [tools.x(paddedStart(c)), tools.y(c.startRate), tools.w(paddedWidth), tools.h(c.endRate - c.startRate)]
        const [high, low, cx] = [tools.y(c.highRate), tools.y(c.lowRate), w / 2 + x]
        cCtx.strokeStyle = desc ? theme.sellLine : theme.buyLine
        cCtx.fillStyle = desc ? theme.sellFill : theme.buyFill
        cCtx.beginPath()
        cCtx.moveTo(cx, high)
        cCtx.lineTo(cx, low)
        cCtx.stroke()
        cCtx.fillRect(x, y, w, h)
        cCtx.strokeRect(x, y, w, h)
      }
    })

    // X labels
    plotXLabels(s.xLabelsRegion, xLabels, chartExtents.x.min, chartExtents.x.max, theme)

    // Y labels text
    const xExtents = new Extents(chartExtents.x.min, chartExtents.x.max, 0, 1)
    const yExtents = new Extents(0, 1, chartExtents.y.min, chartExtents.y.max)
    const xTools = s.xLabelsRegion.translator(xExtents)
    s.yLabelsRegion.plot(yExtents, (yCtx, yTools) => {
      yCtx.textAlign = 'left'
      yCtx.font = '14px \'sans\', sans-serif'
      yCtx.fillStyle = theme.axisLabel
      const xPad = 5
      const yPadTop = 10
      const xTextStart = xTools.x(endStamp + xPadding) + xPad
      yLabels.lbls.forEach(lbl => {
        const ly = yTools.y(lbl.val)
        if (ly < yTools.y(chartExtents.y.max) + yPadTop) return
        yCtx.fillText(lbl.txt, xTextStart, ly)
      })
    }, true)

    reporters.mouse(mouseCandle)
  }, [data, market, baseUnitInfo, quoteUnitInfo, reporters])

  // Setup: resize observer, mouse events, wheel
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const onMouseMove = (e: MouseEvent) => {
      const s = stateRef.current
      if (!s.rect) return
      s.mousePos = { x: e.clientX - s.rect.left, y: e.clientY - s.rect.y }
      render()
    }
    const onMouseLeave = () => {
      stateRef.current.mousePos = null
      render()
    }
    const onWheel = (e: WheelEvent) => {
      const s = stateRef.current
      const bigger = e.deltaY < 0
      const idx = s.zoomLevels.indexOf(s.numToShow)
      if (idx < 0) return
      if (bigger && idx > 0) s.numToShow = s.zoomLevels[idx - 1]
      else if (!bigger && idx + 1 < s.zoomLevels.length) s.numToShow = s.zoomLevels[idx + 1]
      else return
      storeLocal(lastCandleZoomLevelLK, s.numToShow)
      render()
    }

    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)
    canvas.addEventListener('wheel', onWheel, { passive: true })

    const observer = new ResizeObserver(() => {
      resize()
      render()
    })
    observer.observe(parent)

    resize()
    render()

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [resize, render])

  // Re-render when data/market change
  useEffect(() => {
    resize()
    render()
  }, [data, market, darkMode, resize, render])

  return <canvas ref={canvasRef} />
}

// Internal helper: draw x-axis grid lines
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

// Internal helper: draw y-axis grid lines
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

// Internal helper: draw x-axis labels
function plotXLabels (xLabelsRegion: Region, labels: LabelSet, minX: number, maxX: number, theme: Theme) {
  const extents = new Extents(minX, maxX, 0, 1)
  xLabelsRegion.plot(extents, (ctx, tools) => {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '14px \'sans\', sans-serif'
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
