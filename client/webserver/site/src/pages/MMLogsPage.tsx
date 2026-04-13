import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { postJSON, checkResponse } from '../services/api'
import { formatCoinValue, formatFourSigFigs, formatFiatValue } from '../hooks/useFormatters'
import { FormOverlay } from '../components/common/FormOverlay'
import { ROUTES } from '../router/routes'
import type {
  MarketMakingEvent,
  DEXOrderEvent,
  CEXOrderEvent,
  DepositEvent,
  WithdrawalEvent,
  BalanceEffects,
  ProfitLoss,
  MarketMakingRunOverview,
  RunEventNote,
  RunStatsNote,
  SupportedAsset,
  BotConfig,
} from '../stores/types'

const logsBatchSize = 50

const logoPath = (sym: string) => {
  const b = sym.split('.')[0]
  return `/img/coins/${b === 'weth' ? 'eth' : b}.png`
}

interface LogFilters {
  dexSells: boolean
  dexBuys: boolean
  cexSells: boolean
  cexBuys: boolean
  deposits: boolean
  withdrawals: boolean
}

const defaultFilters: LogFilters = {
  dexSells: true,
  dexBuys: true,
  cexSells: true,
  cexBuys: true,
  deposits: true,
  withdrawals: true,
}

function eventTypeStr (event: MarketMakingEvent): string {
  if (event.dexOrderEvent) return event.dexOrderEvent.sell ? 'DEX Sell' : 'DEX Buy'
  if (event.cexOrderEvent) return event.cexOrderEvent.sell ? 'CEX Sell' : 'CEX Buy'
  if (event.depositEvent) return 'Deposit'
  if (event.withdrawalEvent) return 'Withdrawal'
  return ''
}

function eventID (event: MarketMakingEvent): string {
  if (event.dexOrderEvent) return event.dexOrderEvent.id
  if (event.cexOrderEvent) return event.cexOrderEvent.id
  if (event.depositEvent) return event.depositEvent.transaction?.id ?? ''
  if (event.withdrawalEvent) return event.withdrawalEvent.id
  return ''
}

function trimWithEllipsis (str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  const half = Math.floor(maxLen / 2)
  return `${str.substring(0, half)}...${str.substring(str.length - half)}`
}

function sumBalanceEffects (assetID: number, be: BalanceEffects): number {
  let sum = 0
  if (be.settled[assetID]) sum += be.settled[assetID]
  if (be.pending[assetID]) sum += be.pending[assetID]
  if (be.locked[assetID]) sum += be.locked[assetID]
  if (be.reserved[assetID]) sum += be.reserved[assetID]
  return sum
}

function feeAssetID (assetID: number, assets: Record<number, SupportedAsset>): number {
  const asset = assets[assetID]
  if (asset?.token) return asset.token.parentID
  return assetID
}

function eventPassesFilter (e: MarketMakingEvent, filters: LogFilters): boolean {
  if (e.dexOrderEvent) return e.dexOrderEvent.sell ? filters.dexSells : filters.dexBuys
  if (e.cexOrderEvent) return e.cexOrderEvent.sell ? filters.cexSells : filters.cexBuys
  if (e.depositEvent) return filters.deposits
  if (e.withdrawalEvent) return filters.withdrawals
  return false
}

