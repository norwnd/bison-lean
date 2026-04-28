import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from '../router/routes'
import { logoPath } from '../hooks/useFormatters'
import {
  TX_HISTORY_PAGE_SIZE, mergePendingAndHistory,
  TxTable, TxDetailModal
} from '../components/walletTx'
import type {
  WalletTransaction, SupportedAsset, TxHistoryResult
} from '../stores/types'

// Buttons jump by this many rows (forward / backward) within the
// loaded list. The user-facing labels render the literal "20".
const JUMP_STEP = 20

// Hard cap on chained pages a single "← Earliest" click is allowed
// to load (~JUMP_STEP * cap = 4000 txs). Prevents an unbounded walk
// if the API stops setting `moreAvailable=false` for some reason.
const EARLIEST_PAGE_CAP = 200

export default function WalletTransactionsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { assetID: assetIDParam } = useParams<{ assetID: string }>()
  const assetID = Number(assetIDParam)

  const assets = useAuthStore(s => s.assets)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const user = useAuthStore(s => s.user)
  const net = user?.net ?? 0

  const asset: SupportedAsset | undefined = Number.isFinite(assetID)
    ? assets[assetID]
    : undefined
  const wallet = asset?.wallet
  const parentAsset = asset?.token
    ? assets[asset.token.parentID] ?? null
    : null

  const [history, setHistory] = useState<WalletTransaction[]>([])
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailTx, setDetailTx] = useState<WalletTransaction | null>(null)

  // Refs mirror the state above so async loops (jumpEarliest) and
  // event listeners that don't re-bind on each render (scroll handler)
  // can read the latest values synchronously. The closure-captured
  // versions of `history` / `moreAvailable` go stale across async
  // awaits — refs avoid that without forcing the listener to re-bind
  // on every state change.
  const historyRef = useRef<WalletTransaction[]>([])
  const moreAvailableRef = useRef(false)
  const inflightRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const pendingTxs = useMemo(
    () => wallet?.pendingTxs ? Object.values(wallet.pendingTxs) : [],
    [wallet?.pendingTxs]
  )

  const fetchPage = useCallback(async (refID?: string): Promise<TxHistoryResult | null> => {
    if (!Number.isFinite(assetID)) return null
    if (inflightRef.current) return null
    inflightRef.current = true
    setLoading(true)
    const res = await postJSON('/api/txhistory', {
      assetID,
      n: TX_HISTORY_PAGE_SIZE,
      refID,
      past: true
    })
    inflightRef.current = false
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to load transactions')
      return null
    }
    return res as TxHistoryResult
  }, [assetID])

  // Initial page on mount / assetID change. Resets all state (incl.
  // refs) so navigating between assets doesn't leak the previous
  // wallet's txs.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      historyRef.current = []
      moreAvailableRef.current = false
      setHistory([])
      setMoreAvailable(false)
      setError('')
      const first = await fetchPage()
      if (cancelled || !first) return
      const txs = first.txs ?? []
      historyRef.current = txs
      moreAvailableRef.current = !!first.moreAvailable
      setHistory(txs)
      setMoreAvailable(!!first.moreAvailable)
    }
    load()
    return () => { cancelled = true }
  }, [fetchPage])

  // Append the next older page. Reads "current" via refs so chained
  // calls (e.g. jumpEarliest's loop) see the freshly-fetched tail
  // without waiting for React's re-render. Returns true iff non-zero
  // new rows were appended.
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!moreAvailableRef.current) return false
    if (historyRef.current.length === 0) return false
    const refID = historyRef.current[historyRef.current.length - 1].id
    const next = await fetchPage(refID)
    if (!next) return false
    const newTxs = next.txs ?? []
    historyRef.current = [...historyRef.current, ...newTxs]
    moreAvailableRef.current = !!next.moreAvailable
    setHistory(historyRef.current)
    setMoreAvailable(moreAvailableRef.current)
    return newTxs.length > 0
  }, [fetchPage])

  // Infinite scroll: when the scroller is within 200px of the bottom
  // and we still have more to load, fetch the next page. Uses a ref
  // so the listener doesn't have to re-bind on every loadMore re-creation.
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      if (inflightRef.current) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        loadMoreRef.current()
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const merged = useMemo(
    () => mergePendingAndHistory(pendingTxs, history),
    [pendingTxs, history]
  )

  // ----- Jump-button handlers --------------------------------------
  // Convention: arrows describe direction in time. ← = backward
  // (older / down the list, since newest is at top). → = forward
  // (newer / up the list).

  const jumpLatest = useCallback(() => {
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const jumpEarliest = useCallback(async () => {
    let safety = EARLIEST_PAGE_CAP
    while (moreAvailableRef.current && safety-- > 0) {
      const got = await loadMoreRef.current()
      if (!got) break
    }
    requestAnimationFrame(() => {
      const el = scrollerRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  // ± JUMP_STEP rows. Row height is measured per-call to track the
  // table's current density (the row-border layout is stable, but
  // we don't want to hardcode a px value that drifts as the design
  // changes).
  const rowHeight = useCallback((): number => {
    const el = scrollerRef.current
    if (!el) return 36
    const row = el.querySelector('tbody tr')
    return row ? (row as HTMLElement).getBoundingClientRect().height : 36
  }, [])

  const jumpForward = useCallback(() => { // 20 → (toward newer = up)
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({
      top: Math.max(0, el.scrollTop - rowHeight() * JUMP_STEP),
      behavior: 'smooth'
    })
  }, [rowHeight])

  const jumpBackward = useCallback(async () => { // ← 20 (toward older = down)
    const el = scrollerRef.current
    if (!el) return
    // If we'd scroll past what's loaded, pre-load the next page so
    // the jump lands somewhere meaningful instead of being clamped
    // to the current bottom.
    const targetTop = el.scrollTop + rowHeight() * JUMP_STEP
    if (targetTop > el.scrollHeight - el.clientHeight && moreAvailableRef.current) {
      await loadMoreRef.current()
    }
    const el2 = scrollerRef.current
    if (!el2) return
    el2.scrollTo({
      top: el2.scrollTop + rowHeight() * JUMP_STEP,
      behavior: 'smooth'
    })
  }, [rowHeight])

  if (!Number.isFinite(assetID)) {
    return (
      <div className="p-4 text-center grey">
        {t('SELECT_AN_ASSET_FROM_THE_SIDEBAR')}
      </div>
    )
  }

  if (!asset) {
    return (
      <div className="p-4 text-center grey">
        <div className="mb-2">{t('NO_WALLET_CONFIGURED_FOR_THIS_ASSET')}</div>
        <Link to={ROUTES.WALLETS}>{t('Back')}</Link>
      </div>
    )
  }

  return (
    <div className="d-flex flex-column" style={{ height: '100%' }}>
      {/* ---- Header ---- */}
      <div className="d-flex align-items-center justify-content-between p-3 border-bottom">
        <div className="d-flex align-items-center">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary me-3"
            onClick={() => navigate(ROUTES.WALLETS)}
          >
            <span className="ico-arrowleft me-1"></span>
            {t('Back')}
          </button>
          <img src={logoPath(asset.symbol)} alt={asset.symbol} className="large-icon me-2" />
          <span className="fs22 demi me-2">{asset.name}</span>
          <span className="fs18 grey">{t('Transactions')}</span>
        </div>
      </div>

      {/* ---- Sticky jump-button row ---- */}
      <div className="d-flex align-items-center justify-content-center gap-2 px-3 py-2 border-bottom">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpEarliest}
          disabled={!moreAvailable && history.length === 0}
        >
          ← {t('Earliest')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpBackward}
          disabled={merged.length === 0}
        >
          ← {JUMP_STEP}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpForward}
          disabled={merged.length === 0}
        >
          {JUMP_STEP} →
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpLatest}
          disabled={merged.length === 0}
        >
          {t('Latest')} →
        </button>
      </div>

      {/* ---- Scrollable list ---- */}
      <div ref={scrollerRef} className="flex-grow-1" style={{ overflowY: 'auto' }}>
        {error && (
          <div className="text-center py-3 text-danger fs14">{error}</div>
        )}
        {!error && merged.length === 0 && loading && (
          <div className="text-center py-4">
            <span className="ico-spinner spinner"></span>
          </div>
        )}
        {!error && merged.length === 0 && !loading && (
          <div className="flex-center p-3 m-3 fs18 border">{t('NO_TRANSACTIONS')}</div>
        )}
        {merged.length > 0 && (
          <TxTable
            txs={merged}
            asset={asset}
            parentAsset={parentAsset}
            fiatRatesMap={fiatRatesMap}
            net={net}
            onRowClick={setDetailTx}
          />
        )}
        {loading && merged.length > 0 && (
          <div className="text-center py-2">
            <span className="ico-spinner spinner"></span>
          </div>
        )}
      </div>

      <TxDetailModal
        tx={detailTx}
        asset={asset}
        parentAsset={parentAsset}
        fiatRatesMap={fiatRatesMap}
        net={net}
        onClose={() => setDetailTx(null)}
      />
    </div>
  )
}
