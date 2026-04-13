import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useMMStore } from '../stores/useMMStore'
import { useNotifications } from '../hooks/useNotifications'
import { postJSON, checkResponse } from '../services/api'
import { ROUTES } from '../router/routes'
import type {
  BalanceNote,
  CEXNotification,
  MarketWithHost,
} from '../stores/types'

const botTypeBasicMM = 'basicMM'
const botTypeArbMM = 'arbMM'
const botTypeBasicArb = 'basicArb'

const botTypeLabels: Record<string, string> = {
  [botTypeBasicMM]: 'Basic MM',
  [botTypeArbMM]: 'Arb MM',
  [botTypeBasicArb]: 'Simple Arb',
}

const CEXDisplayInfos: Record<string, { name: string; logo: string }> = {
  Binance: { name: 'Binance', logo: '/img/binance.com.png' },
  BinanceUS: { name: 'Binance U.S.', logo: '/img/binance.us.png' },
  Bitget: { name: 'Bitget', logo: '/img/bitget.com.png' },
  Coinbase: { name: 'Coinbase', logo: '/img/coinbase.com.png' },
  MEXC: { name: 'MEXC', logo: '/img/mexc.com.png' },
}

const logoPath = (sym: string) => {
  const b = sym.split('.')[0]
  return `/img/coins/${b === 'weth' ? 'eth' : b}.png`
}

interface AvailableMarket {
  host: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
}

/*
 * MMSettingsPage is a TEMPORARY implementation.
 *
 * The full MMSettings React component from the vanilla codebase
 * (src/js/mmsettings/components/MMSettings.tsx) has not been migrated
 * yet. This page provides basic market selection, bot type picking,
 * and start/stop controls until that migration happens.
 */
