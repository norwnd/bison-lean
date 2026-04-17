import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useMMStore } from '../stores/useMMStore'
import { useNotifications } from '../hooks/useNotifications'
import { availableBalances, removeBotConfig, stopBot as apiStopBot } from '../services/mmApi'
import { formatCoinValue, formatFourSigFigs, formatFiatValue, formatProfit, shortSymbol, logoPath } from '../hooks/useFormatters'
import { FormOverlay } from '../components/common/FormOverlay'
import { CEXConfigurationForm } from '../components/common/CEXConfigurationForm'
import { CEXDisplayInfos } from '../components/mmsettings/cexDisplayInfo'
import { botTypeBasicMM, botTypeArbMM, botTypeBasicArb } from '../components/mmsettings/botTypes'
import { ROUTES } from '../router/routes'
import type {
  MMBotStatus,
  RunStatsNote,
  RunEventNote,
  EpochReportNote,
  CEXProblemsNote,
  CEXNotification,
  BotConfig,
  SupportedAsset,
  BotBalance,
  MarketWithHost,
} from '../stores/types'

function hostedMarketID (host: string, baseID: number, quoteID: number) {
  return `${host}-${baseID}-${quoteID}`
}

function botType (cfg: BotConfig): string {
  if (cfg.arbMarketMakingConfig) return botTypeArbMM
  if (cfg.simpleArbConfig) return botTypeBasicArb
  return botTypeBasicMM
}

function botTypeLabel (cfg: BotConfig, t: (k: string) => string): string {
  const bt = botType(cfg)
  if (bt === botTypeArbMM) return t('Arb MM')
  if (bt === botTypeBasicArb) return t('Simple Arb')
  return t('Basic MM')
}

interface AvailableBalances {
  dexBalances: Record<number, number>
  cexBalances: Record<number, number>
}

