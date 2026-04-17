import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { orderPath } from '../router/routes'
import {
  formatCoinValue, formatRateToRateStep,
  formatCoinAtomToLotSizeBaseCurrency, formatCoinAtomToLotSizeQuoteCurrency,
  conventionalRate, shortSymbol, logoPath
} from '../hooks/useFormatters'
import {
  filled, settled, averageRate
} from '../components/AccountUtils'
import {
  Order, OrderFilter,
  OrderTypeLimit, OrderTypeMarket,
  StatusEpoch, StatusBooked, StatusExecuted, StatusCanceled, StatusRevoked,
  RateEncodingFactor,
  ImmediateTiF
} from '../stores/types'
import { FormOverlay } from '../components/common/FormOverlay'

const ORDER_BATCH_SIZE = 50

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusString (order: Order, t: (k: string) => string): string {
  if (!order.id) return t('ORDER_SUBMITTING')
  const isLive = order.matches?.some(m => m.active) ?? false
  switch (order.status) {
    case StatusEpoch: return t('EPOCH')
    case StatusBooked:
      if (order.cancelling) return t('CANCELING')
      return isLive
        ? t('SETTLING')
        : t('BOOKED')
    case StatusExecuted:
      if (isLive) return t('SETTLING')
      if (filled(order) === 0 && order.type !== 3) return t('NO_MATCH')
      return t('EXECUTED')
    case StatusCanceled:
      return isLive
        ? t('SETTLING')
        : t('CANCELED')
    case StatusRevoked:
      return isLive
        ? t('SETTLING')
        : t('REVOKED')
    default:
      return t('UNKNOWN')
  }
}

function typeString (ord: Order, t: (k: string) => string): string {
  if (ord.type === OrderTypeLimit) {
    return ord.tif === ImmediateTiF
      ? t('LIMIT_ORDER_IMMEDIATE_TIF')
      : t('LIMIT_ORDER')
  }
  return t('MARKET_ORDER')
}

// OSP-01: match vanilla `orderutil.ts` `sellString()` (L47-51), which
// reads the user's lang and calls `toLocaleLowerCase(lang)` so the
// case fold respects locale-specific rules (notably Turkish/Azerbaijani
// dotless-'I'). React's plain `.toLowerCase()` would silently produce
// the wrong character for those locales.
function sellBuyString (ord: Order, t: (k: string) => string, lang: string): string {
  return ord.sell
    ? t('SELL').toLocaleLowerCase(lang)
    : t('BUY').toLocaleLowerCase(lang)
}

function ageSince (ms: number): string {
  let dur = Date.now() - ms
  if (dur < 1000) return '0s'
  const units: [number, string][] = [
    [31536000000, 'y'],
    [2592000000, 'mo'],
    [86400000, 'd'],
    [3600000, 'h'],
    [60000, 'min'],
    [1000, 's']
  ]
  let chunks = 0
  let result = ''
  for (const [divisor, label] of units) {
    const n = Math.floor(dur / divisor)
    dur %= divisor
    if (n === 0 && chunks === 0) continue
    result += `${n}${label} `
    chunks++
    if (chunks >= 2) break
  }
  return result.trim()
}