export default function MMSettingsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const mmStatus = useAuthStore(s => s.mmStatus)
  const { fetchMMStatus } = useMMStore()
  const fetchUser = useAuthStore(s => s.fetchUser)

  // Read specs from URL search params.
  const paramHost = searchParams.get('host') ?? ''
  const paramBaseID = searchParams.get('baseID') ?? ''
  const paramQuoteID = searchParams.get('quoteID') ?? ''
  const paramBotType = searchParams.get('botType') ?? ''
  const paramCexName = searchParams.get('cexName') ?? ''

  const hasSpecs = Boolean(paramHost && paramBaseID && paramQuoteID)

  // Form state.
  const [selectedHost, setSelectedHost] = useState(paramHost)
  const [selectedBaseID, setSelectedBaseID] = useState(paramBaseID ? parseInt(paramBaseID) : 0)
  const [selectedQuoteID, setSelectedQuoteID] = useState(paramQuoteID ? parseInt(paramQuoteID) : 0)
  const [selectedBotType, setSelectedBotType] = useState(paramBotType || botTypeBasicMM)
  const [selectedCexName, setSelectedCexName] = useState(paramCexName)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  // Current bot status for this market.
  const currentBot = useMemo(() => {
    if (!mmStatus?.bots || !selectedHost || !selectedBaseID || !selectedQuoteID) return undefined
    return mmStatus.bots.find(b =>
      b.config.host === selectedHost &&
      b.config.baseID === selectedBaseID &&
      b.config.quoteID === selectedQuoteID
    )
  }, [mmStatus, selectedHost, selectedBaseID, selectedQuoteID])

  const isRunning = currentBot?.running ?? false

  // Build available markets from exchanges.
  const availableMarkets = useMemo(() => {
    const markets: AvailableMarket[] = []
    for (const [host, exchange] of Object.entries(exchanges)) {
      if (exchange.auth.effectiveTier + exchange.auth.pendingStrength === 0) continue
      for (const [, market] of Object.entries(exchange.markets)) {
        if (!assets[market.baseid] || !assets[market.quoteid]) continue
        markets.push({
          host,
          baseID: market.baseid,
          quoteID: market.quoteid,
          baseSymbol: market.basesymbol,
          quoteSymbol: market.quotesymbol,
        })
      }
    }
    return markets
  }, [exchanges, assets])

  // Connected CEXes.
  const connectedCexes = useMemo(() => {
    if (!mmStatus?.cexes) return []
    return Object.entries(mmStatus.cexes)
      .filter(([, s]) => s.connected)
      .map(([name]) => name)
  }, [mmStatus?.cexes])

  // Auto-select first market if no specs.
  useEffect(() => {
    if (!hasSpecs && availableMarkets.length > 0 && !selectedHost) {
      const m = availableMarkets[0]
      setSelectedHost(m.host)
      setSelectedBaseID(m.baseID)
      setSelectedQuoteID(m.quoteID)
    }
  }, [hasSpecs, availableMarkets, selectedHost])

  // WS subscriptions.
  const noteHandlers = useMemo(() => ({
    balance: (_note: BalanceNote) => {
      // Could refresh balances display here if needed.
    },
    cexnote: (_note: CEXNotification) => {
      fetchMMStatus()
    },
  }), [fetchMMStatus])

  useNotifications(noteHandlers)

  const handleMarketChange = useCallback((marketKey: string) => {
    const parts = marketKey.split('|')
    if (parts.length < 3) return
    setSelectedHost(parts[0])
    setSelectedBaseID(parseInt(parts[1]))
    setSelectedQuoteID(parseInt(parts[2]))
    setError('')
    setStatusMsg('')
  }, [])

  const startBot = useCallback(async () => {
    if (!selectedHost || !selectedBaseID || !selectedQuoteID) {
      setError(t('Please select a market'))
      return
    }
    setError('')
    setLoading(true)
    setStatusMsg('')
    try {
      const market: MarketWithHost = {
        host: selectedHost,
        baseID: selectedBaseID,
        quoteID: selectedQuoteID,
      }
      const resp = await postJSON('/api/startmarketmakingbot', { config: market })
      if (!checkResponse(resp)) {
        throw new Error(resp.msg || 'Failed to start bot')
      }
      setStatusMsg(t('Bot started successfully'))
      await fetchMMStatus()
      await fetchUser()
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [selectedHost, selectedBaseID, selectedQuoteID, fetchMMStatus, fetchUser, t])

  const stopBot = useCallback(async () => {
    setError('')
    setLoading(true)
    setStatusMsg('')
    try {
      const market: MarketWithHost = {
        host: selectedHost,
        baseID: selectedBaseID,
        quoteID: selectedQuoteID,
      }
      const resp = await postJSON('/api/stopmarketmakingbot', { market })
      if (!checkResponse(resp)) {
        throw new Error(resp.msg || 'Failed to stop bot')
      }
      setStatusMsg(t('Bot stopped successfully'))
      await fetchMMStatus()
      await fetchUser()
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [selectedHost, selectedBaseID, selectedQuoteID, fetchMMStatus, fetchUser, t])

  const selectedBase = assets[selectedBaseID]
  const selectedQuote = assets[selectedQuoteID]

  return (
    <div className="page-view p-3">
      {/* Header */}
      <div className="d-flex align-items-center gap-2 mb-3">
        <button className="btn btn-secondary" onClick={() => navigate(ROUTES.MM)}>
          {t('Back')}
        </button>
        <h2 className="mb-0">{t('Bot Configuration')}</h2>
        <span className="badge bg-warning text-dark ms-2">{t('TEMPORARY')}</span>
      </div>

      <div className="text-secondary mb-3">
        {t('This is a temporary configuration page. The full settings UI is pending migration.')}
      </div>

      {/* Market Selection */}
      <div className="card mb-3">
        <div className="card-body">
          <h5 className="card-title">{t('Market')}</h5>

          <div className="mb-3">
            <label className="form-label">{t('Select Market')}</label>
            <select
              className="form-select"
              value={`${selectedHost}|${selectedBaseID}|${selectedQuoteID}`}
              onChange={e => handleMarketChange(e.target.value)}
              disabled={hasSpecs}
            >
              <option value="">{t('-- Select --')}</option>
              {availableMarkets.map(m => {
                const key = `${m.host}|${m.baseID}|${m.quoteID}`
                return (
                  <option key={key} value={key}>
                    {m.baseSymbol.toUpperCase()}/{m.quoteSymbol.toUpperCase()} @ {m.host}
                  </option>
                )
              })}
            </select>
          </div>

          {selectedBase && selectedQuote && (
            <div className="d-flex align-items-center gap-2 mb-2">
              <img src={logoPath(selectedBase.symbol)} width={24} height={24} alt={selectedBase.symbol} />
              <img src={logoPath(selectedQuote.symbol)} width={24} height={24} alt={selectedQuote.symbol} />
              <span className="fw-bold">
                {selectedBase.unitInfo.conventional.unit}/{selectedQuote.unitInfo.conventional.unit}
              </span>
              <span className="text-secondary">@ {selectedHost}</span>
            </div>
          )}
        </div>
      </div>

      {/* Bot Type Selection */}
      <div className="card mb-3">
        <div className="card-body">
          <h5 className="card-title">{t('Bot Type')}</h5>
          <div className="d-flex gap-3">
            {Object.entries(botTypeLabels).map(([type, label]) => (
              <label key={type} className="d-flex align-items-center gap-1">
                <input
                  type="radio"
                  name="botType"
                  value={type}
                  checked={selectedBotType === type}
                  onChange={() => setSelectedBotType(type)}
                />
                {t(label)}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* CEX Selection (for arb types) */}
      {selectedBotType !== botTypeBasicMM && (
        <div className="card mb-3">
          <div className="card-body">
            <h5 className="card-title">{t('CEX')}</h5>
            {connectedCexes.length === 0
              ? (
                <div className="text-warning">
                  {t('No CEX configured. Go to the')} <a href={ROUTES.MM}>{t('MM page')}</a> {t('to configure an exchange.')}
                </div>
                )
              : (
                <select
                  className="form-select"
                  value={selectedCexName}
                  onChange={e => setSelectedCexName(e.target.value)}
                >
                  <option value="">{t('-- Select CEX --')}</option>
                  {connectedCexes.map(name => (
                    <option key={name} value={name}>
                      {CEXDisplayInfos[name]?.name ?? name}
                    </option>
                  ))}
                </select>
                )
            }
          </div>
        </div>
      )}

      {/* Status / Actions */}
      <div className="card mb-3">
        <div className="card-body">
          <h5 className="card-title">{t('Status')}</h5>

          {currentBot && (
            <div className="mb-2">
              <span className="me-2">{t('Bot status')}:</span>
              {isRunning
                ? <span className="text-success fw-bold">{t('Running')}</span>
                : <span className="text-secondary">{t('Idle (configured)')}</span>
              }
            </div>
          )}
          {!currentBot && selectedHost && (
            <div className="mb-2 text-secondary">{t('No existing configuration for this market.')}</div>
          )}

          {error && <div className="text-danger mb-2">{error}</div>}
          {statusMsg && <div className="text-success mb-2">{statusMsg}</div>}

          <div className="d-flex gap-2">
            {!isRunning && (
              <button
                className="btn btn-success"
                onClick={startBot}
                disabled={loading || !selectedHost}
              >
                {loading ? '...' : t('Start Bot')}
              </button>
            )}
            {isRunning && (
              <button
                className="btn btn-danger"
                onClick={stopBot}
                disabled={loading}
              >
                {loading ? '...' : t('Stop Bot')}
              </button>
            )}
            <button
              className="btn btn-outline-secondary"
              onClick={() => navigate(ROUTES.MM)}
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