export default function MMLogsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const assets = useAuthStore(s => s.assets)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const mmStatus = useAuthStore(s => s.mmStatus)

  const host = searchParams.get('host') ?? ''
  const baseID = parseInt(searchParams.get('baseID') ?? '0')
  const quoteID = parseInt(searchParams.get('quoteID') ?? '0')
  const startTime = parseInt(searchParams.get('startTime') ?? '0')
  const returnPage = searchParams.get('returnPage') ?? 'mm'

  const [events, setEvents] = useState<MarketMakingEvent[]>([])
  const [overview, setOverview] = useState<MarketMakingRunOverview | null>(null)
  const [profitLoss, setProfitLoss] = useState<ProfitLoss | null>(null)
  const [endTime, setEndTime] = useState(0)
  const [filters, setFilters] = useState<LogFilters>(defaultFilters)
  const [loading, setLoading] = useState(false)
  const [doneScrolling, setDoneScrolling] = useState(false)
  const [detailEvent, setDetailEvent] = useState<MarketMakingEvent | null>(null)
  const [botCfg, setBotCfg] = useState<BotConfig | undefined>(undefined)

  const refIDRef = useRef<number | undefined>(undefined)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Determine if this is a live bot.
  const liveBotStatus = useMemo(() => {
    if (!mmStatus?.bots) return undefined
    return mmStatus.bots.find(b =>
      b.config.host === host &&
      b.config.baseID === baseID &&
      b.config.quoteID === quoteID &&
      b.runStats?.startTime === startTime
    )
  }, [mmStatus, host, baseID, quoteID, startTime])

  const isLive = Boolean(liveBotStatus)

  // Fiat rates: live bot uses app fiat rates, archived uses overview's final state.
  const fiatRates = useMemo(() => {
    if (isLive) return fiatRatesMap
    return overview?.finalState?.fiatRates ?? fiatRatesMap
  }, [isLive, fiatRatesMap, overview])

  // Determine all relevant asset IDs for this market.
  const mktAssets = useMemo(() => {
    const ids: Record<number, boolean> = {}
    ids[baseID] = true
    ids[quoteID] = true
    ids[feeAssetID(baseID, assets)] = true
    ids[feeAssetID(quoteID, assets)] = true
    if (botCfg) {
      ids[botCfg.cexBaseID] = true
      ids[botCfg.cexQuoteID] = true
      ids[feeAssetID(botCfg.cexBaseID, assets)] = true
      ids[feeAssetID(botCfg.cexQuoteID, assets)] = true
      const multiHop = botCfg.arbMarketMakingConfig?.multiHop
      if (multiHop) {
        let intermediate = multiHop.baseAssetMarket[0]
        if (intermediate === baseID) intermediate = multiHop.baseAssetMarket[1]
        ids[intermediate] = true
      }
    }
    return Object.keys(ids).map(Number).map(id => assets[id]).filter(Boolean)
  }, [baseID, quoteID, assets, botCfg])

  // Fetch logs from the API.
  const fetchLogs = useCallback(async (currentFilters: LogFilters, currentRefID?: number): Promise<{
    logs: MarketMakingEvent[]
    updatedLogs: MarketMakingEvent[]
    overview: MarketMakingRunOverview
  }> => {
    const req = {
      market: { host, baseID, quoteID },
      startTime,
      n: logsBatchSize,
      filters: currentFilters,
      refID: currentRefID,
    }
    const res = await postJSON('/api/mmrunlogs', req)
    if (!checkResponse(res)) {
      console.error('failed to get bot logs', res)
    }
    return {
      logs: res.logs ?? [],
      updatedLogs: res.updatedLogs ?? [],
      overview: res.overview as MarketMakingRunOverview,
    }
  }, [host, baseID, quoteID, startTime])

  // Initial fetch.
  useEffect(() => {
    (async () => {
      setLoading(true)
      const { logs, overview: ov } = await fetchLogs(filters)
      setEvents(logs)
      setOverview(ov)
      if (ov.cfgs?.length > 0) {
        setBotCfg(ov.cfgs[ov.cfgs.length - 1].cfg)
      }
      if (logs.length > 0) {
        refIDRef.current = logs[logs.length - 1].id
      }
      if (logs.length <= 1) setDoneScrolling(true)

      // Determine P/L source.
      if (liveBotStatus?.runStats?.startTime === startTime) {
        setProfitLoss(liveBotStatus.runStats.profitLoss)
        setEndTime(0)
      } else {
        setProfitLoss(ov.profitLoss)
        setEndTime(ov.endTime)
      }
      setLoading(false)
    })()
  }, [])

  // Infinite scroll handler.
  const handleScroll = useCallback(() => {
    if (loading || doneScrolling) return
    const container = scrollContainerRef.current
    if (!container) return
    const belowBottom = container.scrollHeight - container.clientHeight - container.scrollTop
    if (belowBottom < 100) {
      setLoading(true)
      fetchLogs(filters, refIDRef.current).then(({ logs, updatedLogs, overview: ov }) => {
        if (logs.length <= 1) setDoneScrolling(true)
        if (logs.length > 0) refIDRef.current = logs[logs.length - 1].id
        setEvents(prev => {
          const existingIDs = new Set(prev.map(e => e.id))
          const newEvents = logs.filter(e => !existingIDs.has(e.id))
          // Update existing events.
          const updated = new Map(updatedLogs.map(e => [e.id, e]))
          const merged = prev.map(e => updated.get(e.id) ?? e)
          return [...merged, ...newEvents]
        })
        setProfitLoss(ov.profitLoss)
        if (ov.endTime) setEndTime(ov.endTime)
        setLoading(false)
      })
    }
  }, [loading, doneScrolling, filters, fetchLogs])

  // Apply filters.
  const applyFilters = useCallback(async () => {
    refIDRef.current = undefined
    setDoneScrolling(false)
    setLoading(true)
    const { logs, overview: ov } = await fetchLogs(filters)
    setEvents(logs)
    setProfitLoss(ov.profitLoss)
    if (ov.endTime) setEndTime(ov.endTime)
    if (logs.length > 0) refIDRef.current = logs[logs.length - 1].id
    if (logs.length <= 1) setDoneScrolling(true)
    setLoading(false)
  }, [filters, fetchLogs])

  // WS subscriptions.
  const noteHandlers = useMemo(() => ({
    runevent: (note: RunEventNote) => {
      if (note.host !== host || note.baseID !== baseID || note.quoteID !== quoteID) return
      if (!eventPassesFilter(note.event, filters)) return
      setEvents(prev => {
        const idx = prev.findIndex(e => e.id === note.event.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = note.event
          return updated
        }
        return [note.event, ...prev]
      })
    },
    runstats: (note: RunStatsNote) => {
      if (note.host !== host || note.baseID !== baseID || note.quoteID !== quoteID) return
      if (!note.stats || note.stats.startTime !== startTime) return
      setProfitLoss(note.stats.profitLoss)
    },
  }), [host, baseID, quoteID, startTime, filters])

  useNotifications(noteHandlers)

  const baseAsset = assets[baseID]
  const quoteAsset = assets[quoteID]
  const baseSym = baseAsset?.symbol?.toLowerCase() ?? ''
  const quoteSym = quoteAsset?.symbol?.toLowerCase() ?? ''

  return (
    <div className="page-view p-3 d-flex flex-column" style={{ height: '100%' }}>
      {/* Header */}
      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <button
          className="btn btn-secondary"
          onClick={() => navigate(returnPage === 'mmarchives' ? ROUTES.MM_ARCHIVES : ROUTES.MM)}
        >
          {t('Back')}
        </button>
        <div className="d-flex align-items-center gap-1">
          {baseSym && <img src={logoPath(baseSym)} width={24} height={24} alt={baseSym} />}
          {quoteSym && <img src={logoPath(quoteSym)} width={24} height={24} alt={quoteSym} />}
          <h4 className="mb-0">
            {baseAsset?.unitInfo?.conventional?.unit ?? '?'}/{quoteAsset?.unitInfo?.conventional?.unit ?? '?'}
          </h4>
          <span className="text-secondary ms-2">{host}</span>
        </div>
      </div>

      {/* Performance Stats */}
      {profitLoss && (
        <div className="card mb-3">
          <div className="card-body">
            <h5 className="card-title">{t('Performance')}</h5>
            <div className="row mb-2">
              <div className="col-sm-6">
                <div className="text-secondary small">{t('Start Time')}</div>
                <div>{new Date(startTime * 1000).toLocaleString()}</div>
              </div>
              {endTime > 0 && (
                <div className="col-sm-6">
                  <div className="text-secondary small">{t('End Time')}</div>
                  <div>{new Date(endTime * 1000).toLocaleString()}</div>
                </div>
              )}
            </div>
            {/* Per-asset diffs table */}
            <table className="table table-sm mb-2">
              <thead>
                <tr>
                  <th>{t('Asset')}</th>
                  <th>{t('Diff')}</th>
                  <th>{t('USD')}</th>
                  <th>{t('Fiat Rate')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(profitLoss.diffs).map(([assetIDStr, diff]) => {
                  const assetID = parseInt(assetIDStr)
                  const asset = assets[assetID]
                  if (!asset) return null
                  return (
                    <tr key={assetID}>
                      <td className="d-flex align-items-center gap-1">
                        <img src={logoPath(asset.symbol)} width={16} height={16} alt={asset.symbol} />
                        {asset.symbol.toUpperCase()}
                      </td>
                      <td>{diff.fmt}</td>
                      <td>{diff.fmtUSD}</td>
                      <td>{formatFiatValue(fiatRates[assetID] ?? 0)} USD</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="fw-bold">
              {t('Total P/L')}: {formatFiatValue(profitLoss.profit)} USD
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="d-flex flex-wrap gap-3 align-items-center mb-3">
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.dexSells}
            onChange={e => setFilters(prev => ({ ...prev, dexSells: e.target.checked }))}
          />
          {t('DEX Sells')}
        </label>
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.dexBuys}
            onChange={e => setFilters(prev => ({ ...prev, dexBuys: e.target.checked }))}
          />
          {t('DEX Buys')}
        </label>
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.cexSells}
            onChange={e => setFilters(prev => ({ ...prev, cexSells: e.target.checked }))}
          />
          {t('CEX Sells')}
        </label>
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.cexBuys}
            onChange={e => setFilters(prev => ({ ...prev, cexBuys: e.target.checked }))}
          />
          {t('CEX Buys')}
        </label>
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.deposits}
            onChange={e => setFilters(prev => ({ ...prev, deposits: e.target.checked }))}
          />
          {t('Deposits')}
        </label>
        <label className="d-flex align-items-center gap-1">
          <input
            type="checkbox"
            checked={filters.withdrawals}
            onChange={e => setFilters(prev => ({ ...prev, withdrawals: e.target.checked }))}
          />
          {t('Withdrawals')}
        </label>
        <button className="btn btn-sm btn-outline-secondary" onClick={applyFilters}>
          {t('Apply')}
        </button>
      </div>

      {/* Events Table (scrollable) */}
      <div
        ref={scrollContainerRef}
        className="flex-grow-1"
        style={{ overflowY: 'auto', minHeight: 0 }}
        onScroll={handleScroll}
      >
        <table className="table table-sm">
          <thead className="sticky-top bg-body">
            <tr>
              <th>{t('Time')}</th>
              <th>{t('Type')}</th>
              <th>{t('Event ID')}</th>
              {mktAssets.map(a => (
                <th key={a.id}>{a.symbol.toUpperCase()} {t('Delta')}</th>
              ))}
              <th>{t('USD')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map(event => {
              let usd = 0
              const deltas = mktAssets.map(a => {
                const sum = sumBalanceEffects(a.id, event.balanceEffects)
                const factor = a.unitInfo.conventional.conversionFactor
                usd += sum / factor * (fiatRates[a.id] ?? 0)
                return { assetID: a.id, text: formatCoinValue(sum, a.unitInfo) }
              })
              const eid = eventID(event)
              return (
                <tr key={event.id}>
                  <td>{new Date(event.timestamp * 1000).toLocaleString()}</td>
                  <td>{eventTypeStr(event)}</td>
                  <td title={eid}>{trimWithEllipsis(eid, 20)}</td>
                  {deltas.map(d => (
                    <td key={d.assetID}>{d.text}</td>
                  ))}
                  <td>{formatFourSigFigs(usd)}</td>
                  <td>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() => setDetailEvent(event)}
                    >
                      {t('Details')}
                    </button>
                  </td>
                </tr>
              )
            })}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={mktAssets.length + 5} className="text-center text-secondary py-3">
                  {t('No events found.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && (
          <div className="text-center py-2 text-secondary">{t('Loading...')}</div>
        )}
      </div>

      {/* Event Detail Modal */}
      <FormOverlay show={detailEvent !== null} onClose={() => setDetailEvent(null)}>
        {detailEvent && (
          <EventDetailView
            event={detailEvent}
            assets={assets}
            baseID={baseID}
            quoteID={quoteID}
            fiatRates={fiatRates}
            t={t}
          />
        )}
      </FormOverlay>
    </div>
  )
}