// ---------------------------------------------------------------------------
// Filter option helpers
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: { value: number; labelKey: string }[] = [
  { value: StatusEpoch, labelKey: 'EPOCH' },
  { value: StatusBooked, labelKey: 'BOOKED' },
  { value: StatusExecuted, labelKey: 'EXECUTED' },
  { value: StatusCanceled, labelKey: 'CANCELED' },
  { value: StatusRevoked, labelKey: 'REVOKED' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OrdersPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const lang = useAuthStore(s => s.lang)
  // Filter state derived from URL search params on mount.
  const [hostFilter, setHostFilter] = useState<string[]>(() => {
    const v = searchParams.get('hosts')
    return v
      ? v.split(',')
      : []
  })
  const [assetFilter, setAssetFilter] = useState<number[]>(() => {
    const v = searchParams.get('assets')
    return v
      ? v.split(',').map(Number)
      : []
  })
  const [statusFilter, setStatusFilter] = useState<number[]>(() => {
    const v = searchParams.get('statuses')
    return v
      ? v.split(',').map(Number)
      : []
  })

  // Dirty tracking: show the apply button only when checkboxes differ from
  // what was last submitted.
  const [appliedHostFilter, setAppliedHostFilter] = useState<string[]>(hostFilter)
  const [appliedAssetFilter, setAppliedAssetFilter] = useState<number[]>(assetFilter)
  const [appliedStatusFilter, setAppliedStatusFilter] = useState<number[]>(statusFilter)

  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)

  // Delete-archived modal state.
  const [showDeleteForm, setShowDeleteForm] = useState(false)
  const [deleteUseDateCutoff, setDeleteUseDateCutoff] = useState(false)
  const [deleteDate, setDeleteDate] = useState('')
  const [deleteSaveMatches, setDeleteSaveMatches] = useState(false)
  const [deleteSaveOrders, setDeleteSaveOrders] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteMsg, setDeleteMsg] = useState('')
  const [deletePath, setDeletePath] = useState('')

  const offsetRef = useRef('')
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // All unique hosts from exchanges.
  const hosts = Object.keys(exchanges)
  // All unique asset IDs from exchanges.
  const assetIDs = (() => {
    const ids = new Set<number>()
    for (const xc of Object.values(exchanges)) {
      for (const mkt of Object.values(xc.markets)) {
        ids.add(mkt.baseid)
        ids.add(mkt.quoteid)
      }
    }
    return Array.from(ids).sort((a, b) => a - b)
  })()

  const buildFilter = useCallback((offset: string): OrderFilter => ({
    hosts: appliedHostFilter.length > 0
      ? appliedHostFilter
      : undefined,
    assets: appliedAssetFilter.length > 0
      ? appliedAssetFilter
      : undefined,
    statuses: appliedStatusFilter.length > 0
      ? appliedStatusFilter
      : undefined,
    n: ORDER_BATCH_SIZE,
    offset: offset || undefined,
  }), [appliedHostFilter, appliedAssetFilter, appliedStatusFilter])

  const fetchOrders = useCallback(async (offset: string): Promise<Order[]> => {
    setLoading(true)
    loadingRef.current = true
    const res = await postJSON('/api/orders', buildFilter(offset))
    setLoading(false)
    loadingRef.current = false
    if (!checkResponse(res)) return []
    return res.orders ?? []
  }, [buildFilter])

  // Submit the current applied filter (reloads from scratch).
  const submitFilter = useCallback(async () => {
    setAppliedHostFilter(hostFilter)
    setAppliedAssetFilter(assetFilter)
    setAppliedStatusFilter(statusFilter)
  }, [hostFilter, assetFilter, statusFilter])

  // Whenever the applied filter changes, reload orders from scratch.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      offsetRef.current = ''
      const newOrders = await fetchOrders('')
      if (cancelled) return
      setOrders(newOrders)
      if (newOrders.length === ORDER_BATCH_SIZE) {
        offsetRef.current = newOrders[newOrders.length - 1].id
      } else {
        offsetRef.current = ''
      }
    }
    load()
    return () => { cancelled = true }
  }, [fetchOrders])

  // Initial load on mount.
  useEffect(() => {
    submitFilter()
  }, [])

  // Infinite scroll.
  const handleScroll = useCallback(async () => {
    const el = scrollRef.current
    if (!el || loadingRef.current || offsetRef.current === '') return
    const belowBottom = el.scrollHeight - el.offsetHeight - el.scrollTop
    if (belowBottom < 0) {
      const nextOrders = await fetchOrders(offsetRef.current)
      if (nextOrders.length === ORDER_BATCH_SIZE) {
        offsetRef.current = nextOrders[nextOrders.length - 1].id
      } else {
        offsetRef.current = ''
      }
      setOrders(prev => [...prev, ...nextOrders])
    }
  }, [fetchOrders])

  // Export orders.
  const exportOrders = useCallback(() => {
    const url = new URL(window.location.href)
    const params = new URLSearchParams()
    for (const h of appliedHostFilter) params.append('hosts', h)
    for (const a of appliedAssetFilter) params.append('assets', String(a))
    for (const s of appliedStatusFilter) params.append('statuses', String(s))
    url.search = params.toString()
    url.pathname = '/orders/export'
    window.open(url.toString())
  }, [appliedHostFilter, appliedAssetFilter, appliedStatusFilter])

  // Delete archived records.
  const deleteArchivedRecords = useCallback(async () => {
    setDeleteError('')
    setDeleteMsg('')
    setDeletePath('')

    let olderThanMs: number | undefined
    if (deleteUseDateCutoff) {
      const parsed = Date.parse(deleteDate)
      if (isNaN(parsed) || parsed <= 0) {
        setDeleteError(t('INVALID_DATE_ERR_MSG'))
        return
      }
      olderThanMs = parsed
    }

    setLoading(true)
    const res = await postJSON('/api/deletearchivedrecords', {
      olderThanMs,
      saveMatchesToFile: deleteSaveMatches,
      saveOrdersToFile: deleteSaveOrders,
    })
    setLoading(false)

    if (!checkResponse(res)) {
      setDeleteError(res.msg)
      return
    }

    if (res.archivedRecordsDeleted > 0) {
      setDeleteMsg(t('DELETE_ARCHIVED_RECORDS_RESULT', { nRecords: res.archivedRecordsDeleted }))
      if ((deleteSaveMatches || deleteSaveOrders) && res.archivedRecordsPath) {
        setDeletePath(t('ARCHIVED_RECORDS_PATH', { path: res.archivedRecordsPath }))
      }
      // Refresh order list.
      submitFilter()
    } else {
      setDeleteMsg(t('NO_ARCHIVED_RECORDS'))
    }
  }, [deleteUseDateCutoff, deleteDate, deleteSaveMatches, deleteSaveOrders, submitFilter, t])

  // Check whether the current checkbox state differs from the applied filter.
  const filterDirty = (() => {
    const arrEq = (a: (string | number)[], b: (string | number)[]) =>
      a.length === b.length && a.every(v => b.includes(v))
    return !arrEq(hostFilter, appliedHostFilter) ||
      !arrEq(assetFilter, appliedAssetFilter) ||
      !arrEq(statusFilter, appliedStatusFilter)
  })()

  // Helper to toggle an item in a filter array.
  const toggle = <T extends string | number>(arr: T[], val: T): T[] =>
    arr.includes(val)
      ? arr.filter(v => v !== val)
      : [...arr, val]

  // ---------------------------------------------------------------------------
  // Render helpers for order rows
  // ---------------------------------------------------------------------------

  const renderOrderRow = (ord: Order) => {
    const xc = exchanges[ord.host]
    const baseAsset = assets[ord.baseID] ?? xc?.assets?.[ord.baseID]
    const quoteAsset = assets[ord.quoteID] ?? xc?.assets?.[ord.quoteID]
    if (!baseAsset || !quoteAsset) return null

    const baseUnitInfo = baseAsset.unitInfo
    const quoteUnitInfo = quoteAsset.unitInfo
    // Market is used to format rates/qtys with lot-size and rate-step
    // precision. For historical orders whose exchange/market is no longer
    // configured, the helpers fall back to `formatCoinValue`.
    const mkt = xc?.markets?.[ord.market]
    const fmtBase = (atoms: number): string =>
      mkt
        ? formatCoinAtomToLotSizeBaseCurrency(atoms, baseUnitInfo, mkt.lotsize)
        : formatCoinValue(atoms, baseUnitInfo)
    const fmtQuote = (atoms: number): string =>
      mkt
        ? formatCoinAtomToLotSizeQuoteCurrency(atoms, baseUnitInfo, quoteUnitInfo, mkt.lotsize, mkt.ratestep)
        : formatCoinValue(atoms, quoteUnitInfo)
    const fmtRate = (rateConv: number): string =>
      mkt
        ? formatRateToRateStep(rateConv, baseUnitInfo, quoteUnitInfo, mkt.ratestep)
        : formatCoinValue(rateConv)

    let fromSymbol: string
    let toSymbol: string
    let fromUnit: string
    let toUnit: string
    let fromQty: string
    let toQty = ''

    if (ord.sell) {
      fromSymbol = ord.baseSymbol
      toSymbol = ord.quoteSymbol
      fromUnit = baseUnitInfo.conventional.unit
      toUnit = quoteUnitInfo.conventional.unit
      fromQty = fmtBase(ord.qty)
      if (ord.type === OrderTypeLimit) {
        toQty = fmtQuote(ord.qty / RateEncodingFactor * ord.rate)
      }
    } else {
      fromSymbol = ord.quoteSymbol
      toSymbol = ord.baseSymbol
      fromUnit = quoteUnitInfo.conventional.unit
      toUnit = baseUnitInfo.conventional.unit
      if (ord.type === OrderTypeMarket) {
        fromQty = fmtBase(ord.qty)
      } else {
        fromQty = fmtQuote(ord.qty / RateEncodingFactor * ord.rate)
        toQty = fmtBase(ord.qty)
      }
    }

    const mktID = `${baseUnitInfo.conventional.unit}-${quoteUnitInfo.conventional.unit}`
    const typeSide = `${typeString(ord, t)} ${sellBuyString(ord, t, lang)}`

    // Combined assets from global + exchange-specific for rate lookup.
    const allAssets = { ...assets, ...(xc?.assets ?? {}) }
    let rateStr: string
    if (ord.type === OrderTypeMarket) {
      if (!ord.matches?.length) {
        rateStr = t('MARKET_ORDER')
      } else {
        const avg = averageRate(ord)
        const convRate = conventionalRate(ord.baseID, ord.quoteID, avg, allAssets)
        rateStr = ord.matches.length > 1
          ? `~ ${fmtRate(convRate)}`
          : fmtRate(convRate)
      }
    } else {
      rateStr = fmtRate(conventionalRate(ord.baseID, ord.quoteID, ord.rate, allAssets))
    }

    const filledPct = ord.qty > 0
      ? (filled(ord) / ord.qty * 100).toFixed(1)
      : '0.0'
    const settledPct = ord.qty > 0
      ? (settled(ord) / ord.qty * 100).toFixed(1)
      : '0.0'

    return (
      <tr
        key={ord.id || ord.stamp}
        className="cursor-pointer"
        onClick={() => navigate(orderPath(ord.id))}
      >
        <td>{mktID} @ {ord.host}</td>
        <td>
          <span>{fromQty}</span>
          <img src={logoPath(fromSymbol)} alt={fromUnit} className="micro-icon mx-1" />
          <span>{fromUnit}</span>
        </td>
        <td>
          <span>{toQty}</span>
          {toQty && (
            <>
              <img src={logoPath(toSymbol)} alt={toUnit} className="micro-icon mx-1" />
              <span>{toUnit}</span>
            </>
          )}
        </td>
        <td>{typeSide}</td>
        <td>{rateStr}</td>
        <td>{statusString(ord, t)}</td>
        <td>{filledPct}%</td>
        <td>{settledPct}%</td>
        <td title={new Date(ord.submitTime).toLocaleString()}>
          {ageSince(ord.submitTime)} ago
        </td>
      </tr>
    )
  }

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={scrollRef}
      className="page-wrapper overflow-y-auto"
      style={{ height: '100%' }}
      onScroll={handleScroll}
    >
      <div className="p-3">
        <div className="d-flex flex-wrap align-items-start gap-3 mb-3">
          {/* Host filter */}
          {hosts.length > 0 && (
            <div>
              <div className="fs14 fw-bold mb-1">{t('Hosts')}</div>
              {hosts.map(h => (
                <label key={h} className="d-block fs14">
                  <input
                    type="checkbox"
                    className="me-1"
                    checked={hostFilter.includes(h)}
                    onChange={() => setHostFilter(prev => toggle(prev, h))}
                  />
                  {h}
                </label>
              ))}
            </div>
          )}

          {/* Asset filter */}
          {assetIDs.length > 0 && (
            <div>
              <div className="fs14 fw-bold mb-1">{t('Assets')}</div>
              {assetIDs.map(id => {
                const symbol = assets[id]?.symbol ?? String(id)
                return (
                  <label key={id} className="d-block fs14">
                    <input
                      type="checkbox"
                      className="me-1"
                      checked={assetFilter.includes(id)}
                      onChange={() => setAssetFilter(prev => toggle(prev, id))}
                    />
                    <img src={logoPath(symbol)} alt={symbol} className="micro-icon me-1" />
                    {shortSymbol(symbol)}
                  </label>
                )
              })}
            </div>
          )}

          {/* Status filter */}
          <div>
            <div className="fs14 fw-bold mb-1">{t('Status')}</div>
            {STATUS_OPTIONS.map(opt => (
              <label key={opt.value} className="d-block fs14">
                <input
                  type="checkbox"
                  className="me-1"
                  checked={statusFilter.includes(opt.value)}
                  onChange={() => setStatusFilter(prev => toggle(prev, opt.value))}
                />
                {t(opt.labelKey)}
              </label>
            ))}
          </div>

          {/* Apply / action buttons */}
          <div className="d-flex flex-column gap-2 ms-auto">
            {filterDirty && (
              <button className="btn btn-primary btn-sm" onClick={submitFilter}>
                {t('Apply')}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={exportOrders}>
              {t('Export Orders')}
            </button>
            <button
              className="btn btn-outline-danger btn-sm"
              onClick={() => {
                setDeleteUseDateCutoff(false)
                setDeleteDate('')
                setDeleteSaveMatches(false)
                setDeleteSaveOrders(false)
                setDeleteError('')
                setDeleteMsg('')
                setDeletePath('')
                setShowDeleteForm(true)
              }}
            >
              {t('Delete Archived Records')}
            </button>
          </div>
        </div>

        {/* Orders table */}
        <table className="table table-striped table-hover mb-0">
          <thead>
            <tr>
              <th>{t('Market')}</th>
              <th>{t('From')}</th>
              <th>{t('To')}</th>
              <th>{t('Type')}</th>
              <th>{t('Rate')}</th>
              <th>{t('Status')}</th>
              <th>{t('Filled')}</th>
              <th>{t('Settled')}</th>
              <th>{t('Age')}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(renderOrderRow)}
          </tbody>
        </table>

        {loading && (
          <div className="text-center py-3">
            <span className="spinner-border spinner-border-sm" />
          </div>
        )}

        {!loading && orders.length === 0 && (
          <div className="text-center py-4 text-secondary">
            {t('No orders')}
          </div>
        )}
      </div>

      {/* Delete archived records modal */}
      <FormOverlay show={showDeleteForm} onClose={() => setShowDeleteForm(false)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 340 }}>
          <div className="fs18 mb-3">{t('Delete Archived Records')}</div>

          <label className="d-block fs14 mb-2">
            <input
              type="checkbox"
              className="me-1"
              checked={deleteUseDateCutoff}
              onChange={e => setDeleteUseDateCutoff(e.target.checked)}
            />
            {t('Older than date')}
          </label>
          {deleteUseDateCutoff && (
            <input
              type="datetime-local"
              className="form-control form-control-sm mb-2"
              value={deleteDate}
              onChange={e => setDeleteDate(e.target.value)}
            />
          )}

          <label className="d-block fs14 mb-1">
            <input
              type="checkbox"
              className="me-1"
              checked={deleteSaveMatches}
              onChange={e => setDeleteSaveMatches(e.target.checked)}
            />
            {t('Save matches to file')}
          </label>
          <label className="d-block fs14 mb-3">
            <input
              type="checkbox"
              className="me-1"
              checked={deleteSaveOrders}
              onChange={e => setDeleteSaveOrders(e.target.checked)}
            />
            {t('Save orders to file')}
          </label>

          {/* OSP-03: dedicated success-result container, mirroring vanilla
              `orders.tmpl` `#deleteArchivedResult` (`mt-3 border-top`).
              The result block is visually separated from the form
              inputs by a top border, making it explicit that this is
              the outcome of the delete operation. The form stays open
              after success (matches vanilla) so the user can read the
              result and optionally trigger another delete. */}
          {deleteMsg && (
            <div className="mt-3 pt-3 border-top">
              <div className="fs14 text-success mb-2">{deleteMsg}</div>
              {deletePath && (
                <div className="fs14 text-break mb-2">{deletePath}</div>
              )}
            </div>
          )}

          <div className="d-flex gap-2">
            <button className="btn btn-danger btn-sm" onClick={deleteArchivedRecords}>
              {t('Delete')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowDeleteForm(false)}
            >
              {t('Cancel')}
            </button>
          </div>

          {/* Error message rendered after the buttons, matching vanilla
              `orders.tmpl` ordering (`deleteArchivedRecordsErr` lives
              after the submit button). */}
          {deleteError && (
            <div className="fs14 text-danger text-center mt-2 text-break">{deleteError}</div>
          )}
        </div>
      </FormOverlay>
    </div>
  )
}
