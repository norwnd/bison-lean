import { create } from 'zustand'
import type {
  BalanceNote, WalletStateNote, WalletSyncNote, SpotPriceNote,
  RateNote, WalletCreationNote, ConnEventNote, TransactionNote,
  WalletState
} from './types'
import { useAuthStore } from './useAuthStore'

// useMarketStore handles real-time updates to assets/wallets/exchanges
// that come in via WebSocket notifications. It reads/writes through
// useAuthStore for the actual data, providing update actions.
//
// All handlers here use immutable updates - never mutate the inner
// objects held by the auth store. The previous in-place mutation
// pattern (e.g. `walletMap[id].balance = note.balance` followed by a
// shallow `{ ...walletMap }` spread) "worked" only because consumers
// happened to read through the same object identity, so the mutated
// fields were observable on re-render. That's a hidden coupling: any
// memo or effect with a narrower dep (e.g. `[currentMkt]` instead of
// `[currentMkt.spot]`) would silently miss the update because the
// outer ref never changed. Replacing every changed object up the tree
// (wallet → asset/walletMap entry → outer map; market → exchange →
// exchanges map) makes the change visible to React's structural
// equality checks all the way up, so a future memo with a narrower
// dep can't accidentally regress reactivity.

// patchWallet applies an immutable patch to the wallet for assetID.
//
// Resolves the source wallet from `assets[id].wallet` first, falling
// back to `walletMap[id]`. After fetchUser, buildWalletMap aliases
// these to the same reference - we look up via assets first because
// that's where wallet creation actually lands; walletMap is the
// projection. If neither has a wallet, the call no-ops.
//
// Builds the next wallet via patch(), then triple-replaces (wallet ->
// assets[id] -> walletMap[id]) so the walletMap[id] === assets[id]
// .wallet alias invariant survives the update. The `assets[id]`
// branch is conditional because assets may not have an entry for
// every assetID we track in walletMap (e.g. tokens that lost their
// parent asset config); walletMap is always written.
//
// Returning the same ref from patch() is a no-op (skips setState).
// Use this when the patch couldn't find anything to change - it
// avoids spurious re-renders without scattering early-return
// branches across the handlers.
function patchWallet (
  assetID: number,
  patch: (w: WalletState) => WalletState
): void {
  const { assets, walletMap } = useAuthStore.getState()
  const sourceWallet = assets[assetID]?.wallet ?? walletMap[assetID]
  if (!sourceWallet) return
  const nextWallet = patch(sourceWallet)
  if (nextWallet === sourceWallet) return
  const nextAssets = { ...assets }
  if (assets[assetID]) {
    nextAssets[assetID] = { ...assets[assetID], wallet: nextWallet }
  }
  const nextWalletMap = { ...walletMap, [assetID]: nextWallet }
  useAuthStore.setState({ assets: nextAssets, walletMap: nextWalletMap })
}

interface MarketState {
  handleBalanceNote: (note: BalanceNote) => void
  handleWalletStateNote: (note: WalletStateNote) => void
  handleWalletSyncNote: (note: WalletSyncNote) => void
  handleTransactionNote: (note: TransactionNote) => void
  handleSpotPriceNote: (note: SpotPriceNote) => void
  handleRateNote: (note: RateNote) => void
  handleWalletCreationNote: (note: WalletCreationNote) => void
  handleConnEventNote: (note: ConnEventNote) => void
}

