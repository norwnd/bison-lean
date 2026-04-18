import { create } from 'zustand'
import { getJSON, postJSON } from '../services/api'
import { useNotificationStore } from './useNotificationStore'
import type { User, SupportedAsset, Exchange, WalletState, MarketMakingStatus, CoreNote, UserResponse, LoginResponse } from './types'

// LoginResult mirrors vanilla `LoginForm.submit()` (forms.ts L1822) which
// distinguishes "request failed → show server msg" from "request ok →
// process notes/pokes and continue". The discriminated union surfaces the
// server's error message so the LoginForm can display it (matching
// vanilla's `Doc.showFormError(page.errMsg, res.msg)`) instead of falling
// back to a hardcoded "Login failed" string.
export type LoginResult =
  | { ok: true }
  | { ok: false, msg: string }

// LogoutResult mirrors the login/logout error-surfacing pattern.
// Vanilla `app.ts` `signOut()` branches on `res.code ===
// Errors.activeOrdersErr` to show a distinct message — the discriminated
// union preserves that `code` so callers can special-case it.
export type LogoutResult =
  | { ok: true }
  | { ok: false, msg: string, code?: number }

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
  logout: (force?: boolean) => Promise<LogoutResult>
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

export const useAuthStore = create<AuthState>((set) => {
  // applyUserResponse hydrates the store from a `/api/user` or `/api/login`
  // payload. Returns the hydrated User or null when the response carries no
  // user (e.g. unauthenticated `/api/user` call on first page load).
  const applyUserResponse = (resp: UserResponse): User | null => {
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
  }

  return {
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
      return applyUserResponse(resp)
    },

    fetchBuildInfo: async () => {
      const resp = await getJSON('/api/buildinfo')
      if (resp.requestSuccessful && resp.ok) {
        set({ commitHash: resp.commitHash || '' })
      }
    },

    login: async (appPass: string) => {
      const resp: LoginResponse = await postJSON('/api/login', { pass: appPass })
      if (!resp.requestSuccessful || !resp.ok) {
        return { ok: false, msg: resp.msg || 'login failed' }
      }
      // Hydrate the store from the folded user payload FIRST so any
      // subscribers that react to note delivery can see populated
      // `user`/`assets`/`exchanges` state, then deliver the pre-login
      // notification backlog.
      applyUserResponse(resp)
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

    logout: async (force?: boolean) => {
      // The server registers `/api/logout` as POST (webserver.go
      // `apiAuth.Post("/logout", ...)`); a GET request would fail with
      // 405. Also check the response before clearing state so an
      // `activeOrdersErr` from core doesn't result in a half-logged-out
      // client (auth state cleared, but server session still live).
      // `force=true` asks the server to skip the active-orders check —
      // callers use this after explicit user confirmation.
      const res = await postJSON('/api/logout', { force: !!force })
      if (!res.requestSuccessful || !res.ok) {
        return { ok: false, msg: res.msg, code: res.code }
      }
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
      return { ok: true }
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
  }
})
