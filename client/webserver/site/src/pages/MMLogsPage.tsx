import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { postJSON, checkResponse } from '../services/api'
import {
  formatCoinAtom, formatBestWeCan, formatFiat,
  formatRateToRateStep,
  formatCoinAtomToLotSizeBaseCurrency, formatCoinAtomToLotSizeQuoteCurrency,
  conventionalRate, logoPath
} from '../hooks/useFormatters'
import { FormOverlay } from '../components/common/FormOverlay'
import { CopyButton } from '../components/common/CopyButton'
import { AssetSymbol } from '../components/common/AssetSymbol'
import { explorerURL } from '../components/CoinExplorers'
import { ROUTES, type MMLogsReturnPage } from '../router/routes'
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
  WalletTransaction,
} from '../stores/types'

const logsBatchSize = 50

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

// Inline helper for rendering an ID (TX/event/order) with an adjacent
// CopyButton. Used pervasively in the event detail modals (MML-01).
// `href` is optional — when present, the trimmed text becomes a link
// to the block explorer (MML-02). The full untrimmed value is used
// for both the title attribute and the clipboard payload.
function IDCell ({ id, href, maxLen = 20 }: { id: string; href?: string | null; maxLen?: number }) {
  const trimmed = trimWithEllipsis(id, maxLen)
  return (
    <span className="d-inline-flex align-items-center gap-1">
      {href
        ? (
          <a href={href} target="_blank" rel="noopener noreferrer" title={id}>
            {trimmed}
          </a>
          )
        : (
          <span title={id}>{trimmed}</span>
          )}
      <CopyButton text={id} />
    </span>
  )
}

// MML-02: resolve a tx-id to its block explorer URL using the asset's
// CoinExplorers entry. Vanilla `mmlogs.ts` L451-452 uses
// `tx.isRelay && tx.relayTxID` to pick the relay tx id when present.
function txExplorerURL (tx: WalletTransaction, assetID: number, net: number): string | null {
  const explorerID = (tx.isRelay && tx.relayTxID) ? tx.relayTxID : tx.id
  return explorerURL(assetID, explorerID, net)
}

// Token-aware fee asset lookup: token assets pay fees in their parent
// asset, so a USDC token tx's fees are denominated in ETH. Mirrors the
// `feeAssetID` helper at the top of this module but takes the assets
// map as a parameter for use inside the BridgeFees component.
function feeAsset (assetID: number, assets: Record<number, SupportedAsset>): SupportedAsset | undefined {
  const asset = assets[assetID]
  if (!asset) return undefined
  if (asset.token) return assets[asset.token.parentID]
  return asset
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
  const exchanges = useAuthStore(s => s.exchanges)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const mmStatus = useAuthStore(s => s.mmStatus)
  const user = useAuthStore(s => s.user)
  const net = user?.net ?? 0

  const host = searchParams.get('host') ?? ''
  const baseID = parseInt(searchParams.get('baseID') ?? '0')
  const quoteID = parseInt(searchParams.get('quoteID') ?? '0')
  const startTime = parseInt(searchParams.get('startTime') ?? '0')
  // T18#4: narrow the raw string to the known-valid set; anything
  // else (including typos) falls through to the 'mm' default.
  const rawReturnPage = searchParams.get('returnPage')
  const returnPage: MMLogsReturnPage = rawReturnPage === 'mmarchives' ? 'mmarchives' : 'mm'

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
  // Market lookup (for lot-size / rate-step aware formatting in the
  // DEX / CEX order detail views). Falls back to formatCoinValueAtom when
  // the market is no longer configured on the exchange.
  const mktID = baseAsset && quoteAsset ? `${baseAsset.symbol}_${quoteAsset.symbol}` : ''
  const mkt = mktID ? exchanges[host]?.markets?.[mktID] : undefined
  const lotsize = mkt?.lotsize
  const ratestep = mkt?.ratestep

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
                        <AssetSymbol asset={asset} />
                      </td>
                      <td>{diff.fmt}</td>
                      <td>{diff.fmtUSD}</td>
                      <td>${formatFiat(fiatRates[assetID] ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="fw-bold">
              {t('Total P/L')}: ${formatFiat(profitLoss.profit)}
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
                <th key={a.id}><AssetSymbol asset={a} /> {t('Delta')}</th>
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
                return { assetID: a.id, text: formatCoinAtom(sum, a.unitInfo) }
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
                  <td>{formatBestWeCan(usd)}</td>
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
            lotsize={lotsize}
            ratestep={ratestep}
            fiatRates={fiatRates}
            net={net}
            t={t}
          />
        )}
      </FormOverlay>
    </div>
  )
}

// ---- Bridge Fees ----

interface BridgeFeesProps {
  // The asset id of the bridge transaction (the originating side).
  assetID: number
  bridgeTx: WalletTransaction
  assets: Record<number, SupportedAsset>
  t: (k: string) => string
}

