import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useMMStore } from '../stores/useMMStore'
import { useNotifications } from '../hooks/useNotifications'
import { shortSymbol, logoPath } from '../hooks/useFormatters'
import { startBot as apiStartBot, stopBot as apiStopBot } from '../services/mmApi'
import { fetchLocal, storeLocal, lastMMSpecsLK } from '../services/state'
import { CEXDisplayInfos } from '../components/mmsettings/cexDisplayInfo'
import { botTypeBasicMM, botTypeArbMM, botTypeBasicArb } from '../components/mmsettings/botTypes'
import { ROUTES } from '../router/routes'
import type {
  BalanceNote,
  CEXNotification,
  MarketWithHost,
  MMCEXStatus,
} from '../stores/types'

interface MMSpecs {
  host: string
  baseID: number
  quoteID: number
  botType: string
  cexName: string
}

// MMS-03: minimal direct-market check used to filter the CEX dropdown
// down to exchanges that actually trade the selected market. This is a
// smaller-scope subset of vanilla's `cexSupportsArbOnMarket()`
// (`mmsettings/components/MMSettings.tsx` L84-180) which also walks
// bridge paths and intermediate-asset multi-hop routes. The bridge-
// aware version requires the bridgePaths data that hasn't been ported
// to the React stores yet -- it'll arrive with the full MMS-01 stub
// migration. Until then, the direct check is strictly better than
// "show every connected CEX regardless".
function cexSupportsMarketDirect (cexStatus: MMCEXStatus, baseID: number, quoteID: number): boolean {
  for (const m of Object.values(cexStatus.markets ?? {})) {
    if (m.baseID === baseID && m.quoteID === quoteID) return true
    if (m.baseID === quoteID && m.quoteID === baseID) return true
  }
  return false
}

const botTypeLabels: Record<string, string> = {
  [botTypeBasicMM]: 'Basic MM',
  [botTypeArbMM]: 'Arb MM',
  [botTypeBasicArb]: 'Simple Arb',
}

