import { create } from 'zustand'
import { getJSON, postJSON } from '../services/api'
import { useNotificationStore } from './useNotificationStore'
import type { User, SupportedAsset, Exchange, WalletState, MarketMakingStatus, CoreNote, UserResponse } from './types'

// LoginResult mirrors vanilla `LoginForm.submit()` (forms.ts L1822) which
// distinguishes "request failed → show server msg" from "request ok →
// process notes/pokes and continue". The discriminated union surfaces the
// server's error message so the LoginForm can display it (matching
// vanilla's `Doc.showFormError(page.errMsg, res.msg)`) instead of falling
// back to a hardcoded "Login failed" string.
export type LoginResult =
  | { ok: true }
  | { ok: false, msg: string }

interface AuthState {
  user: User | null
  authed: boolean
  inited: boolean
  initialFetchDone: boolean
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
  login: (appPass: string) => Promise<LoginResult>
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
  initialFetchDone: false,
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
    if (!resp.requestSuccessful) {
      set({ initialFetchDone: true })
      return null
    }
    const user = resp.user
    if (!user) {
      set({
        inited: resp.inited,
        authed: false,
        initialFetchDone: true,
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
      initialFetchDone: true,
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
    if (!resp.requestSuccessful || !resp.ok) {
      return { ok: false, msg: resp.msg || 'login failed' }
    }
    // Mirror vanilla `login.ts` `submit()` ordering: fetch the user
    // first so subscribers that react to a notification arrival can see
    // the populated `user`/`assets`/`exchanges` state, then deliver the
    // pre-login notification backlog.
    await get().fetchUser()
    // Vanilla reverses the notes backlog before passing it to
    // `setNotes()` so chronologically older entries sit at lower indices
    // — matching `prependNoteElement`'s push-append order. `pokes` are
    // not reversed in vanilla.
    const notes: CoreNote[] = (resp.notes || []).slice().reverse()
    const pokes: CoreNote[] = resp.pokes || []
    const noteStore = useNotificationStore.getState()
    noteStore.setNotes(notes)
    noteStore.setPokes(pokes)
    return { ok: true }
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
    // Clear the notification cache too so a subsequent re-login starts
    // from a clean slate. Without this, stale notes/pokes from the
    // previous session would briefly remain visible until the next
    // `login()` overwrites them via `setNotes`/`setPokes`.
    const noteStore = useNotificationStore.getState()
    noteStore.setNotes([])
    noteStore.setPokes([])
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
