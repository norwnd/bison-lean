// Small form primitives ported from vanilla
// `mmsettings/components/FormComponents.tsx`.
//
// - `PanelHeader`: section heading with optional "settings" button
// - `NumberInput`: numeric text input with optional arrow buttons and
//   optional companion slider (either below or inline)
// - `IconButton`: icon-only clickable span
// - `ErrorMessage`: self-dismissing inline error
// - `LoadingSpinner`: fullscreen-ish overlay with Bootstrap spinner
//
// The vanilla `prep(ID_MM_LOADING)` dictionary lookup becomes an
// `useTranslation('MM_LOADING')` call — the key already exists in
// `i18n/en-US.json`.

import React from 'react'
import { useTranslation } from 'react-i18next'

interface PanelHeaderProps {
  title: string
  description?: string
  buttonText?: string
  onClick?: () => void
}

export const PanelHeader: React.FC<PanelHeaderProps> = ({ title, description, buttonText, onClick }) => {
  return (
    <div className="pb-2 my-2 border-bottom">
      <div className="d-flex justify-content-start lh1 align-items-center">
        <span className="fs20 demi pt-pt5 me-4">{title}</span>
        {buttonText && onClick && (
          <button className="small" onClick={onClick}>
            <span className="ico-settings fs14 me-1"></span>
            {buttonText}
          </button>
        )}
      </div>
      {description && (
        <div className="mt-2">
          <span className="fs14 text-muted">{description}</span>
        </div>
      )}
    </div>
  )
}

interface NumberInputProps {
  value?: number;
  onChange: (num: number) => void;
  min?: number;
  max?: number;
  precision?: number;
  className?: string;
  // If onIncrement and onDecrement are provided, the component will show up
  // and down arrows. They receive the current parsed/clamped input value
  // so callers compute the next value from it rather than from a
  // closed-over (and potentially stale) prop — prevents the "type 5,
  // click +" race where the typed value is lost.
  onIncrement?: (current: number) => void;
  onDecrement?: (current: number) => void;
  suffix?: string;
  disabled?: boolean;
  withSlider?: boolean;
  sliderPosition?: 'below' | 'inline';
}

