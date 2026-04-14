import { create } from 'zustand'
import type {
  BalanceNote, WalletStateNote, WalletSyncNote, SpotPriceNote,
  RateNote, WalletCreationNote, ConnEventNote
} from './types'
import { useAuthStore } from './useAuthStore'

// useMarketStore handles real-time updates to assets/wallets/exchanges
// that come in via WebSocket notifications. It reads/writes through
// useAuthStore for the actual data, providing update actions.
//
// All handlers here use immutable updates — never mutate the inner
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

interface MarketState {
  handleBalanceNote: (note: BalanceNote) => void
  handleWalletStateNote: (note: WalletStateNote) => void
  handleWalletSyncNote: (note: WalletSyncNote) => void
  handleSpotPriceNote: (note: SpotPriceNote) => void
  handleRateNote: (note: RateNote) => void
  handleWalletCreationNote: (note: WalletCreationNote) => void
  handleConnEventNote: (note: ConnEventNote) => void
}

export const useMarketStore = create<MarketState>(() => ({
  handleBalanceNote: (note: BalanceNote) => {
    const { assets, walletMap } = useAuthStore.getState()
    const asset = assets[note.assetID]
    // After fetchUser, `buildWalletMap` aliases `walletMap[id]` to
    // `assets[id].wallet` — they're the same reference. Preserve that
    // invariant by building ONE new wallet object and pointing both
    // collections at it. Otherwise consumers reading through
    // `assets[id].wallet.balance` would see the stale value while
    // consumers reading through `walletMap[id].balance` would see the
    // fresh one.
    const sourceWallet = asset?.wallet ?? walletMap[note.assetID]
    if (!sourceWallet) return
    const nextWallet = { ...sourceWallet, balance: note.balance }
    const nextAssets = { ...assets }
    if (asset) {
      nextAssets[note.assetID] = { ...asset, wallet: nextWallet }
    }
    const nextWalletMap = { ...walletMap, [note.assetID]: nextWallet }
    useAuthStore.setState({ assets: nextAssets, walletMap: nextWalletMap })
  },

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
    const { assets, walletMap } = useAuthStore.getState()
    const w = walletMap[note.assetID]
    if (!w) return
    // Preserve the `walletMap[id] === assets[id].wallet` invariant —
    // see handleBalanceNote for the rationale.
    const nextWallet = {
      ...w,
      syncStatus: note.syncStatus,
      syncProgress: note.syncProgress
    }
    const nextAssets = { ...assets }
    if (assets[note.assetID]) {
      nextAssets[note.assetID] = { ...assets[note.assetID], wallet: nextWallet }
    }
    const nextWalletMap = { ...walletMap, [note.assetID]: nextWallet }
    useAuthStore.setState({ assets: nextAssets, walletMap: nextWalletMap })
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
