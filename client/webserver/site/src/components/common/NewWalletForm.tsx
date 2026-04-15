import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { WalletConfigForm } from './WalletConfigForm'
import type { WalletConfigFormHandle } from './WalletConfigForm'
import type {
  SupportedAsset,
  WalletInfo,
  WalletDefinition,
  Token,
  ConfigOption,
} from '../../stores/types'

// --- Utility ---

function toUnixDate (date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function logoPath (symbol: string): string {
  symbol = symbol.split('.')[0]
  if (symbol === 'weth') symbol = 'eth'
  return `/img/coins/${symbol}.png`
}

interface CurrentAsset {
  asset: SupportedAsset
  winfo: WalletInfo | Token
  selectedDef: WalletDefinition
}

interface Props {
  assetID: number
  onSuccess: (assetID: number) => void
  onBack?: () => void
}

export function NewWalletForm ({ assetID, onSuccess, onBack }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const seedGenTime = useAuthStore(s => s.seedGenTime)

  const subformRef = useRef<WalletConfigFormHandle>(null)

  const [current, setCurrent] = useState<CurrentAsset | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [password, setPassword] = useState('')
  const [selectedTabIdx, setSelectedTabIdx] = useState(0)
  const [configOpts, setConfigOpts] = useState<ConfigOption[]>([])
  const [showFileSelector, setShowFileSelector] = useState(false)
  const [showPasswordBox, setShowPasswordBox] = useState(false)
  const [showSettingsHeader, setShowSettingsHeader] = useState(false)
  const [showOneBttn, setShowOneBttn] = useState(false)
  const [guideLink, setGuideLink] = useState('')

  // T18#13: previously declared a `createUpdater` useState that was
  // always null and a `useNotifications({ createwallet })` handler
  // whose body never fired because of the null check. Dead code from
  // an earlier refactor -- deleted. If we ever need wallet-creation
  // progress callbacks (e.g. DCR SPV sync progress), wire them up
  // fresh via useNotifications directly.

  // Parse asset data from store.
  const parseAsset = useCallback((id: number): CurrentAsset | null => {
    const asset = assets[id]
    if (!asset) return null
    const token = asset.token
    if (!token) {
      if (!asset.info) return null
      return { asset, winfo: asset.info, selectedDef: asset.info.availablewallets[0] }
    }
    const parentAsset = assets[token.parentID]
    if (parentAsset?.wallet) {
      return { asset, winfo: token, selectedDef: token.definition }
    }
    if (!parentAsset?.info) return null
    return { asset, winfo: token, selectedDef: parentAsset.info.availablewallets[0] }
  }, [assets])

  // Update the form for a given wallet definition.
  const updateDef = useCallback(async (cur: CurrentAsset, walletDef: WalletDefinition) => {
    const opts = walletDef.configopts || []
    // If a config represents a wallet's birthday and the seed was recently
    // generated (within the last minute), default to now.
    const recentSeed = seedGenTime > 0 && (Date.now() / 1000 - seedGenTime) < 60
    const processedOpts = opts.map(opt => {
      if (opt.isBirthdayConfig && recentSeed) {
        return { ...opt, default: toUnixDate(new Date()) }
      }
      return opt
    })

    let containsRequired = false
    for (const opt of processedOpts) {
      if (opt.required) { containsRequired = true; break }
    }

    const { asset } = cur
    const displayCreateBtn = walletDef.seeded || Boolean(asset.token)

    if (displayCreateBtn && !containsRequired) {
      setShowSettingsHeader(false)
      setShowOneBttn(true)
      setShowPasswordBox(false)
    } else if (displayCreateBtn) {
      setShowSettingsHeader(true)
      setShowOneBttn(false)
      setShowPasswordBox(false)
    } else {
      setShowSettingsHeader(true)
      setShowOneBttn(false)
      setShowPasswordBox(!walletDef.noauth)
    }

    setConfigOpts(processedOpts)
    setShowFileSelector(!walletDef.seeded && !asset.token)
    setGuideLink(walletDef.guidelink || '')

    // Update subform.
    subformRef.current?.update(asset.id, processedOpts, false)

    // Load defaults from server if a config path exists.
    if (walletDef.configpath) {
      const res = await postJSON('/api/defaultwalletcfg', {
        assetID: asset.id,
        type: walletDef.type,
      })
      if (checkResponse(res) && res.config) {
        subformRef.current?.setLoadedConfig(res.config)
      }
    }
  }, [seedGenTime])

  // Set asset when assetID prop changes.
  useEffect(() => {
    const cur = parseAsset(assetID)
    if (!cur) return
    setCurrent(cur)
    setPassword('')
    setError('')
    setSelectedTabIdx(0)
    updateDef(cur, cur.selectedDef)
  }, [assetID, parseAsset, updateDef])

  // Get wallet definitions list.
  const walletDefs: WalletDefinition[] = (() => {
    if (!current) return []
    const { winfo } = current
    if ((winfo as WalletInfo).availablewallets) return (winfo as WalletInfo).availablewallets
    return [(winfo as Token).definition]
  })()

  const handleTabClick = (idx: number, wDef: WalletDefinition) => {
    if (!current) return
    setSelectedTabIdx(idx)
    const updated = { ...current, selectedDef: wDef }
    setCurrent(updated)
    updateDef(updated, wDef)
  }

  const submit = async () => {
    if (!current) return
    setError('')
    setLoading(true)
    const { asset, selectedDef } = current
    const config = subformRef.current?.getConfigMap(asset.id) ?? {}
    const createForm = {
      assetID: asset.id,
      pass: password,
      config,
      walletType: selectedDef.type,
    }
    const res = await postJSON('/api/newwallet', createForm)
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to create wallet')
      return
    }
    setPassword('')
    onSuccess(asset.id)
  }

  if (!current) return null

  const { asset, winfo } = current

  return (
    <div>
      {/* Back button */}
      {onBack && (
        <button type="button" className="btn btn-sm btn-link p-0 mb-2" onClick={onBack}>
          &larr; {t('Back')}
        </button>
      )}

      {/* Header: logo + asset name */}
      <div className="d-flex align-items-center gap-2 mb-3">
        <img src={logoPath(asset.symbol)} alt={asset.symbol} width={30} height={30} />
        <span className="fs18 fw-bold">{winfo.name}</span>
      </div>

      {/* Wallet type tabs */}
      {walletDefs.length > 1 && (
        <div className="d-flex gap-1 mb-3">
          {walletDefs.map((wDef, idx) => (
            <button
              key={wDef.type}
              type="button"
              className={`btn btn-sm ${idx === selectedTabIdx ? 'btn-primary' : 'btn-outline-secondary'}`}
              title={wDef.description}
              onClick={() => handleTabClick(idx, wDef)}
            >
              {wDef.tab}
            </button>
          ))}
        </div>
      )}

      {/* Guide link */}
      {guideLink && (
        <div className="mb-2">
          <a href={guideLink} target="_blank" rel="noopener noreferrer" className="fs14">
            {t('Wallet setup guide')}
          </a>
        </div>
      )}

      {/* Settings header */}
      {showSettingsHeader && (
        <div className="fs15 fw-bold mb-2">{t('Wallet Settings')}</div>
      )}

      {/* Wallet config sub-form */}
      <WalletConfigForm
        ref={subformRef}
        assetID={asset.id}
        configOpts={configOpts}
        sectionize={true}
        activeOrders={false}
        showFileSelector={showFileSelector}
      />

      {/* Password input */}
      {showPasswordBox && (
        <div className="mb-2">
          <label htmlFor="newWalletPass">{t('Wallet Password')}</label>
          <input
            id="newWalletPass"
            type="password"
            className="form-control"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="fs15 text-danger mb-2">{error}</div>
      )}

      {/* Submit button */}
      {showOneBttn
? (
        <div>
          <button
            type="button"
            className="btn btn-primary w-100"
            onClick={submit}
            disabled={loading}
          >
            {loading ? '...' : t('CREATE')}
          </button>
        </div>
      )
: (
        <div>
          <button
            type="button"
            className="btn btn-primary w-100"
            onClick={submit}
            disabled={loading}
          >
            {loading ? '...' : (current.selectedDef.seeded || Boolean(asset.token) ? t('CREATE') : t('ADD'))}
          </button>
        </div>
      )}
    </div>
  )
}

export default NewWalletForm
