// BridgingPopup — orchestrator for the bridge modal (B-L16).
//
// Port of vanilla
// `client/webserver/site/src/js/bridging/components/BridgingPopup.tsx`,
// adapted to the React rewrite's idioms:
//
// - Vanilla used `forwardRef` + `useImperativeHandle` so the legacy
//   `wallets.ts` page class could imperatively call note handlers
//   from its own dispatch. The React rewrite has no equivalent need
//   -- the popup subscribes to the relevant WS notes itself via
//   `useNotifications`. This drops the imperative-handle complexity
//   entirely.
// - Vanilla received `bridgePaths` as a prop preloaded by
//   `app().allBridgePaths()` at app start. We fetch them lazily on
//   mount via `bridgeApi.allBridgePaths()` since the React app has
//   no equivalent boot-time step.
// - `useReducer` + Context providers stay (they're already React
//   idioms in vanilla).

import { useReducer, useCallback, useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'
import { useNotifications } from '../../hooks/useNotifications'
import {
  BridgeStateContext,
  BridgeDispatchContext,
  bridgeReducer,
  createInitialState,
  approvalStatusFromBridgeApproval
} from './BridgeState'
import BridgeForm from './BridgeForm'
import BridgeHistory from './BridgeHistory'
import BridgeDetails from './BridgeDetails'
import { bridgeApprovalStatus as apiBridgeApprovalStatus } from './bridgeApi'
import { loadInitialBridgeHistory, type BridgeTransaction } from './bridgeData'
import { assetLogoPath } from './bridgeUtils'
import type {
  CoreNote, BridgeNote, WalletStateNote, BalanceNote,
  WalletNote, TransactionNote
} from '../../stores/types'

export interface BridgingPopupProps {
  // The set of asset IDs that the user can bridge between -- in
  // practice this is the same-ticker network siblings of the wallet
  // currently selected on WalletsPage.
  networkAssetIDs: number[]
  // The bridge topology, fetched once by WalletsPage on mount. Keeps
  // the popup stateless w.r.t. pathing and lets WalletsPage gate the
  // Bridge button on whether any paths exist for the selected asset.
  bridgePaths: Record<number, Record<number, string[]>>
  // Called when the user clicks the close button or backdrop. The
  // parent owns whether the popup is rendered.
  onClose: () => void
}

function BridgingPopup ({ networkAssetIDs, bridgePaths, onClose }: BridgingPopupProps) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const [state, dispatch] = useReducer(bridgeReducer, undefined, createInitialState)
  const [selectedTxID, setSelectedTxID] = useState<string | null>(null)

  // Derive the selected transaction from the in-memory pending +
  // history lists. Splitting it out keeps BridgeDetails rendering in
  // sync with WS-driven note updates without needing its own state.
  const selectedTx = useMemo(() => {
    if (!selectedTxID) return null
    return state.pendingBridges.find(tx => tx.id === selectedTxID) ||
           state.bridgeHistory.find(tx => tx.id === selectedTxID) ||
           null
  }, [selectedTxID, state.pendingBridges, state.bridgeHistory])

  const headerAsset = !state.loading ? assets[state.sourceAssetID] : undefined
  const headerSymbol = (() => {
    if (!headerAsset) return ''
    const unit = headerAsset.unitInfo?.conventional?.unit
    const raw = (unit && unit.length > 0) ? unit : headerAsset.symbol
    return raw.split('.')[0].toUpperCase()
  })()

  // Filter the raw paths to only include:
  // 1. Assets with wallets (can't bridge what you can't sign).
  // 2. Both source and dest must be in networkAssetIDs (we only
  //    bridge between same-ticker network siblings).
  // Then dispatch INITIALIZE with the filtered set.
  useEffect(() => {
    const networkAssetSet = new Set(networkAssetIDs)
    const filteredPaths: Record<number, Record<number, string[]>> = {}
    for (const [srcIDStr, dests] of Object.entries(bridgePaths)) {
      const srcID = parseInt(srcIDStr)
      if (!assets[srcID]?.wallet) continue
      if (!networkAssetSet.has(srcID)) continue

      const filteredDests: Record<number, string[]> = {}
      for (const [destIDStr, bridges] of Object.entries(dests)) {
        const destID = parseInt(destIDStr)
        if (!networkAssetSet.has(destID)) continue
        if (assets[destID]?.wallet) {
          filteredDests[destID] = bridges
        }
      }

      if (Object.keys(filteredDests).length > 0) {
        filteredPaths[srcID] = filteredDests
      }
    }

    // Find an initial valid (bridge, source, dest) tuple, preferring
    // a source asset in networkAssetIDs order so the popup opens on
    // the wallet the user clicked from.
    const initialSource = networkAssetIDs.find(id => !!filteredPaths[id]) ??
      Number(Object.keys(filteredPaths)[0] ?? 0)
    const initialDest = initialSource
      ? Number(Object.keys(filteredPaths[initialSource] || {})[0] ?? 0)
      : 0
    const initialBridge = (initialSource && initialDest)
      ? (filteredPaths[initialSource]?.[initialDest]?.[0] ?? '')
      : ''

    if (!initialBridge) {
      // Caller should have checked before opening the popup, but we
      // still surface a clear message rather than silently freezing
      // in the loading state.
      dispatch({
        type: 'PATCH',
        patch: { error: t('NO_DESTINATIONS') }
      })
      return
    }

    dispatch({
      type: 'INITIALIZE',
      paths: filteredPaths,
      initialBridge,
      initialSource,
      initialDest
    })
  }, [bridgePaths, networkAssetIDs, assets, t])

  // Load history exactly once after initialization. The WS note
  // handlers below take over from here.
  useEffect(() => {
    if (state.loading) return
    if (state.bridgeHistoryLoaded) return
    let cancelled = false
    ;(async () => {
      dispatch({ type: 'PATCH', patch: { historyLoading: true } })
      try {
        const { pending, history, refIDByAsset, doneByAsset } = await loadInitialBridgeHistory(
          networkAssetIDs,
          state.bridgeHistoryPageSize,
          assets
        )
        if (cancelled) return
        dispatch({
          type: 'PATCH',
          patch: {
            pendingBridges: pending,
            bridgeHistory: history,
            bridgeHistoryRefIDByAsset: refIDByAsset,
            bridgeHistoryDoneByAsset: doneByAsset,
            bridgeHistoryLoaded: true,
            bridgeHistoryPageIndex: 0,
            historyLoading: false
          }
        })
      } catch (e) {
        if (cancelled) return
        dispatch({
          type: 'PATCH',
          patch: {
            error: t('Failed to load history: {{err}}', { err: String(e) }),
            historyLoading: false,
            bridgeHistoryLoaded: true
          }
        })
      }
    })()
    return () => { cancelled = true }
  }, [state.loading, state.bridgeHistoryLoaded, state.bridgeHistoryPageSize, networkAssetIDs, assets, t])

  // -----------------------------------------------------------------------
  // WS note handlers — replaces vanilla's `useImperativeHandle`-based
  // method exposure. Each handler updates the reducer state in-place
  // so the form/history/details views re-render reactively.
  // -----------------------------------------------------------------------

  const handleWalletStateNote = useCallback(async (n: WalletStateNote) => {
    // Re-fetch approval status when the wallet state changes for an
    // approval-related topic. Mirrors vanilla L57-69.
    if (n.wallet.assetID !== state.sourceAssetID) return
    if (n.topic !== 'BridgeApproval') return
    if (!state.bridgeName) return

    try {
      const approvalResp = await apiBridgeApprovalStatus(state.sourceAssetID, state.bridgeName)
      if (approvalResp.ok) {
        dispatch({
          type: 'PATCH',
          patch: { approvalStatus: approvalStatusFromBridgeApproval(approvalResp.status) }
        })
      }
    } catch (e) {
      console.error('Failed to refresh approval status:', e)
    }
  }, [state.sourceAssetID, state.bridgeName])

  const handleBridgeUpdate = useCallback((n: BridgeNote) => {
    // Apply the bridge note to the in-memory pending/history lists.
    // If the note marks the tx complete, move it from pending to
    // history. Mirrors vanilla L72-103.
    const applyNoteToTx = (tx: BridgeTransaction): BridgeTransaction => {
      const existingCounterpart = tx.bridgeCounterpartTx || {
        assetID: n.destAssetID,
        ids: [],
        complete: false,
        amountReceived: 0,
        fees: 0
      }
      return {
        ...tx,
        bridgeCounterpartTx: {
          ...existingCounterpart,
          assetID: n.destAssetID,
          ids: n.completionTxIDs,
          amountReceived: n.amount,
          complete: n.complete
        }
      }
    }

    const pending = [...state.pendingBridges]
    const history = [...state.bridgeHistory]
    const pIdx = pending.findIndex(tx => tx.id === n.txID)
    const hIdx = history.findIndex(tx => tx.id === n.txID)

    if (pIdx >= 0) {
      const updated = applyNoteToTx(pending[pIdx])
      if (n.complete) {
        pending.splice(pIdx, 1)
        history.unshift(updated)
      } else {
        pending[pIdx] = updated
      }
    } else if (hIdx >= 0) {
      history[hIdx] = applyNoteToTx(history[hIdx])
    }

    pending.sort((a, b) => b.timestamp - a.timestamp)
    history.sort((a, b) => b.timestamp - a.timestamp)
    dispatch({ type: 'PATCH', patch: { pendingBridges: pending, bridgeHistory: history } })
  }, [state.pendingBridges, state.bridgeHistory])

  const handleTransactionNote = useCallback((n: TransactionNote) => {
    // Update timestamp on any tx whose initiation has been mined.
    // Mirrors vanilla L106-134.
    const tx = n.transaction
    if (!tx?.id || !tx.timestamp) return

    const updateTimestamp = (txs: BridgeTransaction[]) => {
      let changed = false
      const updated = txs.map(t => {
        if (t.id !== tx.id) return t
        if (t.timestamp === tx.timestamp) return t
        changed = true
        return { ...t, timestamp: tx.timestamp }
      })
      if (changed) updated.sort((a, b) => b.timestamp - a.timestamp)
      return { updated, changed }
    }

    const p = updateTimestamp(state.pendingBridges)
    const h = updateTimestamp(state.bridgeHistory)
    if (p.changed || h.changed) {
      dispatch({
        type: 'PATCH',
        patch: {
          pendingBridges: p.changed ? p.updated : state.pendingBridges,
          bridgeHistory: h.changed ? h.updated : state.bridgeHistory
        }
      })
    }
  }, [state.pendingBridges, state.bridgeHistory])

  const handleBalanceUpdate = useCallback((note: CoreNote) => {
    // Bump balance refresh token when a balance note arrives for any
    // asset in our network set. BridgeForm reads this token in its
    // amount-validation memo so the same input string can re-validate
    // against the new balance.
    const n = note as BalanceNote
    if (networkAssetIDs.includes(n.assetID)) {
      dispatch({ type: 'BUMP_BALANCE_REFRESH' })
    }
  }, [networkAssetIDs])

  // Subscribe to the four WS routes the popup cares about. Vanilla
  // wallets.ts handles `walletnote` at the page level and
  // dispatches based on `payload.route` (e.g. 'transaction',
  // 'tipChange', 'ticketPurchaseUpdate'). For the bridge popup we
  // only care about the 'transaction' sub-route (to refresh tx
  // timestamps when the initiation tx is mined), so we unwrap the
  // payload inline here. Mirrors vanilla `handleCustomWalletNote`
  // (L2767) + `case 'transaction'` dispatch (L2791-2799).
  //
  // Previously subscribed to `transaction:` directly, which never
  // fired because there is no top-level `type: 'transaction'` note
  // -- they arrive wrapped as `walletnote`.
  const noteReceivers = useMemo(() => ({
    bridge: (n: CoreNote) => handleBridgeUpdate(n as BridgeNote),
    walletstate: (n: CoreNote) => handleWalletStateNote(n as WalletStateNote),
    walletnote: (n: CoreNote) => {
      const payload = (n as WalletNote).payload
      if (payload?.route === 'transaction') {
        handleTransactionNote(payload as TransactionNote)
      }
    },
    balance: handleBalanceUpdate
  }), [handleBridgeUpdate, handleWalletStateNote, handleTransactionNote, handleBalanceUpdate])

  useNotifications(noteReceivers)

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const handleTabClick = useCallback((tab: 'bridge' | 'history') => {
    dispatch({ type: 'PATCH', patch: { activeTab: tab, error: null } })
  }, [])

  // Detail view (selected tx) -- selected from the History tab.
  // Vanilla swaps content within the same form node; we do the same
  // so the reducer state survives the switch.
  if (selectedTx) {
    return (
      <BridgeStateContext.Provider value={state}>
        <BridgeDispatchContext.Provider value={dispatch}>
          <div
            className="bg-body border rounded p-4 position-relative"
            style={{ maxWidth: '525px' }}
          >
            <div className="form-closer" style={{ position: 'absolute', top: 8, right: 12 }}>
              <span className="ico-cross pointer" onClick={() => setSelectedTxID(null)}></span>
            </div>
            <BridgeDetails tx={selectedTx} />
          </div>
        </BridgeDispatchContext.Provider>
      </BridgeStateContext.Provider>
    )
  }

  return (
    <BridgeStateContext.Provider value={state}>
      <BridgeDispatchContext.Provider value={dispatch}>
        <div
          className="bg-body border rounded p-4 position-relative"
          style={{ maxWidth: '525px' }}
        >
          <div className="form-closer" style={{ position: 'absolute', top: 8, right: 12 }}>
            <span className="ico-cross pointer" onClick={onClose}></span>
          </div>

          {/* Header */}
          <header className="d-flex align-items-center mb-3">
            <span className="ico-exchange fs22 me-2"></span>
            <span className="fs22">{t('BRIDGE')}</span>
            {headerAsset && (
              <>
                <span className="fs22 ms-2">{headerSymbol}</span>
                <img
                  src={assetLogoPath(headerAsset.symbol)}
                  className="micro-icon ms-2"
                  alt=""
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              </>
            )}
          </header>

          {/* Tab navigation */}
          <div className="d-flex mb-3 border-bottom">
            <button
              type="button"
              className={`flex-grow-1 py-2 border-0 hoverbg ${state.activeTab === 'bridge' ? 'active border-bottom border-primary border-2 fw-bold' : 'text-muted bg-transparent'}`}
              onClick={() => handleTabClick('bridge')}
            >
              {t('BRIDGE')}
            </button>
            <button
              type="button"
              className={`flex-grow-1 py-2 border-0 hoverbg ${state.activeTab === 'history' ? 'active border-bottom border-primary border-2 fw-bold' : 'text-muted bg-transparent'}`}
              onClick={() => handleTabClick('history')}
            >
              {t('HISTORY')}
              {state.pendingBridges.length > 0 && (
                <span className="badge bg-warning ms-1">{state.pendingBridges.length}</span>
              )}
            </button>
          </div>

          {/* Tab content */}
          <div style={{ minHeight: '200px', minWidth: '475px' }}>
            {state.activeTab === 'bridge'
              ? <BridgeForm networkAssetIDs={networkAssetIDs} />
              : <BridgeHistory networkAssetIDs={networkAssetIDs} onSelectTx={(tx) => setSelectedTxID(tx.id)} />}
          </div>
        </div>
      </BridgeDispatchContext.Provider>
    </BridgeStateContext.Provider>
  )
}

export default BridgingPopup