interface AvailableMarket {
  host: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
  // MMS-04: 24h volume in base-asset atoms (used for sort + future
  // display). May be 0 when the market has no spot data yet.
  vol24: number
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
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
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
  // MMS-02: skip exchanges where the user isn't registered
  // (effectiveTier + pendingStrength === 0). Mirrors vanilla
  // `mmsettings.ts` `loadAvailableMarkets()` (L47-50). Already in
  // place since the initial rewrite -- documented here for
  // traceability against the audit item.
  // MMS-04: sort markets by USD-equivalent 24h volume descending so
  // the most active markets surface first. Mirrors vanilla
  // `mmsettings.ts` (L88-96) which multiplies `spot.vol24` by the
  // base asset's fiat rate before sorting.
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
          vol24: market.spot?.vol24 ?? 0,
        })
      }
    }
    markets.sort((a, b) => {
      const rateA = fiatRatesMap[a.baseID] ?? 0
      const rateB = fiatRatesMap[b.baseID] ?? 0
      // When both rates are present, compare USD-equivalent volumes;
      // otherwise fall back to raw vol24 so the sort still produces
      // a meaningful order for less-liquid assets without fiat data.
      const usdA = rateA > 0 ? a.vol24 * rateA : a.vol24
      const usdB = rateB > 0 ? b.vol24 * rateB : b.vol24
      return usdB - usdA
    })
    return markets
  }, [exchanges, assets, fiatRatesMap])

  // Connected CEXes that actually trade the currently selected market.
  // MMS-03: vanilla's full check is `cexSupportsArbOnMarket()` which
  // also walks bridge paths and intermediate-asset routes. The
  // bridge-aware version arrives with the full MMS-01 stub migration;
  // until then the direct check still cuts out CEXes that don't have
  // the market at all.
  //
  // A pre-existing `selectedCexName` (from URL params or persisted
  // specs) is always kept in the dropdown even if it would otherwise
  // be filtered out -- a bot configured against a CEX that supports
  // the market via bridges (which our simplified check can't see)
  // shouldn't have its CEX silently dropped on revisit.
  const connectedCexes = useMemo(() => {
    if (!mmStatus?.cexes) return []
    const allConnected = Object.entries(mmStatus.cexes)
      .filter(([, s]) => s.connected)
    if (!selectedBaseID || !selectedQuoteID) {
      return allConnected.map(([name]) => name)
    }
    const filtered = allConnected
      .filter(([, s]) => cexSupportsMarketDirect(s, selectedBaseID, selectedQuoteID))
      .map(([name]) => name)
    if (selectedCexName &&
        !filtered.includes(selectedCexName) &&
        allConnected.some(([name]) => name === selectedCexName)) {
      filtered.push(selectedCexName)
    }
    return filtered
  }, [mmStatus?.cexes, selectedBaseID, selectedQuoteID, selectedCexName])

  // MMS-05: restore lastMMSpecs from localStorage when no URL specs
  // were provided. Mirrors vanilla `mmsettings.ts` (L19, L33-40)
  // which calls `State.fetchLocal(specLK)` to seed the form. If the
  // persisted market is still in `availableMarkets`, use it;
  // otherwise fall back to the first available market.
  useEffect(() => {
    if (hasSpecs || selectedHost) return
    const saved = fetchLocal(lastMMSpecsLK) as MMSpecs | null
    if (saved && availableMarkets.some(m => m.host === saved.host && m.baseID === saved.baseID && m.quoteID === saved.quoteID)) {
      setSelectedHost(saved.host)
      setSelectedBaseID(saved.baseID)
      setSelectedQuoteID(saved.quoteID)
      if (saved.botType) setSelectedBotType(saved.botType)
      if (saved.cexName) setSelectedCexName(saved.cexName)
      return
    }
    if (availableMarkets.length > 0) {
      const m = availableMarkets[0]
      setSelectedHost(m.host)
      setSelectedBaseID(m.baseID)
      setSelectedQuoteID(m.quoteID)
    }
  }, [hasSpecs, availableMarkets, selectedHost])

  // MMS-05: persist the current spec selection to localStorage
  // whenever it changes, so the form survives navigation/reloads.
  useEffect(() => {
    if (!selectedHost || !selectedBaseID || !selectedQuoteID) return
    const specs: MMSpecs = {
      host: selectedHost,
      baseID: selectedBaseID,
      quoteID: selectedQuoteID,
      botType: selectedBotType,
      cexName: selectedCexName,
    }
    storeLocal(lastMMSpecsLK, specs)
  }, [selectedHost, selectedBaseID, selectedQuoteID, selectedBotType, selectedCexName])

  // WS subscriptions.
  const noteHandlers = useMemo(() => ({
    // MMS-06: wire the balance handler to refresh mmStatus so the
    // displayed bot status / CEX balances stay in sync. The full
    // balance-display refresh requires the MMS-01 stub migration --
    // until then `fetchMMStatus()` is the closest data refresh we
    // can trigger without a deeper port.
    balance: (_note: BalanceNote) => {
      fetchMMStatus()
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
    // MMS-07: pre-check that the user has a non-zero trading tier on
    // the selected exchange before round-tripping to the API. The
    // backend will reject the start anyway if the user can't post
    // bonds, but surfacing the check here gives immediate feedback
    // without a server round trip and uses an actionable message.
    const exchange = exchanges[selectedHost]
    const tier = (exchange?.auth?.effectiveTier ?? 0) + (exchange?.auth?.pendingStrength ?? 0)
    if (tier <= 0) {
      setError(t('You need a non-zero trading tier on this DEX to start a bot. Register or top up bonds first.'))
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
      const resp = await apiStartBot(market)
      if (!resp.ok) {
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
  }, [selectedHost, selectedBaseID, selectedQuoteID, exchanges, fetchMMStatus, fetchUser, t])

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
      const resp = await apiStopBot(market)
      if (!resp.ok) {
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
                    {shortSymbol(m.baseSymbol)}/{shortSymbol(m.quoteSymbol)} @ {m.host}
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
