import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
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

// Sentinel `n` for "← Earliest" - the backend treats n<=0 as
// no-limit (see client/asset/btc/txdb.go canIterate, client/asset/eth
// /txdb.go iterFunc), so a single round trip walks from the current
// tail to the oldest tx instead of chaining 10-tx pages.
const NO_LIMIT_N = 0

// Virtualization knobs. Row height is measured once after the first
// row paints (see useLayoutEffect below); the default seeds the
// initial render so the windowed slice is roughly viewport-sized
// even before measurement. Buffer trades render cost against blank-
// row flashes during fast scrolls; 20 is enough that a single
// keypress / wheel tick stays inside the rendered window.
const ROW_HEIGHT_DEFAULT_PX = 32
const VIRT_BUFFER_ROWS = 20

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

  // Virtualization state. scrollTop + viewportHeight + rowHeightPx
  // are the three numbers we need to compute the windowed slice of
  // `merged` to actually render. They each have their own update
  // path (scroll handler / ResizeObserver / useLayoutEffect) so the
  // table re-renders only the rows in view + a buffer.
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [rowHeightPx, setRowHeightPx] = useState(ROW_HEIGHT_DEFAULT_PX)

  // Refs mirror the state above so async loops (jumpEarliest) and
  // event listeners that don't re-bind on each render (scroll handler)
  // can read the latest values synchronously. The closure-captured
  // versions of `history` / `moreAvailable` go stale across async
  // awaits - refs avoid that without forcing the listener to re-bind
  // on every state change.
  const historyRef = useRef<WalletTransaction[]>([])
  const moreAvailableRef = useRef(false)
  const inflightRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const pendingTxs = useMemo(
    () => wallet?.pendingTxs ? Object.values(wallet.pendingTxs) : [],
    [wallet?.pendingTxs]
  )

  const fetchPage = useCallback(async (
    refID?: string,
    n: number = TX_HISTORY_PAGE_SIZE
  ): Promise<TxHistoryResult | null> => {
    if (!Number.isFinite(assetID)) return null
    if (inflightRef.current) return null
    inflightRef.current = true
    setLoading(true)
    const res = await postJSON('/api/txhistory', {
      assetID,
      n,
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
  //
  // /api/txhistory's response includes the refID tx itself (per the
  // comment in client/asset/eth/txdb.go and the BTC iterator's
  // it.Seek+Next behavior). Strip it before appending so chained
  // pagination doesn't introduce a duplicate of the previous page's
  // last entry.
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!moreAvailableRef.current) return false
    if (historyRef.current.length === 0) return false
    const refID = historyRef.current[historyRef.current.length - 1].id
    const next = await fetchPage(refID)
    if (!next) return false
    const fetched = next.txs ?? []
    const newTxs = fetched[0]?.id === refID ? fetched.slice(1) : fetched
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
      // Drives both virtualization (slice + spacer recompute) and
      // the existing infinite-scroll prefetch. Setting scrollTop on
      // every event is fine - React 18 batches and the cost of a
      // shallow compare + slice is negligible vs. the actual paint.
      setScrollTop(el.scrollTop)
      if (inflightRef.current) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        loadMoreRef.current()
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Track the scroller's clientHeight so the virtualization window
  // matches whatever the layout currently gives us. ResizeObserver
  // catches both window resizes and any future flex/grid relayout
  // of the parent panel - we don't have to hand-wire window.resize.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => setViewportHeight(el.clientHeight)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const merged = useMemo(
    () => mergePendingAndHistory(pendingTxs, history),
    [pendingTxs, history]
  )

  // Auto-fill on first paint. The initial fetch returns
  // TX_HISTORY_PAGE_SIZE=10 rows; on a viewport tall enough for more
  // (typical desktop) those rows don't overflow the scroller, the
  // scrollbar never appears, and the infinite-scroll handler can't
  // fire since `scroll` events don't fire without scroll motion.
  // Result: page looks like it shows "less" than it should until
  // the user does something that causes a fetch (resize, navigate
  // away and back, etc).
  //
  // Loop loadMore until either content overflows past the
  // infinite-scroll trigger zone (200px below clientHeight) or
  // there's nothing more to load. inflightRef + loading guards
  // keep this from racing the user's own scroll-driven loads.
  useEffect(() => {
    if (loading) return
    if (inflightRef.current) return
    if (!moreAvailable) return
    if (viewportHeight === 0) return
    const el = scrollerRef.current
    if (!el) return
    if (el.scrollHeight - el.clientHeight > 200) return
    loadMoreRef.current()
  }, [merged.length, viewportHeight, moreAvailable, loading])

  // Measure the actual height of a rendered data row so the window
  // and spacer math match the painted layout. Runs after every
  // render where rows exist; only commits state when the height has
  // meaningfully changed (>0.5px) so we don't spin the render loop
  // on sub-pixel jitter from text-metrics rounding. The selector
  // skips spacer trs (those have no .pointer class). Re-measures
  // on viewport resize because the ID column shows the full hash
  // and its line-wrap (and therefore row height) shifts as the
  // column width does.
  useLayoutEffect(() => {
    if (merged.length === 0) return
    const el = scrollerRef.current
    if (!el) return
    const row = el.querySelector('tbody tr.pointer')
    if (!row) return
    const h = (row as HTMLElement).getBoundingClientRect().height
    if (h > 0 && Math.abs(h - rowHeightPx) > 0.5) setRowHeightPx(h)
  }, [merged.length, viewportHeight, rowHeightPx])

  // Windowed slice: render only rows whose virtual position
  // intersects the viewport, plus VIRT_BUFFER_ROWS above/below for
  // smooth scroll. Top/bottom spacer trs hold the un-rendered space
  // so the scroll bar reflects the full content height.
  const visibleStart = viewportHeight > 0
    ? Math.max(0, Math.floor(scrollTop / rowHeightPx) - VIRT_BUFFER_ROWS)
    : 0
  const visibleEnd = viewportHeight > 0
    ? Math.min(merged.length, Math.ceil((scrollTop + viewportHeight) / rowHeightPx) + VIRT_BUFFER_ROWS)
    : merged.length
  const visibleTxs = merged.slice(visibleStart, visibleEnd)
  const topSpacerPx = visibleStart * rowHeightPx
  const bottomSpacerPx = Math.max(0, (merged.length - visibleEnd) * rowHeightPx)

  // ----- Jump-button handlers --------------------------------------
  // Convention: arrows describe scroll direction (matching what the
  // scrollbar does), not direction in time. ← = scroll up = toward
  // the top of the list (which holds the latest txs). → = scroll
  // down = toward the bottom (which holds the earliest txs).
  //
  // Pairs of handlers below are split by intent:
  //   jumpLatest / jumpEarliest = jump to top / bottom of the list
  //   scrollUp20 / scrollDown20 = step ±JUMP_STEP rows in scroll dir
  // Buttons (in render order) wire to: ← Latest, ← 20, 20 →, Earliest →.

  const jumpLatest = useCallback(() => {
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const jumpEarliest = useCallback(async () => {
    const scrollToBottom = () => {
      requestAnimationFrame(() => {
        const el = scrollerRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      })
    }
    if (!moreAvailableRef.current) {
      scrollToBottom()
      return
    }
    if (historyRef.current.length === 0) return
    const refID = historyRef.current[historyRef.current.length - 1].id
    // Single round trip with n=0 (no-limit). Backend walks from refID
    // to the earliest tx and returns everything in one shot - replaces
    // the previous chained 10-tx walk that needed up to 200 round
    // trips for long histories. Same include-refID strip as loadMore.
    const res = await fetchPage(refID, NO_LIMIT_N)
    if (!res) return
    const fetched = res.txs ?? []
    const newTxs = fetched[0]?.id === refID ? fetched.slice(1) : fetched
    historyRef.current = [...historyRef.current, ...newTxs]
    moreAvailableRef.current = !!res.moreAvailable
    setHistory(historyRef.current)
    setMoreAvailable(moreAvailableRef.current)
    scrollToBottom()
  }, [fetchPage])

  // ± JUMP_STEP rows. Uses the same measured `rowHeightPx` that
  // drives virtualization, so the jump distance always matches what
  // the user sees painted (no drift between "20 rows of layout" and
  // "20 rows of windowing").

  const scrollUp20 = useCallback(() => { // ← 20 (toward top = latest)
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({
      top: Math.max(0, el.scrollTop - rowHeightPx * JUMP_STEP),
      behavior: 'smooth'
    })
  }, [rowHeightPx])

  const scrollDown20 = useCallback(async () => { // 20 → (toward bottom = earliest)
    const el = scrollerRef.current
    if (!el) return
    // If we'd scroll past what's loaded, pre-load the next page so
    // the jump lands somewhere meaningful instead of being clamped
    // to the current bottom.
    const targetTop = el.scrollTop + rowHeightPx * JUMP_STEP
    if (targetTop > el.scrollHeight - el.clientHeight && moreAvailableRef.current) {
      await loadMoreRef.current()
    }
    const el2 = scrollerRef.current
    if (!el2) return
    el2.scrollTo({
      top: el2.scrollTop + rowHeightPx * JUMP_STEP,
      behavior: 'smooth'
    })
  }, [rowHeightPx])

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

      {/* ---- Scrollable list ----
          overflowX: auto lets narrow viewports scroll the table
          horizontally instead of squeezing cells past their per-
          column ch minimums (set in TxTable's COL_MIN_CH). */}
      <div ref={scrollerRef} className="flex-grow-1" style={{ overflowY: 'auto', overflowX: 'auto' }}>
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
            txs={visibleTxs}
            asset={asset}
            parentAsset={parentAsset}
            fiatRatesMap={fiatRatesMap}
            net={net}
            onRowClick={setDetailTx}
            fixedLayout
            topSpacerPx={topSpacerPx}
            bottomSpacerPx={bottomSpacerPx}
          />
        )}
        {loading && merged.length > 0 && (
          <div className="text-center py-2">
            <span className="ico-spinner spinner"></span>
          </div>
        )}
      </div>

      {/* ---- Jump-button row (bottom) ----
          Buttons stay in the same render order; only the labels and
          click handlers swap pairwise. The new convention: arrows
          describe scroll direction. */}
      <div className="d-flex align-items-center justify-content-center gap-2 px-3 py-2 border-top">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpLatest}
          disabled={merged.length === 0}
        >
          ← {t('Recent')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={scrollUp20}
          disabled={merged.length === 0}
        >
          ← {JUMP_STEP}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={scrollDown20}
          disabled={merged.length === 0}
        >
          {JUMP_STEP} →
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={jumpEarliest}
          disabled={!moreAvailable && history.length === 0}
        >
          {t('Oldest')} →
        </button>
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