export default function MMPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const mmStatus = useAuthStore(s => s.mmStatus)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const { fetchMMStatus } = useMMStore()

  const [highlightedBot, setHighlightedBot] = useState<string | null>(null)
  const [showCexConfig, setShowCexConfig] = useState(false)
  const [configCexName, setConfigCexName] = useState('')
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
  const [removingBot, setRemovingBot] = useState<MarketWithHost | null>(null)
  const [removeErr, setRemoveErr] = useState('')
  const [idleBalances, setIdleBalances] = useState<Record<string, AvailableBalances>>({})
  // MM-02: per-bot reconfigure error keyed by hosted-market id. When
  // set, the bot card shows a temporary CEX-not-connected warning
  // beside the Reconfigure button. Auto-clears after 3s to match
  // vanilla `mm.ts` `reconfigure()` (L450-462) which used
  // `Doc.showTemporarily(3000, page.offError)`.
  const [reconfigErrs, setReconfigErrs] = useState<Record<string, string>>({})

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Sort bots: running first (most recent start), then idle by asset IDs.
  const sortedBots = useMemo(() => {
    if (!mmStatus?.bots) return []
    return [...mmStatus.bots].sort((a, b) => {
      if (a.running && !b.running) return -1
      if (b.running && !a.running) return 1
      if (!a.running && !b.running) {
        return (a.config.baseID + a.config.quoteID) - (b.config.baseID + b.config.quoteID)
      }
      return (b.runStats?.startTime ?? 0) - (a.runStats?.startTime ?? 0)
    })
  }, [mmStatus?.bots])

  // Fetch idle balances for non-running bots.
  useEffect(() => {
    const fetchBalances = async () => {
      const newBalances: Record<string, AvailableBalances> = {}
      for (const bot of sortedBots) {
        if (bot.running) continue
        const { host, baseID, quoteID, cexName, cexBaseID, cexQuoteID } = bot.config
        const id = hostedMarketID(host, baseID, quoteID)
        try {
          const resp = await availableBalances({ host, baseID, quoteID }, cexBaseID, cexQuoteID, cexName)
          if (resp.ok) {
            newBalances[id] = {
              dexBalances: resp.dexBalances,
              cexBalances: resp.cexBalances,
            }
          } else if (resp.msg) {
            // MM-03: surface the failure rather than swallowing it
            // silently. Used to be `catch { /* ignore */ }` which made
            // it impossible to diagnose missing balance displays.
            console.warn('availablebalances failed for bot', id, resp.msg)
          }
        } catch (e) {
          console.warn('availablebalances threw for bot', id, e)
        }
      }
      setIdleBalances(newBalances)
    }
    fetchBalances()
  }, [sortedBots])

  // WS subscriptions.
  const noteHandlers = useMemo(() => ({
    runstats: (note: RunStatsNote) => {
      useMMStore.getState().handleRunStatsNote(note)
    },
    runevent: (_note: RunEventNote) => {
      // RunEvent triggers a re-render via mmStatus update through runstats.
    },
    epochreport: (note: EpochReportNote) => {
      useMMStore.getState().handleEpochReportNote(note)
    },
    cexproblems: (note: CEXProblemsNote) => {
      useMMStore.getState().handleCEXProblemsNote(note)
    },
    cexnote: (_note: CEXNotification) => {
      // CEX balance changes - refetch status.
      fetchMMStatus()
    },
  }), [fetchMMStatus])

  useNotifications(noteHandlers)

  const handleShowBot = useCallback((botID: string) => {
    setHighlightedBot(botID)
    const el = cardRefs.current[botID]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      setTimeout(() => setHighlightedBot(null), 1500)
    }
  }, [])

  const confirmRemoveCfg = useCallback((cfg: BotConfig) => {
    setRemovingBot({ host: cfg.host, baseID: cfg.baseID, quoteID: cfg.quoteID })
    setRemoveErr('')
    setShowRemoveConfirm(true)
  }, [])

  const removeCfg = useCallback(async () => {
    if (!removingBot) { setShowRemoveConfirm(false); return }
    const resp = await removeBotConfig(removingBot.host, removingBot.baseID, removingBot.quoteID)
    if (!resp.ok) {
      setRemoveErr(resp.msg || 'Failed to remove config')
      return
    }
    setShowRemoveConfirm(false)
    setRemovingBot(null)
    await fetchMMStatus()
    await fetchUser()
  }, [removingBot, fetchMMStatus, fetchUser])

  const openCexConfig = useCallback((cexName: string) => {
    setConfigCexName(cexName)
    setShowCexConfig(true)
  }, [])

  const cexConfigured = useCallback(async (_cexName: string, success: boolean) => {
    await fetchMMStatus()
    if (success) setShowCexConfig(false)
  }, [fetchMMStatus])

  const reconfigure = useCallback((cfg: BotConfig) => {
    const bt = botType(cfg)
    // MM-02: if the bot is wired to a CEX, refuse to navigate when
    // that CEX isn't currently connected — the mmsettings page can't
    // load market data for an offline CEX. Mirrors vanilla `mm.ts`
    // `reconfigure()` (L450-462) which set
    // `page.offError.textContent = intl.prep(intl.ID_CEX_NOT_CONNECTED, ...)`
    // and showed it for 3 seconds via `Doc.showTemporarily(3000, ...)`.
    if (cfg.cexName) {
      const cex = mmStatus?.cexes?.[cfg.cexName]
      // Vanilla checks `!cex || !cex.connected` — `MMCEXStatus.connected`
      // is the canonical liveness flag.
      if (!cex || !cex.connected) {
        const id = hostedMarketID(cfg.host, cfg.baseID, cfg.quoteID)
        const msg = t('CEX_NOT_CONNECTED', { cexName: cfg.cexName })
        setReconfigErrs(prev => ({ ...prev, [id]: msg }))
        setTimeout(() => {
          setReconfigErrs(prev => {
            if (!(id in prev)) return prev
            const { [id]: _drop, ...rest } = prev
            return rest
          })
        }, 3000)
        return
      }
    }
    const params = new URLSearchParams({
      host: cfg.host,
      baseID: String(cfg.baseID),
      quoteID: String(cfg.quoteID),
      botType: bt,
    })
    if (cfg.cexName) params.set('cexName', cfg.cexName)
    navigate(`${ROUTES.MM_SETTINGS}?${params.toString()}`)
  }, [navigate, mmStatus, t])

  // MM-06: stop a running bot directly from the bot card. Vanilla
  // exposed a Stop button inside `runningBotDisplay` (`forms.tmpl`
  // L1068) wired to `MM.stopBot()` which calls `/api/stopmarketmakingbot`.
  // After success we refresh `mmStatus` + `user` so the card flips
  // from running → idle without waiting for the next WS note.
  const stopBot = useCallback(async (cfg: BotConfig) => {
    const market: MarketWithHost = { host: cfg.host, baseID: cfg.baseID, quoteID: cfg.quoteID }
    const resp = await apiStopBot(market)
    if (!resp.ok) {
      console.warn('stopmarketmakingbot failed', resp.msg)
      return
    }
    await fetchMMStatus()
    await fetchUser()
  }, [fetchMMStatus, fetchUser])

  const noBots = !sortedBots.length

  // CEX USD balance calculator.
  const cexUSDBalance = useCallback((cexName: string): number => {
    const status = mmStatus?.cexes[cexName]
    if (!status?.balances) return 0
    let usd = 0
    const seen: Record<string, boolean> = {}
    for (const [idStr, bal] of Object.entries(status.balances)) {
      const assetID = parseInt(idStr)
      const sym = assets[assetID]?.symbol?.split('.')[0]?.toLowerCase() ?? ''
      if (seen[sym]) continue
      seen[sym] = true
      const ui = assets[assetID]?.unitInfo
      const rate = fiatRatesMap[assetID]
      if (rate && ui) {
        usd += rate * (bal.available + bal.locked) / ui.conventional.conversionFactor
      }
    }
    return usd
  }, [mmStatus?.cexes, assets, fiatRatesMap])

  return (
    <div className="page-view p-3">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h2 className="mb-0">{t('Market Making')}</h2>
        <div className="d-flex gap-2">
          <button className="btn btn-outline-secondary" onClick={() => navigate(ROUTES.MM_ARCHIVES)}>
            {t('Archived Logs')}
          </button>
          <button className="btn btn-primary" onClick={() => navigate(ROUTES.MM_SETTINGS)}>
            {t('New Bot')}
          </button>
        </div>
      </div>

      {/* CEX Exchanges Table */}
      <h5 className="mb-2">{t('Exchanges')}</h5>
      <table className="table mb-4">
        <thead>
          <tr>
            <th>{t('Exchange')}</th>
            <th>{t('Status')}</th>
            <th>{t('Balance (USD)')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(CEXDisplayInfos).map(([cexName, dinfo]) => {
            const status = mmStatus?.cexes[cexName]
            const hasErr = Boolean(status?.connectErr)
            const configured = Boolean(status) && !hasErr
            return (
              <tr key={cexName}>
                <td className="d-flex align-items-center gap-2">
                  <img
                    src={dinfo.logo}
                    width={24}
                    height={24}
                    alt={dinfo.name}
                    className={!status ? 'greyscale' : ''}
                  />
                  <span>{dinfo.name}</span>
                </td>
                <td>
                  {!status && <span className="text-secondary">{t('Not Configured')}</span>}
                  {configured && <span className="text-success">{t('Connected')}</span>}
                  {hasErr && (
                    <span className="text-danger" title={status?.connectErr}>
                      {t('Connection Error')}
                    </span>
                  )}
                </td>
                <td>
                  {configured
                    ? `$${formatFourSigFigs(cexUSDBalance(cexName))}`
                    : '---'
                  }
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => openCexConfig(cexName)}
                  >
                    {configured
                      ? t('Reconfigure')
                      : t('Configure')
                    }
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Bot Summary Table */}
      {!noBots && (
        <>
          <h5 className="mb-2">{t('Bots')}</h5>
          <table className="table mb-4">
            <thead>
              <tr>
                <th>{t('Market')}</th>
                <th>{t('Type')}</th>
                <th>{t('Status')}</th>
                <th>{t('P/L')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedBots.map((bot) => {
                const { config: cfg, running, runStats } = bot
                const id = hostedMarketID(cfg.host, cfg.baseID, cfg.quoteID)
                const baseAsset = assets[cfg.baseID]
                const quoteAsset = assets[cfg.quoteID]
                if (!baseAsset || !quoteAsset) return null
                const baseSym = baseAsset.symbol.toLowerCase()
                const quoteSym = quoteAsset.symbol.toLowerCase()
                const pl = runStats
                  ? formatProfit(runStats.profitLoss.profit)
                  : null
                return (
                  <tr
                    key={id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleShowBot(id)}
                  >
                    <td className="d-flex align-items-center gap-1">
                      <img src={logoPath(baseSym)} width={20} height={20} alt={baseSym} />
                      <img src={logoPath(quoteSym)} width={20} height={20} alt={quoteSym} />
                      <span>{shortSymbol(baseSym)}-{shortSymbol(quoteSym)}</span>
                    </td>
                    <td>{botTypeLabel(cfg, t)}</td>
                    <td>
                      {running
                        ? <span className="text-success">{t('Running')}</span>
                        : <span className="text-secondary">{t('Idle')}</span>
                      }
                    </td>
                    <td>
                      {pl
                        ? <span className={pl.cls}>{pl.text}</span>
                        : '---'
                      }
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {running && runStats && (
                        <button
                          className="btn btn-sm btn-outline-secondary me-1"
                          onClick={() => {
                            const params = new URLSearchParams({
                              host: cfg.host,
                              baseID: String(cfg.baseID),
                              quoteID: String(cfg.quoteID),
                              startTime: String(runStats.startTime),
                            })
                            navigate(`${ROUTES.MM_LOGS}?${params.toString()}`)
                          }}
                        >
                          {t('Logs')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {/* No Bots Placeholder */}
      {noBots && (
        <div className="text-center py-5 text-secondary">
          <p className="fs18">{t('No bots configured.')}</p>
          <button className="btn btn-primary" onClick={() => navigate(ROUTES.MM_SETTINGS)}>
            {t('Create Your First Bot')}
          </button>
        </div>
      )}

      {/* Bot Cards Grid */}
      {!noBots && (
        <div className="row g-3">
          {sortedBots.map((bot) => {
            const id = hostedMarketID(bot.config.host, bot.config.baseID, bot.config.quoteID)
            return (
              <BotCard
                key={id}
                bot={bot}
                assets={assets}
                exchanges={exchanges}
                fiatRatesMap={fiatRatesMap}
                mmStatus={mmStatus}
                idleBalances={idleBalances}
                highlighted={highlightedBot === id}
                reconfigErr={reconfigErrs[id]}
                refCallback={(el) => {
                  cardRefs.current[id] = el
                }}
                onReconfigure={reconfigure}
                onStop={stopBot}
                onRemove={confirmRemoveCfg}
                t={t}
              />
            )
          })}
        </div>
      )}

      {/* CEX Configuration Overlay */}
      <FormOverlay show={showCexConfig} onClose={() => setShowCexConfig(false)}>
        <CEXConfigurationForm cexName={configCexName} onUpdated={cexConfigured} />
      </FormOverlay>

      {/* Remove Bot Confirmation Overlay */}
      <FormOverlay show={showRemoveConfirm} onClose={() => setShowRemoveConfirm(false)}>
        <div className="p-3">
          <h5>{t('Remove Bot Configuration')}</h5>
          {removingBot && (
            <p>
              {t('Are you sure you want to remove the bot configuration for')}{' '}
              <strong>
                {assets[removingBot.baseID]?.unitInfo?.conventional?.unit ?? '?'}
                /
                {assets[removingBot.quoteID]?.unitInfo?.conventional?.unit ?? '?'}
              </strong>
              {' '}{t('on')} <em>{removingBot.host}</em>?
            </p>
          )}
          {removeErr && <div className="text-danger mb-2">{removeErr}</div>}
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-secondary" onClick={() => setShowRemoveConfirm(false)}>
              {t('Cancel')}
            </button>
            <button className="btn btn-danger" onClick={removeCfg}>
              {t('Remove')}
            </button>
          </div>
        </div>
      </FormOverlay>
    </div>
  )
}

// ---- BotCard ----

interface BotCardProps {
  bot: MMBotStatus
  assets: Record<number, SupportedAsset>
  exchanges: Record<string, { markets: Record<string, { spot?: { rate: number; vol24: number } }> }>
  fiatRatesMap: Record<number, number>
  mmStatus: { cexes: Record<string, { markets?: Record<string, { day?: { lastPrice: number; vol: number } }> }> } | null
  idleBalances: Record<string, AvailableBalances>
  highlighted: boolean
  // MM-02: temporary CEX-not-connected error to show beside the
  // Reconfigure button. Cleared by the parent after 3 seconds.
  reconfigErr?: string
  refCallback: (el: HTMLDivElement | null) => void
  onReconfigure: (cfg: BotConfig) => void
  onStop: (cfg: BotConfig) => Promise<void>
  onRemove: (cfg: BotConfig) => void
  t: (k: string) => string
}

function BotCard ({
  bot, assets, exchanges, fiatRatesMap, mmStatus, idleBalances,
  highlighted, reconfigErr, refCallback, onReconfigure, onStop, onRemove, t,
}: BotCardProps) {
  const navigate = useNavigate()
  const { config: cfg, running, runStats } = bot
  const { host, baseID, quoteID, cexName } = cfg
  const id = hostedMarketID(host, baseID, quoteID)

  const baseAsset = assets[baseID]
  const quoteAsset = assets[quoteID]
  if (!baseAsset || !quoteAsset) return null
  const bui = baseAsset.unitInfo
  const qui = quoteAsset.unitInfo
  const baseSym = baseAsset.symbol.toLowerCase()
  const quoteSym = quoteAsset.symbol.toLowerCase()
  const baseTicker = bui.conventional.unit
  const quoteTicker = qui.conventional.unit
  const bt = botType(cfg)

  // DEX spot data.
  const mktID = `${baseAsset.symbol}_${quoteAsset.symbol}`
  const spot = exchanges[host]?.markets[mktID]?.spot
  const baseFiatRate = fiatRatesMap[baseID] ?? 0
  const baseFactor = bui.conventional.conversionFactor
  const quoteFactor = qui.conventional.conversionFactor
  const RateEncodingFactor = 1e8
  const dexPrice = spot
    ? spot.rate / (RateEncodingFactor / baseFactor * quoteFactor)
    : 0
  const dexVol = spot
    ? spot.vol24 / baseFactor * baseFiatRate
    : 0

  // CEX data.
  let cexPrice = 0
  let cexVol = 0
  if (bt !== botTypeBasicMM && cexName) {
    const cexMkt = mmStatus?.cexes[cexName]?.markets?.[mktID]
    if (cexMkt?.day) {
      cexPrice = cexMkt.day.lastPrice
      cexVol = baseFiatRate * cexMkt.day.vol
    }
  }

  // Balance helpers for idle display.
  const balances = idleBalances[id]

  const formatBal = (atoms: number, ui: SupportedAsset['unitInfo']) =>
    formatCoinValue(atoms, ui)

  const sumBotBalance = (b: BotBalance | undefined): number =>
    (b?.available ?? 0) + (b?.locked ?? 0) + (b?.pending ?? 0) + (b?.reserved ?? 0)

  return (
    <div className="col-12 col-md-6" ref={refCallback}>
      <div
        className="card"
        style={{
          transition: 'transform 250ms ease-out, opacity 250ms ease-out',
          transform: highlighted ? 'scale(1.02)' : 'scale(1)',
          boxShadow: highlighted ? '0 0 12px rgba(30, 125, 17, 0.4)' : undefined,
        }}
      >
        <div className="card-body">
          {/* Market Header */}
          <div className="d-flex align-items-center justify-content-between mb-2">
            <div className="d-flex align-items-center gap-2">
              <img src={logoPath(baseSym)} width={28} height={28} alt={baseSym} />
              <img src={logoPath(quoteSym)} width={28} height={28} alt={quoteSym} />
              <span className="fs18 fw-bold">
                {baseTicker}/{quoteTicker}
              </span>
              {cexName && (
                <span className="badge bg-secondary ms-1">{cexName}</span>
              )}
            </div>
            <span className="badge bg-info">{botTypeLabel(cfg, t)}</span>
          </div>

          {/* Status line */}
          <div className="mb-2">
            {running
              ? <span className="text-success fw-bold">{t('Running')}</span>
              : <span className="text-secondary">{t('Idle')}</span>
            }
          </div>

          {/* DEX / CEX Price & Volume */}
          <div className="row mb-2">
            <div className="col-6">
              <div className="text-secondary small">{t('DEX Price')}</div>
              <div>{spot ? formatFourSigFigs(dexPrice) : '---'}</div>
              <div className="text-secondary small">{t('24h Vol')}: ${spot ? formatFourSigFigs(dexVol) : '---'}</div>
            </div>
            {bt !== botTypeBasicMM && cexName && (
              <div className="col-6">
                <div className="text-secondary small">{t('CEX Price')}</div>
                <div>{cexPrice ? formatFourSigFigs(cexPrice) : '---'}</div>
                <div className="text-secondary small">{t('24h Vol')}: ${cexVol ? formatFourSigFigs(cexVol) : '---'}</div>
              </div>
            )}
          </div>

          {/* Running Stats */}
          {running && runStats && (
            <div className="mb-2">
              <div className="row">
                <div className="col-6">
                  <div className="text-secondary small">{t('Profit/Loss')}</div>
                  <div className={formatProfit(runStats.profitLoss.profit).cls}>
                    {formatProfit(runStats.profitLoss.profit).text}
                  </div>
                </div>
                <div className="col-6">
                  <div className="text-secondary small">{t('Profit Ratio')}</div>
                  <div>{(runStats.profitLoss.profitRatio * 100).toFixed(2)}%</div>
                </div>
              </div>
              <div className="row mt-1">
                <div className="col-6">
                  <div className="text-secondary small">{t('Completed Matches')}</div>
                  <div>{runStats.completedMatches}</div>
                </div>
                <div className="col-6">
                  <div className="text-secondary small">{t('Traded USD')}</div>
                  <div>${formatFiatValue(runStats.tradedUSD)}</div>
                </div>
              </div>
              {(runStats.pendingDeposits > 0 || runStats.pendingWithdrawals > 0) && (
                <div className="row mt-1">
                  <div className="col-6">
                    <div className="text-secondary small">{t('Pending Deposits')}</div>
                    <div>{runStats.pendingDeposits}</div>
                  </div>
                  <div className="col-6">
                    <div className="text-secondary small">{t('Pending Withdrawals')}</div>
                    <div>{runStats.pendingWithdrawals}</div>
                  </div>
                </div>
              )}
              {/* Running bot DEX/CEX balances from runStats */}
              <div className="mt-2">
                <div className="text-secondary small fw-bold">{t('Running Balances')}</div>
                <div className="row">
                  <div className="col-6">
                    <div className="small">DEX {baseTicker}: {formatCoinValue(sumBotBalance(runStats.dexBalances[baseID]), bui)}</div>
                    <div className="small">DEX {quoteTicker}: {formatCoinValue(sumBotBalance(runStats.dexBalances[quoteID]), qui)}</div>
                  </div>
                  {cexName && (
                    <div className="col-6">
                      <div className="small">CEX {baseTicker}: {formatCoinValue(sumBotBalance(runStats.cexBalances[cfg.cexBaseID]), bui)}</div>
                      <div className="small">CEX {quoteTicker}: {formatCoinValue(sumBotBalance(runStats.cexBalances[cfg.cexQuoteID]), qui)}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Idle Balances */}
          {!running && balances && (
            <div className="mb-2">
              <div className="text-secondary small fw-bold">{t('Available Balances')}</div>
              <div className="row">
                <div className="col-6">
                  <div className="small">DEX {baseTicker}: {formatBal(balances.dexBalances[baseID] ?? 0, bui)}</div>
                  <div className="small">DEX {quoteTicker}: {formatBal(balances.dexBalances[quoteID] ?? 0, qui)}</div>
                </div>
                {cexName && (
                  <div className="col-6">
                    <div className="small">CEX {baseTicker}: {formatBal(balances.cexBalances[cfg.cexBaseID] ?? 0, bui)}</div>
                    <div className="small">CEX {quoteTicker}: {formatBal(balances.cexBalances[cfg.cexQuoteID] ?? 0, qui)}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="d-flex gap-2 mt-2 flex-wrap">
            {/* MM-01: jump to the markets page for this bot's market.
                Mirrors vanilla `mm.ts` `marketLink` click handler
                (L329) which loads `markets` with `{host, baseID, quoteID}`. */}
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => {
                const params = new URLSearchParams({
                  host,
                  baseID: String(baseID),
                  quoteID: String(quoteID),
                })
                navigate(`${ROUTES.MARKETS}?${params.toString()}`)
              }}
            >
              {t('View Market')}
            </button>
            <button className="btn btn-sm btn-outline-secondary" onClick={() => onReconfigure(cfg)}>
              {t('Reconfigure')}
            </button>
            {running && runStats && (
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={() => {
                  const params = new URLSearchParams({
                    host,
                    baseID: String(baseID),
                    quoteID: String(quoteID),
                    startTime: String(runStats.startTime),
                  })
                  navigate(`${ROUTES.MM_LOGS}?${params.toString()}`)
                }}
              >
                {t('Logs')}
              </button>
            )}
            {/* MM-06: stop a running bot directly from the card.
                Mirrors vanilla `runningBotDisplay` `stopBttn` (forms.tmpl
                L1068) wired to `MM.stopBot()`. */}
            {running && (
              <button className="btn btn-sm btn-outline-warning" onClick={() => onStop(cfg)}>
                {t('Stop')}
              </button>
            )}
            {!running && (
              <button className="btn btn-sm btn-outline-danger" onClick={() => onRemove(cfg)}>
                {t('Remove')}
              </button>
            )}
          </div>
          {/* MM-02: temporary CEX-not-connected error from the parent's
              reconfigure guard. Auto-clears after 3 seconds. */}
          {reconfigErr && (
            <div className="mt-2 fs14 text-warning">{reconfigErr}</div>
          )}
        </div>
      </div>
    </div>
  )
}