// MML-03: bridge fees come from up to three sources, and each fee may
// be denominated in a different asset. Mirrors vanilla `mmlogs.ts`
// `populateBridgeFees()` (L564-608):
//
//   1. The fee of the bridge transaction itself (denominated in the
//      origin chain's parent asset).
//   2. The fee of the counterpart transaction on the destination
//      chain (denominated in the destination chain's parent asset).
//   3. The difference between the bridge tx amount and the
//      counterpart's `amountReceived` (a "bridge protocol" fee
//      denominated in the destination asset itself).
//
// Vanilla aggregates fees per fee-asset and renders one row per
// asset, with the "Bridge Fees" label only on the first row.
function BridgeFees ({ assetID, bridgeTx, assets, t }: BridgeFeesProps) {
  if (!bridgeTx.bridgeCounterpartTx) return null
  const counterpart = bridgeTx.bridgeCounterpartTx

  // Aggregate fees keyed by the asset they're denominated in.
  const fees: Record<number, number> = {}
  const addFee = (assetIDForFee: number, amount: number) => {
    const fa = feeAsset(assetIDForFee, assets)
    if (!fa) return
    fees[fa.id] = (fees[fa.id] ?? 0) + amount
  }

  if (bridgeTx.fees > 0) {
    addFee(assetID, bridgeTx.fees)
  }
  if (counterpart.fees > 0) {
    addFee(counterpart.assetID, counterpart.fees)
  }
  if (counterpart.amountReceived > 0) {
    // The "bridge protocol" fee — the gap between what we sent on the
    // origin chain and what we received on the destination chain. This
    // is denominated in the destination asset itself, NOT its parent
    // (so we use `addFee` against `counterpart.assetID` and let the
    // helper do the parent-asset lookup; it'll be the same asset for
    // non-token destinations and the parent for token destinations).
    const diff = bridgeTx.amount - counterpart.amountReceived
    if (diff > 0) addFee(counterpart.assetID, diff)
  }

  const assetIDs = Object.keys(fees).map(Number).filter(id => fees[id] > 0)
  if (assetIDs.length === 0) return null

  return (
    <>
      {assetIDs.map((id, i) => {
        const asset = assets[id]
        if (!asset) return null
        const ui = asset.unitInfo
        const unit = ui.conventional.unit
        return (
          <tr key={id}>
            {/* Only the first row labels the section, matching vanilla
                `Doc.setVis(i === 0, tmpl.label)`. */}
            <td className="text-secondary">{i === 0 ? t('Bridge Fees') : ''}</td>
            <td>{formatCoinAtom(fees[id], ui)} {unit}</td>
          </tr>
        )
      })}
    </>
  )
}

// ---- Event Detail View ----

interface EventDetailProps {
  event: MarketMakingEvent
  assets: Record<number, SupportedAsset>
  baseID: number
  quoteID: number
  lotsize: number | undefined
  ratestep: number | undefined
  fiatRates: Record<number, number>
  net: number
  t: (k: string) => string
}

function EventDetailView ({ event, assets, baseID, quoteID, lotsize, ratestep, net, t }: EventDetailProps) {
  if (event.dexOrderEvent) return <DEXOrderDetail e={event.dexOrderEvent} assets={assets} baseID={baseID} quoteID={quoteID} lotsize={lotsize} ratestep={ratestep} net={net} t={t} />
  if (event.cexOrderEvent) return <CEXOrderDetail e={event.cexOrderEvent} assets={assets} baseID={baseID} quoteID={quoteID} lotsize={lotsize} ratestep={ratestep} t={t} />
  if (event.depositEvent) return <DepositDetail e={event.depositEvent} pending={event.pending} assets={assets} net={net} t={t} />
  if (event.withdrawalEvent) return <WithdrawalDetail e={event.withdrawalEvent} pending={event.pending} assets={assets} net={net} t={t} />
  return <div className="p-3">{t('Unknown event type')}</div>
}

// ---- DEX Order Detail ----

interface DEXOrderDetailProps {
  e: DEXOrderEvent
  assets: Record<number, SupportedAsset>
  baseID: number
  quoteID: number
  lotsize: number | undefined
  ratestep: number | undefined
  net: number
  t: (k: string) => string
}

