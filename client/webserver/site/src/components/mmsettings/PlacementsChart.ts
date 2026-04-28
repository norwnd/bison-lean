// PlacementsChart - canvas visualisation of MM buy/sell placements
// ported from vanilla `mmutil.ts` (L240-403).
//
// Vanilla extended a shared `Chart` base class (`js/charts.ts`) that
// carried a lot of candle-chart-only state (zoom, wheel, visibility
// pause/unpause, mouse tracking, grid regions). PlacementsChart uses
// almost none of that, so this port inlines the small subset it
// actually needs - canvas+ctx setup, theme, ResizeObserver, plus the
// `line()` / `applyLabelStyle()` / `clear()` helpers. Reuses `Extents`,
// `Region`, `Translator`, `clamp`, `Theme` from the shared
// `components/charts/chartUtils.ts` module.
//
// The React wrapper (`PlacementsChartWrapper`) creates an instance,
// feeds it a `PlacementChartConfig` via `setMarket()`, and tears it
// down via `destroy()` on unmount.

import {
  Extents, Region, Translator, Theme,
  darkTheme, lightTheme, clamp, line as drawLine
} from '../charts/chartUtils'
import type { OrderPlacement } from '../../stores/types'
import { isDark } from '../../services/state'
import { CEXDisplayInfos } from './cexDisplayInfo'
import { botTypeBasicMM, botTypeBasicArb } from './botTypes'

export interface PlacementChartConfig {
  cexName: string
  botType: string
  baseFiatRate: number
  dict: {
    profit: number
    buyPlacements: OrderPlacement[]
    sellPlacements: OrderPlacement[]
  }
}

export class PlacementsChart {
  parent: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  theme: Theme
  cfg: PlacementChartConfig | null
  loadedCEX: string
  cexLogo: HTMLImageElement | null
  resizeObserver: ResizeObserver