export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  onChange,
  min,
  max,
  precision = 0,
  className = 'p-2 text-center fs20',
  suffix,
  onIncrement,
  onDecrement,
  withSlider = false,
  disabled = false,
  sliderPosition = 'below'
}) => {
  const [inputValue, setInputValue] = React.useState<string>(value !== undefined ? value.toFixed(precision) : '')
  const [isDragging, setIsDragging] = React.useState(false)
  const sliderRef = React.useRef<HTMLDivElement>(null)

  // Sync `inputValue` when the committed `value` prop changes externally.
  // `inputValue` is intentionally omitted from the dep array: including it
  // would re-fire the effect on every keystroke and overwrite what the
  // user is typing with the stale prop value.
  React.useEffect(() => {
    const formattedValue = value !== undefined ? value.toFixed(precision) : ''
    if (inputValue !== formattedValue) {
      setInputValue(formattedValue)
    }
  }, [value, precision])

  // Parse the raw input string into a numeric value, clamped to [min,max]
  // and rounded to `precision`. Returns null for empty/invalid input.
  const parseClamped = React.useCallback((raw: string): number | null => {
    if (raw === '') return null
    const numericValue = parseFloat(raw)
    if (isNaN(numericValue)) return null
    let clampedValue = numericValue
    if (min !== undefined) clampedValue = Math.max(min, clampedValue)
    if (max !== undefined) clampedValue = Math.min(max, clampedValue)
    return parseFloat(clampedValue.toFixed(precision))
  }, [min, max, precision])

  const commitInputValue = React.useCallback(() => {
    const parsed = parseClamped(inputValue)
    if (parsed === null) {
      const formattedValue = value !== undefined ? value.toFixed(precision) : ''
      setInputValue(formattedValue)
      return
    }
    setInputValue(parsed.toFixed(precision))
    if (parsed !== value) {
      onChange(parsed)
    }
  }, [inputValue, parseClamped, precision, value, onChange])

  // Current value the arrow buttons should operate on — the user's
  // typed-but-not-blurred input takes precedence over the last committed
  // `value` prop, so clicking +/- after typing works on the typed value.
  const currentValue = React.useCallback((): number => {
    const parsed = parseClamped(inputValue)
    return parsed !== null ? parsed : (value ?? 0)
  }, [parseClamped, inputValue, value])

  const handleIncrement = React.useCallback(() => {
    if (disabled) return
    onIncrement?.(currentValue())
  }, [disabled, onIncrement, currentValue])

  const handleDecrement = React.useCallback(() => {
    if (disabled) return
    onDecrement?.(currentValue())
  }, [disabled, onDecrement, currentValue])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitInputValue();
      (e.target as HTMLInputElement).blur()
    }
  }

  const getPercentage = React.useCallback(() => {
    if (value === undefined || min === undefined || max === undefined || max === min) return 0
    return ((value - min) / (max - min)) * 100
  }, [value, min, max])

  const getValueFromPercentage = React.useCallback((percentage: number) => {
    if (min === undefined || max === undefined) return 0
    const clampedPercentage = Math.max(0, Math.min(100, percentage))
    const rawValue = min + (clampedPercentage / 100) * (max - min)
    return parseFloat(rawValue.toFixed(precision))
  }, [min, max, precision])

  const handleSliderInteraction = React.useCallback((clientX: number) => {
    if (disabled || !sliderRef.current) return
    const rect = sliderRef.current.getBoundingClientRect()
    const percentage = ((clientX - rect.left) / rect.width) * 100
    const newValue = getValueFromPercentage(percentage)
    setInputValue(newValue.toFixed(precision))
    onChange(newValue)
  }, [disabled, getValueFromPercentage, onChange, precision])

  const handleSliderClick = (e: React.MouseEvent) => {
    handleSliderInteraction(e.clientX)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled) return
    setIsDragging(true)
    e.preventDefault()
  }

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!isDragging) return
    handleSliderInteraction(e.clientX)
  }, [isDragging, handleSliderInteraction])

  const handleMouseUp = React.useCallback(() => {
    setIsDragging(false)
  }, [])

  React.useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  // Dev-time guard. Placed after all hooks so its short-circuit return
  // doesn't change the hook call count across renders.
  if (withSlider && (min === undefined || max === undefined)) {
    console.error('The props `min` and `max` must be provided when `withSlider` is true.')
    return null
  }

  const hasArrows = onIncrement && onDecrement

  const thumbClass = `mm-slider-thumb${disabled ? ' disabled' : ''}${isDragging ? ' dragging' : ''}`
  const trackClass = `mm-slider-track w-100${disabled ? ' disabled' : ''}`

  if (withSlider && sliderPosition === 'inline') {
    return (
      <div className="d-flex align-items-center flex-grow-1">
        <div className="flex-grow-1 position-relative me-2">
          <div
            ref={sliderRef}
            className={trackClass}
            onClick={handleSliderClick}
          />
          <div
            className={thumbClass}
            style={{
              left: `${getPercentage()}%`
            }}
            onMouseDown={handleMouseDown}
          />
        </div>
        <div className="d-flex align-items-center flex-shrink-0" style={{ width: '6rem' }}>
          <input
            type="text"
            inputMode="decimal"
            className={`${className} flex-grow-1`}
            style={{ minWidth: 0 }}
            value={inputValue}
            disabled={disabled}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={commitInputValue}
          />
          {suffix && <span className="fs14 ms-1">{suffix}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="d-flex flex-column align-items-stretch">
      <div className="d-flex align-items-center">
        <div className="flex-grow-1">
          <input
            type="text"
            inputMode="decimal"
            className={`${className} w-100`}
            value={inputValue}
            disabled={disabled}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={commitInputValue}
          />
          {withSlider && (
            <div className="position-relative mt-2">
              <div
                ref={sliderRef}
                className={trackClass}
                onClick={handleSliderClick}
              />
              <div
                className={thumbClass}
                style={{
                  left: `${getPercentage()}%`
                }}
                onMouseDown={handleMouseDown}
              />
            </div>
          )}
        </div>

        {hasArrows && (
          <div className="d-flex flex-column align-items-stretch ms-2">
            <div
              className="flex-grow-1 flex-center px-2 hoverbg pointer user-select-none lh1 ico-arrowup"
              onClick={disabled ? undefined : handleIncrement}
            />
            <div
              className="flex-grow-1 flex-center px-2 hoverbg pointer user-select-none lh1 ico-arrowdown"
              onClick={disabled ? undefined : handleDecrement}
            />
          </div>
        )}
        {suffix && <span className="fs24 ms-2">{suffix}</span>}
      </div>

    </div>
  )
}

interface IconButtonProps {
  iconClass: string
  onClick: () => void
  size?: string
  ariaLabel: string
  className?: string
}

export const IconButton: React.FC<IconButtonProps> = ({ iconClass, onClick, size = 'fs15', ariaLabel, className = 'pointer px-2' }) => {
  return (
    <span
      className={`${iconClass} ${size} ${className}`}
      onClick={onClick}
      role="button"
      aria-label={ariaLabel}
    ></span>
  )
}

interface ErrorMessageProps {
  message: string
  onClear?: () => void
  timeout?: number
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ message, onClear, timeout = 5000 }) => {
  React.useEffect(() => {
    if (message && onClear) {
      const timer = setTimeout(onClear, timeout)
      return () => clearTimeout(timer)
    }
  }, [message, onClear, timeout])

  if (!message) return null
  return <div className="text-danger fs14 text-center py-2">{message}</div>
}

interface LoadingSpinnerProps {
  isLoading: boolean
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ isLoading }) => {
  const { t } = useTranslation()
  if (!isLoading) return null

  return (
    <div className="mm-loading-overlay">
      <div className="spinner-border text-primary" role="status" style={{ width: '3rem', height: '3rem' }}>
        <span className="visually-hidden">{t('MM_LOADING')}</span>
      </div>
    </div>
  )
}