function DEXOrderDetail ({ e, assets, baseID, quoteID, lotsize, ratestep, net, t }: DEXOrderDetailProps) {
  const baseAsset = assets[baseID]
  const quoteAsset = assets[quoteID]
  const bui = baseAsset?.unitInfo
  const qui = quoteAsset?.unitInfo
  const baseTicker = bui?.conventional?.unit ?? '?'
  const quoteTicker = qui?.conventional?.unit ?? '?'

  const rate = conventionalRate(baseID, quoteID, e.rate, assets)

  const rateStr = bui && qui && ratestep
    ? formatRateToRateStep(rate, bui, qui, ratestep)
    : formatBestWeCan(rate)
  const qtyStr = bui && lotsize
    ? formatCoinAtomToLotSizeBaseCurrency(e.qty, bui, lotsize)
    : (bui ? formatCoinAtom(e.qty, bui) : String(e.qty))

  return (
    <div className="p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('DEX Order Details')}</h5>
      <table className="table table-sm mb-3">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Order ID')}</td>
            {/* MML-01: copy button on Order ID. */}
            <td><IDCell id={e.id} /></td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Rate')}</td>
            <td>{rateStr} {baseTicker}/{quoteTicker}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Quantity')}</td>
            <td>{qtyStr} {baseTicker}</td>
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
                // MML-02: explorer link via the asset's CoinExplorers
                // entry. Uses relayTxID when present (vanilla parity).
                const href = txExplorerURL(tx, txAssetID, net)
                return (
                  <tr key={i}>
                    <td><IDCell id={tx.id} href={href} maxLen={16} /></td>
                    <td>{ui ? formatCoinAtom(tx.amount, ui) : tx.amount} {unit}</td>
                    <td>{ui ? formatCoinAtom(tx.fees, ui) : tx.fees} {unit}</td>
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
  lotsize: number | undefined
  ratestep: number | undefined
  t: (k: string) => string
}

function CEXOrderDetail ({ e, assets, baseID: mktBaseID, quoteID: mktQuoteID, lotsize, ratestep, t }: CEXOrderDetailProps) {
  const effectiveBaseID = e.baseID ?? mktBaseID
  const effectiveQuoteID = e.quoteID ?? mktQuoteID
  const baseAsset = assets[effectiveBaseID]
  const quoteAsset = assets[effectiveQuoteID]
  const bui = baseAsset?.unitInfo
  const qui = quoteAsset?.unitInfo
  const baseTicker = bui?.conventional?.unit ?? '?'
  const quoteTicker = qui?.conventional?.unit ?? '?'

  const rate = conventionalRate(effectiveBaseID, effectiveQuoteID, e.rate, assets)

  const isMarketBuy = Boolean(e.market) && !e.sell
  const qtyTicker = isMarketBuy ? quoteTicker : baseTicker

  const rateStr = bui && qui && ratestep
    ? formatRateToRateStep(rate, bui, qui, ratestep)
    : formatBestWeCan(rate)
  const qtyStr = isMarketBuy
    ? (bui && qui && lotsize && ratestep
        ? formatCoinAtomToLotSizeQuoteCurrency(e.qty, bui, qui, lotsize, ratestep)
        : (qui ? formatCoinAtom(e.qty, qui) : String(e.qty)))
    : (bui && lotsize
        ? formatCoinAtomToLotSizeBaseCurrency(e.qty, bui, lotsize)
        : (bui ? formatCoinAtom(e.qty, bui) : String(e.qty)))
  const baseFilledStr = bui && lotsize
    ? formatCoinAtomToLotSizeBaseCurrency(e.baseFilled, bui, lotsize)
    : (bui ? formatCoinAtom(e.baseFilled, bui) : String(e.baseFilled))
  const quoteFilledStr = bui && qui && lotsize && ratestep
    ? formatCoinAtomToLotSizeQuoteCurrency(e.quoteFilled, bui, qui, lotsize, ratestep)
    : (qui ? formatCoinAtom(e.quoteFilled, qui) : String(e.quoteFilled))

  return (
    <div className="p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('CEX Order Details')}</h5>
      <table className="table table-sm">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Order ID')}</td>
            {/* MML-01: copy button on CEX Order ID. */}
            <td><IDCell id={e.id} /></td>
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
              <td>{rateStr} {baseTicker}/{quoteTicker}</td>
            </tr>
          )}
          <tr>
            <td className="text-secondary">{t('Quantity')}</td>
            <td>{qtyStr} {qtyTicker}</td>
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
            <td>{baseFilledStr} {baseTicker}</td>
          </tr>
          <tr>
            <td className="text-secondary">{t('Quote Filled')}</td>
            <td>{quoteFilledStr} {quoteTicker}</td>
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
  net: number
  t: (k: string) => string
}

function DepositDetail ({ e, pending, assets, net, t }: DepositDetailProps) {
  const asset = assets[e.assetID]
  const ui = asset?.unitInfo
  const unit = ui?.conventional?.unit ?? ''

  const feeAssetForDeposit = assets[feeAssetID(e.assetID, assets)]
  const feeUI = feeAssetForDeposit?.unitInfo
  const feeUnit = feeUI?.conventional?.unit ?? ''

  let amount = 0
  if (e.transaction) amount = e.transaction.amount
  if (e.bridgeTx?.bridgeCounterpartTx?.amountReceived) {
    amount = e.bridgeTx.bridgeCounterpartTx.amountReceived
  }

  // MML-02: explorer link helpers for the deposit's tx and bridge tx.
  const txHref = e.transaction
    ? txExplorerURL(e.transaction, e.assetID, net)
    : null
  const bridgeHref = e.bridgeTx
    ? txExplorerURL(e.bridgeTx, e.assetID, net)
    : null

  return (
    <div className="p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('Deposit Details')}</h5>
      <table className="table table-sm">
        <tbody>
          {e.transaction && (
            <>
              <tr>
                <td className="text-secondary">{t('TX ID')}</td>
                {/* MML-01 + MML-02: copy button + explorer link on TX ID. */}
                <td><IDCell id={e.transaction.id} href={txHref} /></td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Fees')}</td>
                <td>{feeUI ? formatCoinAtom(e.transaction.fees, feeUI) : e.transaction.fees} {feeUnit}</td>
              </tr>
            </>
          )}
          {e.bridgeTx && (
            <tr>
              <td className="text-secondary">{t('Bridge TX ID')}</td>
              {/* MML-01 + MML-02. */}
              <td><IDCell id={e.bridgeTx.id} href={bridgeHref} /></td>
            </tr>
          )}
          {/* MML-03: bridge fees broken down by the three vanilla
              sources (origin tx fees, counterpart tx fees, bridge
              protocol fee from the amount difference). */}
          {e.bridgeTx && (
            <BridgeFees
              assetID={e.assetID}
              bridgeTx={e.bridgeTx}
              assets={assets}
              t={t}
            />
          )}
          {amount > 0 && (
            <tr>
              <td className="text-secondary">{t('Amount')}</td>
              <td>{ui ? formatCoinAtom(amount, ui) : amount} {unit}</td>
            </tr>
          )}
          <tr>
            <td className="text-secondary">{t('Status')}</td>
            <td>{pending ? t('Pending') : t('Complete')}</td>
          </tr>
          {!pending && (
            <tr>
              <td className="text-secondary">{t('CEX Credit')}</td>
              <td>{ui ? formatCoinAtom(e.cexCredit, ui) : e.cexCredit} {unit}</td>
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
  net: number
  t: (k: string) => string
}

function WithdrawalDetail ({ e, pending, assets, net, t }: WithdrawalDetailProps) {
  const asset = assets[e.assetID]
  const ui = asset?.unitInfo
  const unit = ui?.conventional?.unit ?? ''

  const feeAssetForWithdrawal = assets[feeAssetID(e.assetID, assets)]
  const feeUI = feeAssetForWithdrawal?.unitInfo
  const feeUnit = feeUI?.conventional?.unit ?? ''

  // MML-02: explorer link helpers for the withdrawal's tx and bridge tx.
  const txHref = e.transaction
    ? txExplorerURL(e.transaction, e.assetID, net)
    : null
  const bridgeHref = e.bridgeTx
    ? txExplorerURL(e.bridgeTx, e.assetID, net)
    : null

  return (
    <div className="p-3" style={{ minWidth: 400, maxWidth: 600 }}>
      <h5>{t('Withdrawal Details')}</h5>
      <table className="table table-sm">
        <tbody>
          <tr>
            <td className="text-secondary">{t('Withdrawal ID')}</td>
            {/* MML-01: copy button on Withdrawal ID. */}
            <td><IDCell id={e.id} /></td>
          </tr>
          {e.transaction && (
            <>
              <tr>
                <td className="text-secondary">{t('TX ID')}</td>
                {/* MML-01 + MML-02: copy + explorer link on TX ID. */}
                <td><IDCell id={e.transaction.id} href={txHref} /></td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Fees')}</td>
                <td>{feeUI ? formatCoinAtom(e.transaction.fees, feeUI) : e.transaction.fees} {feeUnit}</td>
              </tr>
              <tr>
                <td className="text-secondary">{t('Received')}</td>
                <td>{ui ? formatCoinAtom(e.transaction.amount, ui) : e.transaction.amount} {unit}</td>
              </tr>
            </>
          )}
          {e.bridgeTx && (
            <tr>
              <td className="text-secondary">{t('Bridge TX ID')}</td>
              <td><IDCell id={e.bridgeTx.id} href={bridgeHref} /></td>
            </tr>
          )}
          {/* MML-03: bridge fees breakdown for the withdrawal path. */}
          {e.bridgeTx && (
            <BridgeFees
              assetID={e.assetID}
              bridgeTx={e.bridgeTx}
              assets={assets}
              t={t}
            />
          )}
          <tr>
            <td className="text-secondary">{t('CEX Debit')}</td>
            <td>{ui ? formatCoinAtom(e.cexDebit, ui) : e.cexDebit} {unit}</td>
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