// ---- Event Detail View ----

interface EventDetailProps {
  event: MarketMakingEvent
  assets: Record<number, SupportedAsset>
  baseID: number
  quoteID: number
  fiatRates: Record<number, number>
  t: (k: string) => string
}

function EventDetailView ({ event, assets, baseID, quoteID, t }: EventDetailProps) {
  if (event.dexOrderEvent) return <DEXOrderDetail e={event.dexOrderEvent} assets={assets} baseID={baseID} quoteID={quoteID} t={t} />
  if (event.cexOrderEvent) return <CEXOrderDetail e={event.cexOrderEvent} assets={assets} baseID={baseID} quoteID={quoteID} t={t} />
  if (event.depositEvent) return <DepositDetail e={event.depositEvent} pending={event.pending} assets={assets} t={t} />
  if (event.withdrawalEvent) return <WithdrawalDetail e={event.withdrawalEvent} pending={event.pending} assets={assets} t={t} />
  return <div className="form-closer p-3">{t('Unknown event type')}</div>
}

// ---- DEX Order Detail ----

interface DEXOrderDetailProps {
  e: DEXOrderEvent
  assets: Record<number, SupportedAsset>
  baseID: number
  quoteID: number
  t: (k: string) => string
}

function DEXOrderDetail ({ e, assets, baseID, quoteID, t }: DEXOrderDetailProps) {
  const baseAsset = assets[baseID]
  const quoteAsset = assets[quoteID]
  const bui = baseAsset?.unitInfo
  const qui = quoteAsset?.unitInfo
  const baseTicker = bui?.conventional?.unit ?? '?'
  const quoteTicker = qui?.conventional?.unit ?? '?'

  const RateEncodingFactor = 1e8
  const baseFactor = bui?.conventional?.conversionFactor ?? 1
  const quoteFactor = qui?.conventional?.conversionFactor ?? 1
  const rate = e.rate * (baseFactor / quoteFactor) / RateEncodingFactor

  return (
    <div className="form-closer p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('DEX Order Details')}</h5>
      <table className="table table-sm mb-3">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Order ID')}</td>
            <td title={e.id}>{trimWithEllipsis(e.id, 20)}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Rate')}</td>
            <td>{formatFourSigFigs(rate)} {baseTicker}/{quoteTicker}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Quantity')}</td>
            <td>{bui ? formatCoinValue(e.qty, bui) : e.qty} {baseTicker}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Side')}</td>
            <td>{e.sell ? t('Sell') : t('Buy')}</td>
          </tr>
        </tbody>
      </table>
      {e.transactions && e.transactions.length > 0 && (
        <>
          <h6>{t('Transactions')}</h6>
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t('TX ID')}</th>
                <th>{t('Amount')}</th>
                <th>{t('Fees')}</th>
              </tr>
            </thead>
            <tbody>
              {e.transactions.map((tx, i) => {
                const txAssetID = txAssetForDex(tx.type, e.sell, baseID, quoteID)
                const txAsset = assets[txAssetID]
                const ui = txAsset?.unitInfo
                const unit = ui?.conventional?.unit ?? ''
                return (
                  <tr key={i}>
                    <td title={tx.id}>{trimWithEllipsis(tx.id, 16)}</td>
                    <td>{ui ? formatCoinValue(tx.amount, ui) : tx.amount} {unit}</td>
                    <td>{ui ? formatCoinValue(tx.fees, ui) : tx.fees} {unit}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// Tx type constants from wallets.ts.
const txTypeSwap = 3
const txTypeRedeem = 4
const txTypeRefund = 5
const txTypeSplit = 6

function txAssetForDex (txType: number, sell: boolean, baseID: number, quoteID: number): number {
  switch (txType) {
    case txTypeSwap:
    case txTypeRefund:
    case txTypeSplit:
      return sell ? baseID : quoteID
    case txTypeRedeem:
      return sell ? quoteID : baseID
    default:
      return baseID
  }
}

// ---- CEX Order Detail ----

interface CEXOrderDetailProps {
  e: CEXOrderEvent
  assets: Record<number, SupportedAsset>
  baseID: number
  quoteID: number
  t: (k: string) => string
}

function CEXOrderDetail ({ e, assets, baseID: mktBaseID, quoteID: mktQuoteID, t }: CEXOrderDetailProps) {
  const effectiveBaseID = e.baseID ?? mktBaseID
  const effectiveQuoteID = e.quoteID ?? mktQuoteID
  const baseAsset = assets[effectiveBaseID]
  const quoteAsset = assets[effectiveQuoteID]
  const bui = baseAsset?.unitInfo
  const qui = quoteAsset?.unitInfo
  const baseTicker = bui?.conventional?.unit ?? '?'
  const quoteTicker = qui?.conventional?.unit ?? '?'

  const RateEncodingFactor = 1e8
  const baseFactor = bui?.conventional?.conversionFactor ?? 1
  const quoteFactor = qui?.conventional?.conversionFactor ?? 1
  const rate = e.rate * (baseFactor / quoteFactor) / RateEncodingFactor

  const isMarketBuy = Boolean(e.market) && !e.sell
  const qtyTicker = isMarketBuy ? quoteTicker : baseTicker
  const qtyUI = isMarketBuy ? qui : bui

  return (
    <div className="form-closer p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('CEX Order Details')}</h5>
      <table className="table table-sm">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Order ID')}</td>
            <td title={e.id}>{trimWithEllipsis(e.id, 20)}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Base Asset')}</td>
            <td>{baseAsset?.symbol ?? '?'}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Quote Asset')}</td>
            <td>{quoteAsset?.symbol ?? '?'}</td>
          </tr>
          {!e.market && (
            <tr>
              <td className="text-secondary">{t('Rate')}</td>
              <td>{formatFourSigFigs(rate)} {baseTicker}/{quoteTicker}</td>
            </tr>
          )}
          <tr>
            <td className="text-secondary">{t('Quantity')}</td>
            <td>
              {qtyUI
                ? formatCoinValue(e.qty, qtyUI)
                : e.qty
              } {qtyTicker}
            </td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Side')}</td>
            <td>{e.sell ? t('Sell') : t('Buy')}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Order Type')}</td>
            <td>{e.market ? t('Market') : t('Limit')}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Base Filled')}</td>
            <td>{bui ? formatCoinValue(e.baseFilled, bui) : e.baseFilled} {baseTicker}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Quote Filled')}</td>
            <td>{qui ? formatCoinValue(e.quoteFilled, qui) : e.quoteFilled} {quoteTicker}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ---- Deposit Detail ----

interface DepositDetailProps {
  e: DepositEvent
  pending: boolean
  assets: Record<number, SupportedAsset>
  t: (k: string) => string
}

function DepositDetail ({ e, pending, assets, t }: DepositDetailProps) {
  const asset = assets[e.assetID]
  const ui = asset?.unitInfo
  const unit = ui?.conventional?.unit ?? ''

  const feeAsset = assets[feeAssetID(e.assetID, assets)]
  const feeUI = feeAsset?.unitInfo
  const feeUnit = feeUI?.conventional?.unit ?? ''

  let amount = 0
  if (e.transaction) amount = e.transaction.amount
  if (e.bridgeTx?.bridgeCounterpartTx?.amountReceived) {
    amount = e.bridgeTx.bridgeCounterpartTx.amountReceived
  }

  return (
    <div className="form-closer p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('Deposit Details')}</h5>
      <table className="table table-sm">
        <tbody>
          {e.transaction && (
            <>
              <tr>
                <td className="text-secondary">{t('TX ID')}</td>
                <td title={e.transaction.id}>{trimWithEllipsis(e.transaction.id, 20)}</td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Fees')}</td>
                <td>{feeUI ? formatCoinValue(e.transaction.fees, feeUI) : e.transaction.fees} {feeUnit}</td>
              </tr>
            </>
          )}
          {e.bridgeTx && (
            <tr>
              <td className="text-secondary">{t('Bridge TX ID')}</td>
              <td title={e.bridgeTx.id}>{trimWithEllipsis(e.bridgeTx.id, 20)}</td>
            </tr>
          )}
          {amount > 0 && (
            <tr>
              <td className="text-secondary">{t('Amount')}</td>
              <td>{ui ? formatCoinValue(amount, ui) : amount} {unit}</td>
            </tr>
          )}
          <tr>
            <td className="text-secondary">{t('Status')}</td>
            <td>{pending ? t('Pending') : t('Complete')}</td>
          </tr>
          {!pending && (
            <tr>
              <td className="text-secondary">{t('CEX Credit')}</td>
              <td>{ui ? formatCoinValue(e.cexCredit, ui) : e.cexCredit} {unit}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ---- Withdrawal Detail ----

interface WithdrawalDetailProps {
  e: WithdrawalEvent
  pending: boolean
  assets: Record<number, SupportedAsset>
  t: (k: string) => string
}

function WithdrawalDetail ({ e, pending, assets, t }: WithdrawalDetailProps) {
  const asset = assets[e.assetID]
  const ui = asset?.unitInfo
  const unit = ui?.conventional?.unit ?? ''

  const feeAsset = assets[feeAssetID(e.assetID, assets)]
  const feeUI = feeAsset?.unitInfo
  const feeUnit = feeUI?.conventional?.unit ?? ''

  return (
    <div className="form-closer p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('Withdrawal Details')}</h5>
      <table className="table table-sm">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Withdrawal ID')}</td>
            <td title={e.id}>{trimWithEllipsis(e.id, 20)}</td>
          </tr>
          {e.transaction && (
            <>
              <tr>
                <td className="text-secondary">{t('TX ID')}</td>
                <td title={e.transaction.id}>{trimWithEllipsis(e.transaction.id, 20)}</td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Fees')}</td>
                <td>{feeUI ? formatCoinValue(e.transaction.fees, feeUI) : e.transaction.fees} {feeUnit}</td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Received')}</td>
                <td>{ui ? formatCoinValue(e.transaction.amount, ui) : e.transaction.amount} {unit}</td>
              </tr>
            </>
          )}
          {e.bridgeTx && (
            <tr>
              <td className="text-secondary">{t('Bridge TX ID')}</td>
              <td title={e.bridgeTx.id}>{trimWithEllipsis(e.bridgeTx.id, 20)}</td>
            </tr>
          )}
          <tr>
            <td className="text-secondary">{t('CEX Debit')}</td>
            <td>{ui ? formatCoinValue(e.cexDebit, ui) : e.cexDebit} {unit}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Status')}</td>
            <td>{pending ? t('Pending') : t('Complete')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
