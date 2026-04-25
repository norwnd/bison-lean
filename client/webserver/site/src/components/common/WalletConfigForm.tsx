import { useState, useCallback, useImperativeHandle, forwardRef, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import type { ConfigOption } from '../../stores/types'
import { useAuthStore } from '../../stores/useAuthStore'
import { logoPath } from '../../hooks/useFormatters'

// --- Utility helpers (ported from forms.ts) ---

function isTruthyString (s: string): boolean {
  return s === '1' || s.toLowerCase() === 'true'
}

function toUnixDate (date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function dateApplyOffset (date: Date): Date {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
}

function dateToString (date: Date): string {
  return dateApplyOffset(date).toISOString().split('T')[0]
}

// --- Types ---

export interface WalletConfigFormHandle {
  getConfigMap: (assetID: number) => Record<string, string>
  setLoadedConfig: (cfg: Record<string, string>) => void
  update: (assetID: number, configOpts: ConfigOption[], activeOrders: boolean) => void
}

interface ConfigElement {
  id: string
  opt: ConfigOption
  value: string
  checked: boolean
}

interface Props {
  assetID: number
  configOpts: ConfigOption[]
  sectionize: boolean
  activeOrders: boolean
  showFileSelector?: boolean
  onFileSelect?: () => void
}

let dynamicInputCounter = 0

function nextID (): string {
  return 'wcfg-' + String(++dynamicInputCounter)
}

function getMinMaxVal (minMax: string | number | null | undefined): string {
  if (!minMax) return ''
  if (minMax === 'now') return dateToString(new Date())
  return dateToString(new Date((minMax as number) * 1000))
}

function defaultDateValue (opt: ConfigOption): string {
  const date = opt.default ? new Date(opt.default * 1000) : new Date()
  return dateToString(date)
}

function defaultTextValue (opt: ConfigOption): string {
  return opt.default !== null && opt.default !== undefined ? String(opt.default) : ''
}

// Build initial ConfigElement entries for an option, respecting repeatN.
function buildElements (opt: ConfigOption): ConfigElement[] {
  if (opt.repeatable) {
    const count = Math.max(opt.repeatN ?? 1, 1)
    return Array.from({ length: count }, () => ({
      id: nextID(),
      opt,
      value: defaultTextValue(opt),
      checked: false,
    }))
  }
  return [{
    id: nextID(),
    opt,
    value: opt.isboolean ? '' : opt.isdate ? defaultDateValue(opt) : defaultTextValue(opt),
    checked: opt.isboolean ? Boolean(opt.default) : false,
  }]
}

export const WalletConfigForm = forwardRef<WalletConfigFormHandle, Props>(function WalletConfigForm (
  { assetID, configOpts: propConfigOpts, sectionize, activeOrders, showFileSelector = false },
  ref
) {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const assets = useAuthStore(s => s.assets)
  const hiddenFields = user?.extensionModeConfig?.restrictedWallets?.[String(assetID)]?.hiddenFields ?? []

  // Internal state managed by the parent via handle methods OR by props.
  const [, setCurrentAssetID] = useState(assetID)
  const [configOpts, setConfigOpts] = useState<ConfigOption[]>(propConfigOpts)
  const [hasActiveOrders, setHasActiveOrders] = useState(activeOrders)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // configElements: the full list of dynamic input elements.
  const [configElements, setConfigElements] = useState<ConfigElement[]>(() => {
    const elems: ConfigElement[] = []
    for (const opt of propConfigOpts) {
      elems.push(...buildElements(opt))
    }
    return elems
  })

  // Split elements into primary (required-no-default + loaded-from-saved-config)
  // and "defaulted" (using their default value, untouched by the user).
  // loadedKeys is updated by setLoadedConfig so saved values surface alongside
  // required opts at the top of the form rather than getting buried under
  // "default settings".
  const primaryElements: ConfigElement[] = []
  const defaultedElements: ConfigElement[] = []
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(new Set())

  for (const el of configElements) {
    if (sectionize && el.opt.default !== null && el.opt.default !== undefined && !loadedKeys.has(el.id)) {
      defaultedElements.push(el)
    } else {
      primaryElements.push(el)
    }
  }

  // --- Element value setters ---

  const updateElement = useCallback((id: string, patch: Partial<ConfigElement>) => {
    setConfigElements(prev => prev.map(el => el.id === id ? { ...el, ...patch } : el))
  }, [])

  const addRepeatableEntry = useCallback((afterId: string, opt: ConfigOption) => {
    setConfigElements(prev => {
      const idx = prev.findIndex(el => el.id === afterId)
      const newEl: ConfigElement = {
        id: nextID(),
        opt,
        value: '',
        checked: false,
      }
      const next = [...prev]
      next.splice(idx + 1, 0, newEl)
      return next
    })
  }, [])

  // --- Imperative handle ---

  const setConfig = useCallback((cfg: Record<string, string>) => {
    const handledRepeatables: Record<string, boolean> = {}
    setConfigElements(prev => {
      let next = [...prev]
      const toRemove: string[] = []
      for (const el of [...next]) {
        const v = cfg[el.opt.key]
        if (v === undefined) continue
        if (el.opt.repeatable) {
          if (handledRepeatables[el.opt.key]) {
            toRemove.push(el.id)
            continue
          }
          handledRepeatables[el.opt.key] = true
          const vals = v.split(el.opt.repeatable)
          // Set first value on existing element.
          next = next.map(e => e.id === el.id ? { ...e, value: vals[0] } : e)
          // Add additional entries for remaining values.
          const idx = next.findIndex(e => e.id === el.id)
          const extras: ConfigElement[] = []
          for (let i = 1; i < vals.length; i++) {
            extras.push({
              id: nextID(),
              opt: el.opt,
              value: vals[i],
              checked: false,
            })
          }
          // Also pad out to repeatN if needed.
          const minCount = Math.max(el.opt.repeatN ?? 1, 1)
          while (extras.length < minCount - 1) {
            extras.push({
              id: nextID(),
              opt: el.opt,
              value: '',
              checked: false,
            })
          }
          next.splice(idx + 1, 0, ...extras)
          continue
        }
        const input = next.find(e => e.id === el.id)
        if (!input) continue
        if (el.opt.isboolean) {
          next = next.map(e => e.id === el.id ? { ...e, checked: isTruthyString(v) } : e)
        } else if (el.opt.isdate) {
          next = next.map(e => e.id === el.id ? { ...e, value: dateToString(new Date(parseInt(v) * 1000)) } : e)
        } else {
          next = next.map(e => e.id === el.id ? { ...e, value: v } : e)
        }
      }
      return next.filter(el => !toRemove.includes(el.id))
    })
  }, [])

  useImperativeHandle(ref, () => ({
    getConfigMap (queryAssetID: number): Record<string, string> {
      const config: Record<string, string> = {}
      for (const el of configElements) {
        const { opt } = el
        if (opt.regAsset !== undefined && opt.regAsset !== queryAssetID) continue
        if (opt.isboolean && opt.key) {
          config[opt.key] = el.checked ? '1' : '0'
        } else if (opt.isdate && opt.key) {
          const minDate = el.opt.min ? toUnixDate(new Date(getMinMaxVal(el.opt.min) + 'T00:00')) : Number.MIN_SAFE_INTEGER
          const maxDate = el.opt.max ? toUnixDate(new Date(getMinMaxVal(el.opt.max) + 'T00:00')) : Number.MAX_SAFE_INTEGER
          let date = el.value ? toUnixDate(new Date(el.value + 'T00:00')) : 0
          if (date < minDate) date = minDate
          else if (date > maxDate) date = maxDate
          config[opt.key] = String(date)
        } else if (el.value) {
          if (opt.repeatable && config[opt.key]) {
            config[opt.key] += opt.repeatable + el.value
          } else {
            config[opt.key] = el.value
          }
        }
      }
      return config
    },
    setLoadedConfig (cfg: Record<string, string>) {
      setConfig(cfg)
      if (!sectionize) return
      // Track which element IDs got values from the loaded config so the
      // bucketing logic keeps them in the primary section instead of pushing
      // them into "default settings" (where they'd be hidden among
      // never-touched options).
      setConfigElements(prev => {
        const ids = new Set<string>()
        for (const el of prev) {
          if (cfg[el.opt.key] !== undefined) ids.add(el.id)
        }
        setLoadedKeys(ids)
        return prev
      })
    },
    update (newAssetID: number, newConfigOpts: ConfigOption[], newActiveOrders: boolean) {
      setCurrentAssetID(newAssetID)
      setConfigOpts(newConfigOpts)
      setHasActiveOrders(newActiveOrders)
      setError('')
      setLoadedKeys(new Set())
      const elems: ConfigElement[] = []
      for (const opt of newConfigOpts) {
        elems.push(...buildElements(opt))
      }
      setConfigElements(elems)
    },
  }), [configElements, sectionize, setConfig])

  // --- File input handler ---

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError('')
    const files = e.target.files
    if (!files || files.length === 0) return
    const configText = await files[0].text()
    if (!configText) return
    const res = await postJSON('/api/parseconfig', { configtext: configText })
    if (!checkResponse(res)) {
      setError(res.msg)
      return
    }
    if (!res.map || Object.keys(res.map).length === 0) return
    setConfig(res.map)
  }, [setConfig])

  // --- Rendering helpers ---

  const renderInput = (el: ConfigElement) => {
    const { opt } = el
    const isHidden = hiddenFields.includes(opt.key)
    const isDisabled = Boolean(opt.disablewhenactive && hasActiveOrders)
    const regAssetSymbol = opt.regAsset !== undefined ? assets[opt.regAsset]?.symbol : undefined

    const label = (
      <label htmlFor={el.id} title={opt.description || undefined}>
        {regAssetSymbol && (
          <img src={logoPath(regAssetSymbol)} width={15} height={15} alt="" className="me-1" />
        )}
        {opt.displayname}
      </label>
    )

    if (opt.isboolean) {
      return (
        <div key={el.id} className="form-check mb-2" style={isHidden ? { display: 'none' } : undefined}>
          <input
            id={el.id}
            type="checkbox"
            className="form-check-input"
            checked={el.checked}
            disabled={isDisabled}
            onChange={e => updateElement(el.id, { checked: e.target.checked })}
          />
          <label
            className="form-check-label"
            htmlFor={el.id}
            title={opt.description || undefined}
          >
            {opt.displayname}
          </label>
        </div>
      )
    }

    if (opt.isdate) {
      return (
        <div key={el.id} className="mb-2" style={isHidden ? { display: 'none' } : undefined}>
          {label}
          <input
            id={el.id}
            type="date"
            className="form-control"
            value={el.value}
            min={getMinMaxVal(opt.min)}
            max={getMinMaxVal(opt.max)}
            disabled={isDisabled}
            onChange={e => updateElement(el.id, { value: e.target.value })}
          />
        </div>
      )
    }

    if (opt.repeatable) {
      return (
        <div key={el.id} className="mb-2 repeatable" style={isHidden ? { display: 'none' } : undefined}>
          {label}
          <div className="d-flex align-items-center gap-1">
            <input
              id={el.id}
              type={opt.noecho ? 'password' : 'text'}
              autoComplete={opt.noecho ? 'off' : undefined}
              className="form-control"
              value={el.value}
              disabled={isDisabled}
              onChange={e => updateElement(el.id, { value: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => addRepeatableEntry(el.id, opt)}
              title={t('ADD')}
            >
              +
            </button>
          </div>
        </div>
      )
    }

    // Default: text input.
    return (
      <div key={el.id} className="mb-2" style={isHidden ? { display: 'none' } : undefined}>
        {label}
        <input
          id={el.id}
          type={opt.noecho ? 'password' : 'text'}
          autoComplete={opt.noecho ? 'off' : undefined}
          className="form-control"
          value={el.value}
          disabled={isDisabled}
          onChange={e => updateElement(el.id, { value: e.target.value })}
        />
      </div>
    )
  }

  // If no config options, hide entirely.
  if (configOpts.length === 0) return null

  return (
    <div>
      {/* Primary (non-defaulted) options */}
      {primaryElements.length > 0 && (
        <div className="dynamic-opts">
          {primaryElements.map(renderInput)}
        </div>
      )}

      {/* File selector for config file upload */}
      {showFileSelector && (
        <div className="mb-2">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            {t('SELECT_CONFIG_FILE')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="d-none"
            onChange={handleFileChange}
          />
        </div>
      )}

      {error && (
        <div className="fs15 text-danger mb-2">{error}</div>
      )}

      {/* Options using their default value, rendered below the actively-set
          ones. Always visible — no collapse toggle. */}
      {defaultedElements.length > 0 && (
        <div className="other-settings">
          <div className="fs15 text-secondary mb-1">{t('DEFAULT_SETTINGS')}</div>
          {defaultedElements.map(renderInput)}
        </div>
      )}
    </div>
  )
})

export default WalletConfigForm
