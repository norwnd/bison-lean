import { create } from 'zustand'
import type {
  BalanceNote, WalletStateNote, WalletSyncNote, SpotPriceNote,
  RateNote, WalletCreationNote, ConnEventNote
} from './types'
import { useAuthStore } from './useAuthStore'

// useMarketStore handles real-time updates to assets/wallets/exchanges
// that come in via WebSocket notifications. It reads/writes through
// useAuthStore for the actual data, providing update actions.

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
    if (asset && asset.wallet) {
      asset.wallet.balance = note.balance
    }
    if (walletMap[note.assetID]) {
      walletMap[note.assetID].balance = note.balance
    }
    useAuthStore.setState({ assets: { ...assets }, walletMap: { ...walletMap } })
  },

  handleWalletStateNote: (note: WalletStateNote) => {
    const { assets, walletMap } = useAuthStore.getState()
    const assetID = note.wallet.assetID
    if (assets[assetID]) {
      assets[assetID].wallet = note.wallet
    }
    walletMap[assetID] = note.wallet
    useAuthStore.setState({ assets: { ...assets }, walletMap: { ...walletMap } })
  },

  handleWalletSyncNote: (note: WalletSyncNote) => {
    const { walletMap } = useAuthStore.getState()
    const w = walletMap[note.assetID]
    if (w) {
      w.syncStatus = note.syncStatus
      w.syncProgress = note.syncProgress
      useAuthStore.setState({ walletMap: { ...walletMap } })
    }
  },

  handleSpotPriceNote: (note: SpotPriceNote) => {
    const { exchanges } = useAuthStore.getState()
    const xc = exchanges[note.host]
    if (!xc) return
    for (const [mktName, spot] of Object.entries(note.spots)) {
      const mkt = xc.markets[mktName]
      if (mkt) mkt.spot = spot
    }
    useAuthStore.setState({ exchanges: { ...exchanges } })
  },

  handleRateNote: (note: RateNote) => {
    useAuthStore.setState({ fiatRatesMap: note.fiatRates })
  },

  handleWalletCreationNote: (_note: WalletCreationNote) => {
    // Wallet creation requires a full user refetch to get the new wallet state.
    useAuthStore.getState().fetchUser()
  },

  handleConnEventNote: (note: ConnEventNote) => {
    const { exchanges } = useAuthStore.getState()
    const xc = exchanges[note.host]
    if (!xc) return
    xc.connectionStatus = note.connectionStatus
    useAuthStore.setState({ exchanges: { ...exchanges } })
  },
}))
