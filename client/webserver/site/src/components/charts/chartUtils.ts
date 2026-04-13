// Shared chart utilities ported from src/js/charts.ts and src/js/doc.ts

const FPS = 30

export interface Point {
  x: number
  y: number
}

export interface MinMax {
  min: number
  max: number
}

export interface Label {
  val: number
  txt: string
}

export interface LabelSet {
  widest: number
  lbls: Label[]
}

export interface Translator {
  x: (x: number) => number
  y: (y: number) => number
  unx: (x: number) => number
  uny: (y: number) => number
  w: (w: number) => number
  h: (h: number) => number
}

export class Extents {
  x: MinMax
  y: MinMax

  constructor (xMin: number, xMax: number, yMin: number, yMax: number) {
    this.setExtents(xMin, xMax, yMin, yMax)
  }

  setExtents (xMin: number, xMax: number, yMin: number, yMax: number) {
    this.x = { min: xMin, max: xMax }
    this.y = { min: yMin, max: yMax }
  }

  get xRange (): number { return this.x.max - this.x.min }
  get midX (): number { return (this.x.max + this.x.min) / 2 }
  get yRange (): number { return this.y.max - this.y.min }
  get midY (): number { return (this.y.max + this.y.min) / 2 }
}

export class Region {
  context: CanvasRenderingContext2D
  extents: Extents

  constructor (context: CanvasRenderingContext2D, extents: Extents) {
    this.context = context
    this.extents = extents
  }

  setExtents (xMin: number, xMax: number, yMin: number, yMax: number) {
    this.extents.setExtents(xMin, xMax, yMin, yMax)
  }

  width (): number { return this.extents.xRange }
  height (): number { return this.extents.yRange }

  contains (x: number, y: number): boolean {
    const ext = this.extents
    return (x < ext.x.max && x > ext.x.min && y < ext.y.max && y > ext.y.min)
  }

  translator (dataExtents: Extents): Translator {
    const region = this.extents
    const xMin = dataExtents.x.min
    const yMin = dataExtents.y.min
    const yRange = dataExtents.yRange
    const xRange = dataExtents.xRange
    const screenMinX = region.x.min
    const screenW = region.x.max - screenMinX
    const screenMaxY = region.y.max
    const screenH = screenMaxY - region.y.min
    const xFactor = screenW / xRange
    const yFactor = screenH / yRange
    return {
      x: (x: number) => (x - xMin) * xFactor + screenMinX,
      y: (y: number) => screenMaxY - (y - yMin) * yFactor,
      unx: (x: number) => (x - screenMinX) / xFactor + xMin,
      uny: (y: number) => yMin - (y - screenMaxY) / yFactor,
      w: (w: number) => w / xRange * screenW,
      h: (h: number) => -h / yRange * screenH
    }
  }

  clear () {
    const ext = this.extents
    this.context.clearRect(ext.x.min, ext.y.min, ext.xRange, ext.yRange)
  }

  plot (dataExtents: Extents, drawFunc: (ctx: CanvasRenderingContext2D, tools: Translator) => void, skipMask?: boolean) {
    const ctx = this.context
    const region = this.extents
    ctx.save()
    if (!skipMask) {
      ctx.beginPath()
      ctx.rect(region.x.min, region.y.min, region.xRange, region.yRange)
      ctx.clip()
    }
    const tools = this.translator(dataExtents)
    drawFunc(this.context, tools)
    ctx.restore()
  }
}

