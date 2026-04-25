import { create } from 'zustand'
import { getJSON, postJSON } from '../services/api'
import { useNotificationStore } from './useNotificationStore'
import { applyRateStepMagnifyingFactors } from './rateStepConfig'
import type { User, SupportedAsset, Exchange, UnitInfo, WalletState, MarketMakingStatus, CoreNote, UserResponse, LoginResponse } from './types'

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

export interface AuthState {
  user: User | null
  authed: boolean
  inited: boolean
  initialFetchDone: boolean
  lang: string
  onionUrl: string
  companionAppPaired: boolean
  seedGenTime: number
  commitHash: string
  assets: Record<number, SupportedAsset>
  exchanges: Record<string, Exchange>
  walletMap: Record<number, WalletState>
  fiatRatesMap: Record<number, number>
  mmStatus: MarketMakingStatus | null
  // authFailed: per-host DEX auth error message. Populated by the
  // `dex_auth` note dispatcher in AppLayout when `authenticated=false`
  // arrives with a DexAuthError* topic. Cleared when a subsequent
  // `/api/user` refresh shows the DEX as authed, or on logout.
  authFailed: Record<string, string>

  fetchUser: () => Promise<User | null>
  fetchBuildInfo: () => Promise<void>
  login: (appPass: string) => Promise<LoginResult>
  logout: (force?: boolean) => Promise<LogoutResult>
  setAuthFailed: (host: string, msg: string) => void
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

export const useAuthStore = create<AuthState>((set, get) => {
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
        onionUrl: resp.onionUrl,
        companionAppPaired: resp.companionAppPaired,
      })
      return null
    }
    // Clear authFailed entries for any host that is now authed — a stale
    // error from a prior login attempt shouldn't linger once Core signals
    // success via the refreshed user payload.
    const prevFailed = get().authFailed
    let nextFailed = prevFailed
    let changed = false
    for (const [host, xc] of Object.entries(user.exchanges)) {
      if (xc.authed && prevFailed[host]) {
        if (!changed) { nextFailed = { ...prevFailed }; changed = true }
        delete nextFailed[host]
      }
    }
    applyRateStepMagnifyingFactors(user.exchanges)
    set({
      user,
      authed: true,
      inited: resp.inited,
      initialFetchDone: true,
      lang: resp.lang,
      onionUrl: resp.onionUrl,
      companionAppPaired: resp.companionAppPaired,
      seedGenTime: user.seedgentime,
      assets: user.assets,
      exchanges: user.exchanges,
      walletMap: buildWalletMap(user.assets),
      fiatRatesMap: user.fiatRates,
      mmStatus: resp.mmStatus,
      ...(changed ? { authFailed: nextFailed } : {}),
    })
    return user
  }

  return {
    user: null,
    authed: false,
    inited: false,
    initialFetchDone: false,
    lang: 'en-US',
    onionUrl: '',
    companionAppPaired: false,
    seedGenTime: 0,
    commitHash: '',
    assets: {},
    exchanges: {},
    walletMap: {},
    fiatRatesMap: {},
    mmStatus: null,
    authFailed: {},

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
      // Server convention (matching dev2 expectations): `notes` arrive
      // newest-first, `pokes` arrive oldest-first. The store invariant
      // is "index 0 is newest" (notify() prepends new arrivals), so we
      // store notes as-is and reverse pokes. Dev2 didn't reverse pokes
      // explicitly because its `setPokes()` walked the array calling
      // `prependPokeElement` — that inversion is gone in React, so we
      // do the reverse here instead.
      const notes: CoreNote[] = resp.notes || []
      const pokes: CoreNote[] = (resp.pokes || []).slice().reverse()
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
        authFailed: {},
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

    setAuthFailed: (host: string, msg: string) => {
      set({ authFailed: { ...get().authFailed, [host]: msg } })
    },
  }
})

// selectUnitInfo resolves the `UnitInfo` for an asset, preferring the
// per-DEX asset entry (carries the protocol-accurate UnitInfo the server
// handshake returned) and falling back to the client-side
// `assets[id].unitInfo` (global default, populated from `/api/user`).
// Returns null when neither source resolves.
//
// Co-located with the store so consumers can pass the store state
// directly:
//
//   const bui = useAuthStore(s =>
//     selected ? selectUnitInfo(s, selected.host, selected.baseID) : null
//   )
//
// The value returned is ref-stable across spot and balance notes (neither
// handler rebuilds `assets[id]` or `exchanges[host].assets[id]`), so
// Zustand's default `Object.is` equality short-circuits downstream
// re-renders — this is the same property that `CL-MP-RERENDER-CASCADE`
// (Fix B) relied on to kill the spot-note cascade.
export function selectUnitInfo (
  s: AuthState,
  host: string,
  assetID: number
): UnitInfo | null {
  return s.exchanges[host]?.assets[assetID]?.unitInfo ??
    s.assets[assetID]?.unitInfo ?? null
}