  constructor (parent: HTMLElement) {
    this.parent = parent
    this.theme = isDark() ? darkTheme : lightTheme
    this.canvas = document.createElement('canvas')
    parent.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) {
      throw new Error('PlacementsChart: failed to acquire 2D canvas context')
    }
    this.ctx = ctx
    this.ctx.textAlign = 'center'
    this.ctx.textBaseline = 'middle'
    this.cfg = null
    this.loadedCEX = ''
    this.cexLogo = null

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.parent)
  }

  destroy () {
    this.resizeObserver.disconnect()
    if (this.canvas.parentElement === this.parent) {
      this.parent.removeChild(this.canvas)
    }
  }

  private resize () {
    this.canvas.width = this.parent.clientWidth
    this.canvas.height = this.parent.clientHeight
    this.render()
  }

  private clear () {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private line (x0: number, y0: number, x1: number, y1: number, skipStroke?: boolean) {
    drawLine(this.ctx, x0, y0, x1, y1, skipStroke)
  }

  private applyLabelStyle (fontSize?: number) {
    this.ctx.textAlign = 'center'
    this.ctx.textBaseline = 'middle'
    this.ctx.font = `${fontSize ?? 14}px 'sans', sans-serif`
    this.ctx.fillStyle = this.theme.axisLabel
  }

  setMarket (cfg: PlacementChartConfig) {
    this.cfg = cfg
    const { loadedCEX, cfg: { cexName } } = this
    if (cexName && cexName !== loadedCEX) {
      this.loadedCEX = cexName
      this.cexLogo = new Image()
      this.cexLogo.addEventListener('load', () => { this.render() })
      const info = CEXDisplayInfos[cexName]
      this.cexLogo.src = info ? info.logo : ''
    }
    this.render()
  }

  render () {
    const { ctx, canvas, theme, cfg } = this
    if (canvas.width === 0 || !cfg) return
    const { dict: { buyPlacements, sellPlacements, profit }, baseFiatRate, botType } = cfg
    if (botType === botTypeBasicArb) return

    this.clear()

    const drawDashedLine = (x0: number, y0: number, x1: number, y1: number, color: string) => {
      ctx.save()
      ctx.setLineDash([3, 5])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = color
      this.line(x0, y0, x1, y1)
      ctx.restore()
    }

    const isBasicMM = botType === botTypeBasicMM
    const cx = canvas.width / 2
    const [cexGapL, cexGapR] = isBasicMM ? [cx, cx] : [0.48 * canvas.width, 0.52 * canvas.width]

    const buyLots = buyPlacements.reduce((v: number, p: OrderPlacement) => v + p.lots, 0)
    const sellLots = sellPlacements.reduce((v: number, p: OrderPlacement) => v + p.lots, 0)
    const maxLots = Math.max(buyLots, sellLots)

    let widest = 0
    let fauxSpacer = 0
    if (isBasicMM) {
      const leftmost = buyPlacements.reduce((v: number, p: OrderPlacement) => Math.max(v, p.gapFactor), 0)
      const rightmost = sellPlacements.reduce((v: number, p: OrderPlacement) => Math.max(v, p.gapFactor), 0)
      widest = Math.max(leftmost, rightmost)
    } else {
      // For arb-mm, we don't know how the orders will be spaced because it
      // depends on the vwap. But we're just trying to capture the general sense
      // of how the parameters will affect order placement, so we'll fake it.
      // Higher match buffer values will lead to orders with less favorable
      // rates, e.g. the spacing will be larger.
      const ps = [...buyPlacements, ...sellPlacements]
      const matchBuffer = ps.reduce((sum: number, p: OrderPlacement) => sum + p.gapFactor, 0) / ps.length
      fauxSpacer = 0.01 * (1 + matchBuffer)
      widest = Math.min(10, Math.max(buyPlacements.length, sellPlacements.length)) * fauxSpacer // arb-mm
    }

    // Make the range 15% on each side, which will include profit + placements,
    // unless they have orders with larger gap factors.
    const minRange = profit + widest
    const defaultRange = 0.155
    const range = Math.max(minRange * 1.05, defaultRange)

    // Increase data height logarithmically up to 1,000,000 USD.
    const maxCommitUSD = maxLots * baseFiatRate
    const regionHeight = 0.2 + 0.7 * Math.log(clamp(maxCommitUSD, 0, 1e6)) / Math.log(1e6)

    // Draw a region in the middle representing the cex gap.
    const plotRegion = new Region(ctx, new Extents(0, canvas.width, 0, canvas.height))

    if (isBasicMM) {
      drawDashedLine(cx, 0, cx, canvas.height, theme.gapLine)
    } else { // arb-mm
      plotRegion.plot(new Extents(0, 1, 0, 1), (ctx: CanvasRenderingContext2D, tools: Translator) => {
        const [y0, y1] = [tools.y(0), tools.y(1)]
        drawDashedLine(cexGapL, y0, cexGapL, y1, theme.gapLine)
        drawDashedLine(cexGapR, y0, cexGapR, y1, theme.gapLine)
        const y = tools.y(0.95)
        if (this.cexLogo && this.cexLogo.complete && this.cexLogo.naturalWidth > 0) {
          ctx.drawImage(this.cexLogo, cx - 8, y, 16, 16)
        }
        this.applyLabelStyle(18)
        ctx.fillText('δ', cx, y + 29)
      })
    }

    const plotSide = (isBuy: boolean, placements: OrderPlacement[]) => {
      if (!placements?.length) return
      const [xMin, xMax] = isBuy ? [0, cexGapL] : [cexGapR, canvas.width]
      const reg = new Region(ctx, new Extents(xMin, xMax, canvas.height * (1 - regionHeight), canvas.height))

      // Calculate actual range needed for placements to touch the border
      let actualRange = range
      if (isBuy && placements.length > 0) {
        const maxGapFactor = Math.max(...placements.map(p => isBasicMM ? p.gapFactor : profit + (placements.indexOf(p) + 1) * fauxSpacer))
        actualRange = Math.max(range, maxGapFactor)
      }

      const [l, r] = isBuy ? [-actualRange, 0] : [0, range]
      reg.plot(new Extents(l, r, 0, maxLots), (ctx: CanvasRenderingContext2D, tools: Translator) => {
        ctx.lineWidth = 2.5
        ctx.strokeStyle = isBuy ? theme.buyLine : theme.sellLine
        ctx.fillStyle = isBuy ? theme.buyFill : theme.sellFill
        ctx.beginPath()
        const sideFactor = isBuy ? -1 : 1
        const y0 = tools.y(0)

        // For buy side, start from the left border to ensure it touches
        if (isBuy) {
          ctx.moveTo(tools.x(-actualRange), y0)
        }

        let cumulativeLots = 0
        for (let i = 0; i < placements.length; i++) {
          const p = placements[i]
          // For arb-mm, we don't know exactly
          const rawX = isBasicMM ? p.gapFactor : profit + (i + 1) * fauxSpacer
          const x = tools.x(rawX * sideFactor)
          if (i === 0 && !isBuy) {
            // For sell side, start from first placement
            ctx.moveTo(x, y0)
          }
          ctx.lineTo(x, tools.y(cumulativeLots))
          cumulativeLots += p.lots
          ctx.lineTo(x, tools.y(cumulativeLots))
        }
        const xInfinity = isBuy ? canvas.width * -0.1 : canvas.width * 1.1
        ctx.lineTo(xInfinity, tools.y(cumulativeLots))
        ctx.stroke()
        ctx.lineTo(xInfinity, y0)
        if (isBuy) {
          ctx.lineTo(tools.x(-actualRange), y0)
        } else {
          const firstPt = placements[0]
          const firstX = tools.x((isBasicMM ? firstPt.gapFactor : profit + fauxSpacer) * sideFactor)
          ctx.lineTo(firstX, y0)
        }
        ctx.closePath()
        ctx.globalAlpha = 0.25
        ctx.fill()
      }, true)
    }

    plotSide(false, sellPlacements)
    plotSide(true, buyPlacements)
  }
}