export const useMarketStore = create<MarketState>(() => ({
  handleBalanceNote: (note: BalanceNote) => {
    patchWallet(note.assetID, w => ({ ...w, balance: note.balance }))
  },

  // walletstate replaces the wallet wholesale, so we don't go through
  // patchWallet (which only patches an existing wallet). The note's
  // own `wallet` is the authoritative new value; we always write it
  // to walletMap, and conditionally graft it onto `assets[id]` when
  // we have an entry for that asset. Same triple-replacement shape
  // as patchWallet, just with a fixed source.
  handleWalletStateNote: (note: WalletStateNote) => {
    const { assets, walletMap } = useAuthStore.getState()
    const assetID = note.wallet.assetID
    const nextAssets = { ...assets }
    const nextWalletMap = { ...walletMap, [assetID]: note.wallet }
    if (assets[assetID]) {
      nextAssets[assetID] = { ...assets[assetID], wallet: note.wallet }
    }
    useAuthStore.setState({ assets: nextAssets, walletMap: nextWalletMap })
  },

  handleWalletSyncNote: (note: WalletSyncNote) => {
    patchWallet(note.assetID, w => ({
      ...w,
      syncStatus: note.syncStatus,
      syncProgress: note.syncProgress
    }))
  },

  // Merge a single tx update into wallet.pendingTxs. Mirrors vanilla
  // wallets.ts handleTxNote (fc634606:client/webserver/site/src/js
  // /wallets.ts:2090): on confirm, drop the entry; otherwise upsert.
  //
  // Vanilla also gated the upsert on tx.timestamp > 0; we don't.
  // The DCR wallet legitimately resets Timestamp to 0 when a
  // previously-mined tx gets reorged back to mempool (see dcr.go
  // L7647), and the gate would silently drop that update, leaving
  // the local copy with stale block-confirm state until something
  // else triggers a refresh. The backend only emits TransactionNote
  // for txs already in its xcWallet.pendingTxs map, so always
  // upserting on the not-confirmed branch is safe - we can't add a
  // tx that shouldn't be there.
  handleTransactionNote: (note: TransactionNote) => {
    const tx = note.transaction
    if (!tx?.id) return
    patchWallet(note.assetID, w => {
      const prev = w.pendingTxs ?? {}
      if (tx.confirmed) {
        if (!(tx.id in prev)) return w
        const next = { ...prev }
        delete next[tx.id]
        return { ...w, pendingTxs: next }
      }
      return { ...w, pendingTxs: { ...prev, [tx.id]: tx } }
    })
  },

  handleSpotPriceNote: (note: SpotPriceNote) => {
    const { exchanges } = useAuthStore.getState()
    const xc = exchanges[note.host]
    if (!xc) return
    let touched = false
    const nextMarkets: typeof xc.markets = { ...xc.markets }
    for (const [mktName, spot] of Object.entries(note.spots)) {
      const mkt = nextMarkets[mktName]
      if (!mkt) continue
      nextMarkets[mktName] = { ...mkt, spot }
      touched = true
    }
    if (!touched) return
    const nextExchanges = {
      ...exchanges,
      [note.host]: { ...xc, markets: nextMarkets }
    }
    useAuthStore.setState({ exchanges: nextExchanges })
  },

  handleRateNote: (note: RateNote) => {
    useAuthStore.setState({ fiatRatesMap: note.fiatRates })
  },

  handleWalletCreationNote: (_note: WalletCreationNote) => {
    // Wallet creation requires a full user refetch to get the new wallet state.
    useAuthStore.getState().fetchUser()
  },

  handleConnEventNote: (note: ConnEventNote) => {
    // MP-64: the immutable replacement of `xc` (rather than mutating
    // `xc.connectionStatus` in place) is what makes `currentXc` invalidate
    // in React and re-runs the `MarketsPage` market-subscription effect
    // on bisonw↔DEX reconnect. Vanilla's `handleConnNote` triggers
    // `loadPage('markets')` for a full re-init; the React equivalent
    // falls out of changing the React identity of `currentXc`.
    const { exchanges } = useAuthStore.getState()
    const xc = exchanges[note.host]
    if (!xc) return
    const nextExchanges = {
      ...exchanges,
      [note.host]: { ...xc, connectionStatus: note.connectionStatus }
    }
    useAuthStore.setState({ exchanges: nextExchanges })
  },
}))
