import { create } from 'zustand'
import { getJSON, postJSON } from '../services/api'
import type { User, SupportedAsset, Exchange, WalletState, MarketMakingStatus, CoreNote, UserResponse } from './types'

interface AuthState {
  user: User | null
  authed: boolean
  inited: boolean
  lang: string
  langs: string[]
  onionUrl: string
  companionAppPaired: boolean
  seedGenTime: number
  commitHash: string
  assets: Record<number, SupportedAsset>
  exchanges: Record<string, Exchange>
  walletMap: Record<number, WalletState>
  fiatRatesMap: Record<number, number>
  mmStatus: MarketMakingStatus | null

  fetchUser: () => Promise<User | null>
  fetchBuildInfo: () => Promise<void>
  login: (appPass: string) => Promise<{ notes: CoreNote[], pokes: CoreNote[] } | null>
  logout: () => Promise<void>
  setUser: (user: User) => void
}

function buildWalletMap (assets: Record<number, SupportedAsset>): Record<number, WalletState> {
  const walletMap: Record<number, WalletState> = {}
  for (const [idStr, asset] of Object.entries(assets)) {
    if (asset.wallet) {
      walletMap[Number(idStr)] = asset.wallet
    }
  }
  return walletMap
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  authed: false,
  inited: false,
  lang: 'en-US',
  langs: ['en-US'],
  onionUrl: '',
  companionAppPaired: false,
  seedGenTime: 0,
  commitHash: '',
  assets: {},
  exchanges: {},
  walletMap: {},
  fiatRatesMap: {},
  mmStatus: null,

  fetchUser: async () => {
    const resp: UserResponse = await getJSON('/api/user')
    if (!resp.requestSuccessful) return null
    const user = resp.user
    if (!user) {
      set({
        inited: resp.inited,
        authed: false,
        lang: resp.lang,
        langs: resp.langs,
        onionUrl: resp.onionUrl,
        companionAppPaired: resp.companionAppPaired,
      })
      return null
    }
    set({
      user,
      authed: true,
      inited: resp.inited,
      lang: resp.lang,
      langs: resp.langs,
      onionUrl: resp.onionUrl,
      companionAppPaired: resp.companionAppPaired,
      seedGenTime: user.seedgentime,
      assets: user.assets,
      exchanges: user.exchanges,
      walletMap: buildWalletMap(user.assets),
      fiatRatesMap: user.fiatRates,
      mmStatus: resp.mmStatus,
    })
    return user
  },

  fetchBuildInfo: async () => {
    const resp = await getJSON('/api/buildinfo')
    if (resp.requestSuccessful && resp.ok) {
      set({ commitHash: resp.commitHash || '' })
    }
  },

  login: async (appPass: string) => {
    const resp = await postJSON('/api/login', { pass: appPass })
    if (!resp.requestSuccessful || !resp.ok) return null
    const notes: CoreNote[] = resp.notes || []
    const pokes: CoreNote[] = resp.pokes || []
    // After login, fetch user to populate state.
    await get().fetchUser()
    return { notes, pokes }
  },

  logout: async () => {
    await getJSON('/api/logout')
    set({
      user: null,
      authed: false,
      assets: {},
      exchanges: {},
      walletMap: {},
      fiatRatesMap: {},
      mmStatus: null,
    })
  },

  setUser: (user: User) => {
    set({
      user,
      assets: user.assets,
      exchanges: user.exchanges,
      walletMap: buildWalletMap(user.assets),
      fiatRatesMap: user.fiatRates,
    })
  },
}))
