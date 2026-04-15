// Bridge history fetch helpers (B-L16).
//
// Direct port of vanilla
// `client/webserver/site/src/js/bridging/utils/bridgeData.ts`. The
// only structural changes vs. vanilla are:
//
// - `app()` calls replaced by direct API helper calls from
//   `./bridgeApi`.
// - The `assets` map is passed in explicitly so the helpers stay
//   pure (no Zustand dependency at module level).

import type { SupportedAsset, WalletTransaction } from '../../stores/types'
import { pendingBridges as apiPendingBridges, bridgeHistory as apiBridgeHistory } from './bridgeApi'

// BridgeTransaction extends the wallet-side `WalletTransaction` shape
// with a `sourceAssetID` tag that records which wallet's
// /api/pendingbridges or /api/bridgehistory call returned it. Vanilla
// has the same synthetic field (`bridging/types.ts`) and uses it
// throughout to look up the source asset for fee/amount formatting.
export interface BridgeTransaction extends WalletTransaction {
  sourceAssetID: number
}

export async function loadPendingBridges (
  networkAssetIDs: number[],
  assets: Record<number, SupportedAsset>
): Promise<BridgeTransaction[]> {
  if (!networkAssetIDs.length) return []
  const assetsWithWallets = networkAssetIDs.filter(id => assets[id]?.wallet)
  if (!assetsWithWallets.length) return []

  const pending: BridgeTransaction[] = []
  const seen = new Set<string>()

  await Promise.all(assetsWithWallets.map(async (assetID) => {
    try {
      const res = await apiPendingBridges(assetID)
      if (!res.ok) return
      for (const tx of res.bridges) {
        if (seen.has(tx.id)) continue
        seen.add(tx.id)
        pending.push({ ...tx, sourceAssetID: assetID })
      }
    } catch (e) {
      console.error(`Failed to load pending bridges for asset ${assetID}:`, e)
    }
  }))

  pending.sort((a, b) => b.timestamp - a.timestamp)
  return pending
}

// loadBridgeHistory is the per-asset paged history fetcher used by
// both the initial load and subsequent "load more" calls. The
// `refIDByAsset` cursor is per-asset because each network has its
// own history stream; we paginate them in parallel and merge.
//
// When `opts.refIDByAsset` is set, we fetch one extra item (the ref)
// and drop it -- mirroring vanilla's behavior of asking for
// pageSize+1 and slicing off the head when it matches the ref.
async function loadBridgeHistoryInternal (
  assetIDs: number[],
  pageSize: number,
  opts: {
    refIDByAsset?: Record<number, string | null>
    doneByAsset?: Record<number, boolean>
    seedSeenIDs?: Iterable<string>
    logErrMsg: string
  }
): Promise<{
    txs: BridgeTransaction[]
    refIDByAsset: Record<number, string | null>
    doneByAsset: Record<number, boolean>
  }> {
  const txs: BridgeTransaction[] = []
  const seen = new Set<string>(opts.seedSeenIDs)
  const newRef: Record<number, string | null> = { ...(opts.refIDByAsset ?? {}) }
  const newDone: Record<number, boolean> = { ...(opts.doneByAsset ?? {}) }

  const fromRef = !!opts.refIDByAsset

  await Promise.all(assetIDs.map(async (assetID) => {
    const done = newDone[assetID] === true
    const refID = newRef[assetID]
    if (fromRef && (done || !refID)) return

    try {
      const res = fromRef
        ? await apiBridgeHistory(assetID, pageSize + 1, refID as string, true)
        : await apiBridgeHistory(assetID, pageSize, null, true)
      if (!res.ok) {
        newDone[assetID] = true
        if (!fromRef) newRef[assetID] = null
        return
      }
      const fetched = res.bridges

      // Drop the ref entry if the server returned it as the first item.
      const pageTxs = (fromRef && refID && fetched.length && fetched[0]?.id === refID)
        ? fetched.slice(1)
        : fetched

      if (fromRef) {
        if (!pageTxs.length) {
          newDone[assetID] = true
          return
        }
        newRef[assetID] = pageTxs[pageTxs.length - 1].id
        newDone[assetID] = pageTxs.length < pageSize
      } else {
        newRef[assetID] = pageTxs.length ? pageTxs[pageTxs.length - 1].id : null
        newDone[assetID] = pageTxs.length < pageSize
      }

      for (const tx of pageTxs) {
        const id = tx.id
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        txs.push({ ...tx, sourceAssetID: assetID })
      }
    } catch (e) {
      console.error(`${opts.logErrMsg} for asset ${assetID}:`, e)
      newDone[assetID] = true
      if (!fromRef) newRef[assetID] = null
    }
  }))

  return { txs, refIDByAsset: newRef, doneByAsset: newDone }
}

export async function loadInitialBridgeHistory (
  networkAssetIDs: number[],
  pageSize: number,
  assets: Record<number, SupportedAsset>
): Promise<{
    pending: BridgeTransaction[]
    history: BridgeTransaction[]
    refIDByAsset: Record<number, string | null>
    doneByAsset: Record<number, boolean>
  }> {
  if (!networkAssetIDs.length) return { pending: [], history: [], refIDByAsset: {}, doneByAsset: {} }
  const assetsWithWallets = networkAssetIDs.filter(id => assets[id]?.wallet)
  if (!assetsWithWallets.length) return { pending: [], history: [], refIDByAsset: {}, doneByAsset: {} }

  const pending = await loadPendingBridges(assetsWithWallets, assets)

  const { txs: history, refIDByAsset, doneByAsset } = await loadBridgeHistoryInternal(assetsWithWallets, pageSize, {
    seedSeenIDs: pending.flatMap(t => t.id ? [t.id] : []),
    logErrMsg: 'Failed to load bridge history'
  })

  history.sort((a, b) => b.timestamp - a.timestamp)
  return { pending, history, refIDByAsset, doneByAsset }
}

export async function loadMoreBridgeHistory (
  networkAssetIDs: number[],
  pageSize: number,
  refIDByAsset: Record<number, string | null>,
  doneByAsset: Record<number, boolean>,
  assets: Record<number, SupportedAsset>
): Promise<{
    added: BridgeTransaction[]
    refIDByAsset: Record<number, string | null>
    doneByAsset: Record<number, boolean>
  }> {
  const assetsWithWallets = networkAssetIDs.filter(id => assets[id]?.wallet)
  const { txs: added, refIDByAsset: newRef, doneByAsset: newDone } = await loadBridgeHistoryInternal(assetsWithWallets, pageSize, {
    refIDByAsset,
    doneByAsset,
    logErrMsg: 'Failed to load more bridge history'
  })

  return { added, refIDByAsset: newRef, doneByAsset: newDone }
}
