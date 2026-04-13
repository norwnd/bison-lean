import { useRef, useEffect } from 'react'
import { useUIStore } from '../../stores/useUIStore'
import { Extents, Region, clamp } from './chartUtils'

interface WaveProps {
  message?: string
  backgroundColor?: string | boolean
}

export function Wave ({ message, backgroundColor }: WaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const darkMode = useUIStore(s => s.darkMode)
  const animRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const colorShift = Math.random() * 360
    const period = 1500
    const startTime = Math.random() * period

    const amplitudes = [1, 0.65, 0.75]
    const ks = [3, 3, 2]
    const speeds = [Math.PI, Math.PI * 10 / 9, Math.PI / 2.5]
    const phases = [0, 0, Math.PI * 1.5]
    const n = 75

    const single = (idx: number, angularX: number, angularTime: number): number => {
      return amplitudes[idx] * Math.cos(ks[idx] * angularX + speeds[idx] * angularTime + phases[idx])
    }
    const waveValue = (x: number, angularTime: number): number => {
      const angularX = x * Math.PI * 2
      return (single(0, angularX, angularTime) + single(1, angularX, angularTime) + single(2, angularX, angularTime)) / 3
    }

    let region: Region
    let msgRegion: Region | null = null
    let fontSize = 12

    const doResize = () => {
      canvas.width = parent.clientWidth
      canvas.height = parent.clientHeight
      const [maxW, maxH] = [150, 100]
      const [cw, ch] = [canvas.width, canvas.height]
      let [w, h] = [cw * 0.8, ch * 0.8]
      if (w > maxW) w = maxW
      if (h > maxH) h = maxH
      let [l, t] = [(cw - w) / 2, (ch - h) / 2]
      if (message) {
        fontSize = clamp(h * 0.15, 10, 14)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = `${fontSize}px 'sans', sans-serif`
        const ypad = fontSize * 0.5
        const halfH = (fontSize / 2) + ypad
        t -= halfH
        msgRegion = new Region(ctx, new Extents(0, cw, t + h, t + h + 2 * halfH))
      }
      region = new Region(ctx, new Extents(l, l + w, t, t + h))
    }

    doResize()

    const hsl = (h: number) => `hsl(${h}, 35%, 50%)`

    const drawFrame = () => {
      const angularTime = (new Date().getTime() - startTime) / period * Math.PI * 2
      const values: number[] = []
      for (let i = 0; i < n; i++) {
        values.push(waveValue(i / (n - 1), angularTime))
      }

      if (!region) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const bg = backgroundColor
      if (bg) {
        if (bg === true) ctx.fillStyle = darkMode ? '#0a1e34' : '#f0f0f0'
        else ctx.fillStyle = bg as string
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      region.plot(new Extents(0, 1, -1, 1), (plotCtx, t) => {
        plotCtx.lineWidth = 4
        plotCtx.lineCap = 'round'
        const shift = colorShift + (new Date().getTime() % 2000) / 2000 * 360
        const grad = plotCtx.createLinearGradient(t.x(0), 0, t.x(1), 0)
        grad.addColorStop(0, hsl(shift))
        plotCtx.strokeStyle = grad
        plotCtx.beginPath()
        plotCtx.moveTo(t.x(0), t.y(values[0]))
        for (let i = 1; i < values.length; i++) {
          const prog = i / (values.length - 1)
          grad.addColorStop(prog, hsl(prog * 300 + shift))
          plotCtx.lineTo(t.x(prog), t.y(values[i]))
        }
        plotCtx.stroke()
      })

      if (message && msgRegion) {
        msgRegion.plot(new Extents(0, 1, 0, 1), (msgCtx, t) => {
          msgCtx.textAlign = 'center'
          msgCtx.textBaseline = 'middle'
          msgCtx.font = `${fontSize}px 'sans', sans-serif`
          msgCtx.fillStyle = darkMode ? '#b1b1b1' : '#1b1b1b'
          msgCtx.fillText(message!, t.x(0.5), t.y(0.5), msgRegion!.width())
        })
      }

      animRef.current = requestAnimationFrame(drawFrame)
    }

    const observer = new ResizeObserver(() => doResize())
    observer.observe(parent)

    animRef.current = requestAnimationFrame(drawFrame)

    return () => {
      cancelAnimationFrame(animRef.current)
      observer.disconnect()
    }
  }, [message, backgroundColor, darkMode])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, zIndex: 5, width: '100%', height: '100%' }}
    />
  )
}