// Animation class ported from doc.ts
const Easing: Record<string, (t: number) => number> = {
  linear: t => t,
  easeIn: t => t * t,
  easeOut: t => t * (2 - t),
  easeInHard: t => t * t * t,
  easeOutHard: t => (--t) * t * t + 1,
  easeOutElastic: t => {
    const c4 = (2 * Math.PI) / 3
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  }
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class Animation {
  done: (() => void) | undefined
  endAnimation: boolean
  thread: Promise<void>
  static Forever = -1

  constructor (duration: number, f: (progress: number) => void, easingAlgo?: string, done?: () => void) {
    this.done = done
    this.thread = this.run(duration, f, easingAlgo)
  }

  async run (duration: number, f: (progress: number) => void, easingAlgo?: string) {
    duration = duration >= 0 ? duration : 1000 * 86400 * 365 * 10
    const easer = easingAlgo ? Easing[easingAlgo] : Easing.linear
    const start = new Date().getTime()
    const end = (duration === Animation.Forever) ? Number.MAX_SAFE_INTEGER : start + duration
    const range = end - start
    const frameDuration = 1000 / FPS
    let now = start
    this.endAnimation = false
    while (now < end) {
      if (this.endAnimation) return this.runCompletionFunction()
      f(easer((now - start) / range))
      await sleep(frameDuration)
      now = new Date().getTime()
    }
    f(1)
    return this.runCompletionFunction()
  }

  async wait () { await this.thread }
  stop () { this.endAnimation = true }
  async stopAndWait () { this.stop(); await this.wait() }

  runCompletionFunction () {
    if (this.done) this.done()
  }
}

// Theme definitions
export interface Theme {
  body: string
  axisLabel: string
  gridBorder: string
  gridLines: string
  gapLine: string
  value: string
  zoom: string
  zoomHover: string
  sellLine: string
  buyLine: string
  sellFill: string
  buyFill: string
  crosshairs: string
  legendFill: string
  legendText: string
}

export const darkTheme: Theme = {
  body: '#0b2031',
  axisLabel: '#b1b1b1',
  gridBorder: '#383f4b',
  gridLines: '#383f4b',
  gapLine: '#6b6b6b',
  value: '#9a9a9a',
  zoom: '#5b5b5b',
  zoomHover: '#aaa',
  sellLine: '#d10e0e',
  buyLine: '#2e9f67',
  sellFill: '#d10e0e',
  buyFill: '#2e9f67',
  crosshairs: '#888',
  legendFill: 'black',
  legendText: '#d5d5d5'
}

export const lightTheme: Theme = {
  body: '#f4f4f4',
  axisLabel: '#1b1b1b',
  gridBorder: '#ddd',
  gridLines: '#e8e8e8',
  gapLine: '#595959',
  value: '#4d4d4d',
  zoom: '#777',
  zoomHover: '#333',
  sellLine: '#d10e0e',
  buyLine: '#2e9f67',
  sellFill: '#d10e0e',
  buyFill: '#2e9f67',
  crosshairs: '#595959',
  legendFill: '#e6e6e6',
  legendText: '#1b1b1b'
}

// Helper drawing functions
export function line (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, skipStroke?: boolean) {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  if (!skipStroke) ctx.stroke()
}

export function dot (ctx: CanvasRenderingContext2D, x: number, y: number, color: string, radius: number) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, 2 * Math.PI)
  ctx.fill()
}

export function truncate (v: number, w: number): number {
  return v - (v % w)
}

export function clamp (v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

// Label generation helpers
export function makeYLabels (
  ctx: CanvasRenderingContext2D,
  screenHeight: number,
  min: number,
  max: number,
  spacingGuess: number,
  step: number,
  valFmt: (v: number) => string
): LabelSet {
  const n = screenHeight / spacingGuess
  const diff = max - min
  if (n < 1 || diff <= 0) return { widest: 0, lbls: [] }
  const tickGuess = diff / n
  const tick = tickGuess + step - (tickGuess % step)
  let x = min + tick - (min % tick)
  const pts: Label[] = []
  let widest = 0
  while (x < max) {
    const lbl = valFmt(x)
    widest = Math.max(widest, ctx.measureText(lbl).width)
    pts.push({ val: x, txt: lbl })
    x += tick
  }
  return { widest, lbls: pts }
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function makeCandleTimeLabels (candles: { endStamp: number }[], dur: number, screenW: number, spacingGuess: number): LabelSet {
  const first = candles[0]
  const last = candles[candles.length - 1]
  const start = truncate(first.endStamp, dur)
  const end = truncate(last.endStamp, dur) + dur
  const diff = end - start
  const n = Math.min(candles.length, screenW / spacingGuess)
  const tick = truncate(diff / n, dur)
  if (tick === 0) return { widest: 0, lbls: [] }
  let x = start
  const zoneOffset = new Date().getTimezoneOffset()
  const dayStamp = (x: number) => {
    x = x - zoneOffset * 60000
    return x - (x % 86400000)
  }
  let lastDay = dayStamp(start)
  let lastYear = 0
  if (dayStamp(first.endStamp) === dayStamp(last.endStamp)) lastDay = 0
  const pts: Label[] = []
  let label: (d: Date, x: number) => string
  if (dur < 86400000) {
    label = (d: Date, x: number) => {
      const day = dayStamp(x)
      if (day !== lastDay) return `${months[d.getMonth()]}${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  } else {
    label = (d: Date) => {
      const year = d.getFullYear()
      if (year !== lastYear) return `${months[d.getMonth()]}${d.getDate()} '${String(year).slice(2, 4)}`
      return `${months[d.getMonth()]}${d.getDate()}`
    }
  }
  while (x <= end) {
    const d = new Date(x)
    pts.push({ val: x, txt: label(d, x) })
    lastDay = dayStamp(x)
    lastYear = d.getFullYear()
    x += tick
  }
  return { widest: 0, lbls: pts }
}
