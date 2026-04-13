import { useState, useRef, useCallback } from 'react'
import { XYRange } from '../../stores/types'

const threeSigFigs = new Intl.NumberFormat(navigator.languages as string[], {
  maximumSignificantDigits: 3,
  useGrouping: false
})

function clamp (v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

interface Props {
  range: XYRange
  initVal: number
  roundX?: boolean
  roundY?: boolean
  disabled?: boolean
  onUpdated?: (x: number, y: number) => void
  onChanged?: () => void
}

export function XYRangeHandler ({ range, initVal, roundX, roundY, disabled, onUpdated, onChanged }: Props) {
  const rangeX = range.end.x - range.start.x
  const rangeY = range.end.y - range.start.y
  const normalizeX = (x: number) => (x - range.start.x) / rangeX

  const initR = normalizeX(initVal)
  const initY = initR * rangeY + range.start.y

  const [xVal, setXVal] = useState(initVal)
  const [yVal, setYVal] = useState(initY)
  const [r, setR] = useState(initR)
  const [editingX, setEditingX] = useState(false)
  const [editingY, setEditingY] = useState(false)
  const [xInputVal, setXInputVal] = useState('')
  const [yInputVal, setYInputVal] = useState('')

  const sliderRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)

  const apply = useCallback((newR: number, emit = true) => {
    const newX = roundX ? Math.round(newR * rangeX + range.start.x) : newR * rangeX + range.start.x
    const newY = roundY ? Math.round(newR * rangeY + range.start.y) : newR * rangeY + range.start.y
    setR(clamp(newR, 0, 1))
    setXVal(newX)
    setYVal(newY)
    if (emit && onUpdated) onUpdated(newX, newY)
  }, [range, rangeX, rangeY, roundX, roundY, onUpdated])

  const commitXInput = useCallback(() => {
    if (disabled) return
    const parsed = parseFloat(xInputVal)
    if (!isNaN(parsed)) {
      const clamped = clamp(parsed, range.start.x, range.end.x)
      const newR = normalizeX(clamped)
      apply(newR)
      if (onChanged) onChanged()
    }
    setEditingX(false)
  }, [xInputVal, disabled, range, apply, onChanged, normalizeX])

  const commitYInput = useCallback(() => {
    if (disabled) return
    const parsed = parseFloat(yInputVal)
    if (!isNaN(parsed)) {
      const newY = clamp(parsed, range.start.y, range.end.y)
      const newR = (newY - range.start.y) / rangeY
      apply(newR)
      if (onChanged) onChanged()
    }
    setEditingY(false)
  }, [yInputVal, disabled, range, rangeY, apply, onChanged])

  // Mouse drag on handle
  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const slider = sliderRef.current
    const handle = handleRef.current
    if (!slider || !handle) return

    const startPageX = e.pageX
    const w = slider.clientWidth - handle.offsetWidth
    const startLeft = r * w

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const newR = clamp((startLeft + (ev.pageX - startPageX)) / w, 0, 1)
      apply(newR)
    }
    const onMouseUp = (ev: MouseEvent) => {
      ev.preventDefault()
      const newR = clamp((startLeft + (ev.pageX - startPageX)) / w, 0, 1)
      apply(newR)
      if (onChanged) onChanged()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [disabled, r, apply, onChanged])

  // Click on slider track
  const onSliderClick = useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return
    const slider = sliderRef.current
    if (!slider) return
    const rect = slider.getBoundingClientRect()
    const newR = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    apply(newR)
    if (onChanged) onChanged()
  }, [disabled, apply, onChanged])

  const rEffective = clamp(r, 0, 1)
  const handleLeft = `calc(${rEffective * 100}% - ${rEffective * 14}px)`

  return (
    <div className={`xy-range-handler${disabled ? ' disabled' : ''}`}>
      <div className="d-flex justify-content-between align-items-center mb-1">
        <span className="fs14">{range.start.label}</span>
        <span className="fs14">{range.end.label}</span>
      </div>

      <div
        className="slider-box position-relative"
        style={{ height: '20px', cursor: disabled ? 'default' : 'pointer' }}
        onClick={onSliderClick}
      >
        <div
          ref={sliderRef}
          className="slider position-relative"
          style={{ height: '4px', background: '#555', borderRadius: '2px', top: '8px' }}
        >
          <div
            ref={handleRef}
            className="handle position-absolute"
            style={{
              width: '14px', height: '14px', borderRadius: '50%',
              background: '#2e9f67', top: '-5px', cursor: disabled ? 'default' : 'grab',
              left: handleLeft
            }}
            onMouseDown={onHandleMouseDown}
          />
        </div>
      </div>

      <div className="d-flex justify-content-between align-items-center mt-1">
        <div className="d-flex align-items-center gap-1">
          {editingX
? (
            <input
              type="text"
              className="fs14"
              style={{ width: '60px' }}
              value={xInputVal}
              autoFocus
              onChange={e => setXInputVal(e.target.value)}
              onBlur={commitXInput}
              onKeyDown={e => { if (e.key === 'Enter') commitXInput() }}
            />
          )
: (
            <span
              className="fs14 pointer"
              onClick={() => {
                if (disabled) return
                setXInputVal(threeSigFigs.format(xVal))
                setEditingX(true)
              }}
            >
              {threeSigFigs.format(xVal)}
            </span>
          )}
          <span className="fs12 grey">{range.xUnit}</span>
        </div>

        <div className="d-flex align-items-center gap-1">
          {editingY
? (
            <input
              type="text"
              className="fs14"
              style={{ width: '60px' }}
              value={yInputVal}
              autoFocus
              onChange={e => setYInputVal(e.target.value)}
              onBlur={commitYInput}
              onKeyDown={e => { if (e.key === 'Enter') commitYInput() }}
            />
          )
: (
            <span
              className="fs14 pointer"
              onClick={() => {
                if (disabled) return
                setYInputVal(threeSigFigs.format(yVal))
                setEditingY(true)
              }}
            >
              {roundY ? String(Math.round(yVal)) : threeSigFigs.format(yVal)}
            </span>
          )}
          <span className="fs12 grey">{range.yUnit}</span>
        </div>
      </div>
    </div>
  )
}

// Expose current values via a hook for parent components
export function useXYRangeValue (range: XYRange, initVal: number) {
  const rangeX = range.end.x - range.start.x
  const rangeY = range.end.y - range.start.y
  const initR = (initVal - range.start.x) / rangeX

  const [x, setX] = useState(initVal)
  const [y, setY] = useState(initR * rangeY + range.start.y)

  const onUpdated = useCallback((newX: number, newY: number) => {
    setX(newX)
    setY(newY)
  }, [])

  return { x, y, onUpdated }
}
