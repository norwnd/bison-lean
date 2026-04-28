import { create } from 'zustand'
import { getJSON, postJSON } from '../services/api'
import { useNotificationStore } from './useNotificationStore'
import { useActionRequiredStore } from './useActionRequiredStore'
import { applyRateStepMagnifyingFactors } from './rateStepConfig'
import type { User, SupportedAsset, Exchange, UnitInfo, WalletState, MarketMakingStatus, CoreNote, UserResponse, LoginResponse, ReputationNote, BondNote } from './types'

// Live-store invariant for `exchanges` / `assets` / friends:
//
//   - Hydrated up-front by `applyUserResponse` (login response + WS-
//     open `fetchUser`).
//   - Kept in sync thereafter by typed merge functions - one per WS
//     note that changes persistent state (`applyReputationNote`,
//     `applyBondPostNote`, etc.). New note types should add a typed
//     merge here, wired into the AppLayout dispatcher; do NOT route
//     them through pages.
//   - Pages subscribe to store slices via `useAuthStore(s => ...)`
//     and re-render automatically. They should never call fetchUser
//     or trigger forceReRender to "see fresh data" - the invariant
//     above guarantees the slice is current.
//
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
// Errors.activeOrdersErr` to show a distinct message - the discriminated
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
  // initInProgress is true while the user is mid-flow on InitPage,
  // between /api/init succeeding and the final navigate to /wallets.
  // InitGuard honours this so a refresh of the auth store (which would
  // otherwise flip `inited` to true and bounce the user away from /init)
  // doesn't clobber the QuickConfig / SeedBackup steps.
  initInProgress: boolean

  fetchUser: () => Promise<User | null>
  fetchBuildInfo: () => Promise<void>
  login: (appPass: string) => Promise<LoginResult>
  logout: (force?: boolean) => Promise<LogoutResult>
  setAuthFailed: (host: string, msg: string) => void
  setInitInProgress: (v: boolean) => void
  // applyReputationNote merges the `rep` payload of a `reputation`
  // note into `exchanges[host].auth.rep` and recomputes
  // `effectiveTier` (BondedTier − Penalties, mirroring server
  // `Reputation.EffectiveTier()` in `server/account/account.go`).
  // No-op if the host is not yet in the store - the next /api/user
  // refresh will catch it.
  applyReputationNote: (note: ReputationNote) => void
  // applyBondPostNote merges a `bondpost` note. When `note.auth` is
  // present, the server has handed us the full updated ExchangeAuth
  // for the host (post-confirmation, post-registration, expiry,
  // BondAuthUpdate) - replace auth wholesale. When `note.auth` is
  // null, the note is informational (in-flight confirmation count
  // or error) and we skip the merge.
  applyBondPostNote: (note: BondNote) => void
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
  // sessionResetState is the slice of AuthState that represents
  // "no logged-in user, no per-session cache". Shared by `logout()` and
  // the user=null branch of applyUserResponse so the two paths stay in
  // sync - every per-session field that one clears, the other clears too.
  const sessionResetState = {
    user: null,
    authed: false,
    seedGenTime: 0,
    assets: {},
    exchanges: {},
    walletMap: {},
    fiatRatesMap: {},
    mmStatus: null,
    authFailed: {},
  } as const

  // clearSessionCaches resets the per-session caches that live in OTHER
  // stores (notification + action-required). Called alongside a
  // `set(sessionResetState)` whenever the auth store transitions to a
  // logged-out state.
  const clearSessionCaches = () => {
    const noteStore = useNotificationStore.getState()
    noteStore.setNotes([])
    noteStore.setPokes([])
    useActionRequiredStore.getState().reset()
  }

  // applyUserResponse hydrates the store from a `/api/user` or `/api/login`
  // payload. Returns the hydrated User or null when the response carries no
  // user (e.g. unauthenticated `/api/user` call on first page load, or a
  // reconnect after the server restarted on a wiped DB). The user=null
  // branch mirrors `logout()` so a server-driven session loss can't leave
  // stale per-session caches (notes, pokes, exchanges, action-required
  // queue) sitting in the store. Without this, e.g. the bell's `ackNotes`
  // would later send IDs from the prior session over the WS, and Core
  // would log "notification not found" against a fresh DB.
  const applyUserResponse = (resp: UserResponse): User | null => {
    const user = resp.user
    if (!user) {
      set({
        ...sessionResetState,
        inited: resp.inited,
        initialFetchDone: true,
        lang: resp.lang,
        onionUrl: resp.onionUrl,
        companionAppPaired: resp.companionAppPaired,
      })
      clearSessionCaches()
      return null
    }
    // Clear authFailed entries for any host that is now authed - a stale
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
    // Seed the action-required queue from the server's
    // `User.actions[]` backlog. Core persists the latest unresolved
    // actionrequired per uniqueID across restarts and replays them on
    // /api/user; without seeding, a stuck-tx prompt that fired before
    // the page loaded would be silently dropped until the wallet
    // re-emits on its next checkPendingTxs tick.
    useActionRequiredStore.getState().seed(user.actions || [])
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
    initInProgress: false,

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
      // `prependPokeElement` - that inversion is gone in React, so we
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
      // `force=true` asks the server to skip the active-orders check -
      // callers use this after explicit user confirmation.
      const res = await postJSON('/api/logout', { force: !!force })
      if (!res.requestSuccessful || !res.ok) {
        return { ok: false, msg: res.msg, code: res.code }
      }
      // Reset the auth slice and the per-session caches in one go so a
      // subsequent re-login starts from a clean slate - stale notes,
      // pokes, or action-required prompts from the previous session
      // would otherwise stay visible until `login()` overwrites them.
      set(sessionResetState)
      clearSessionCaches()
      return { ok: true }
    },

    setAuthFailed: (host: string, msg: string) => {
      set({ authFailed: { ...get().authFailed, [host]: msg } })
    },

    setInitInProgress: (v: boolean) => {
      set({ initInProgress: v })
    },

    applyReputationNote: (note: ReputationNote) => {
      const { exchanges } = get()
      const xc = exchanges[note.host]
      if (!xc?.auth) return
      const rep = note.rep
      // EffectiveTier mirrors `(*Reputation).EffectiveTier()` in
      // server/account/account.go: BondedTier − Penalties. The note
      // doesn't carry effectiveTier explicitly, so we recompute it
      // here. Trivial formula, low drift risk, but if the server
      // ever changes this calculation, both sides need to move.
      const effectiveTier = rep.bondedTier - rep.penalties
      set({
        exchanges: {
          ...exchanges,
          [note.host]: {
            ...xc,
            auth: {
              ...xc.auth,
              rep,
              effectiveTier,
            },
          },
        },
      })
    },

    applyBondPostNote: (note: BondNote) => {
      if (!note.auth) return
      const { exchanges } = get()
      const xc = exchanges[note.dex]
      if (!xc) return
      set({
        exchanges: {
          ...exchanges,
          [note.dex]: {
            ...xc,
            auth: note.auth,
          },
        },
      })
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
// re-renders - this is the same property that `CL-MP-RERENDER-CASCADE`
// (Fix B) relied on to kill the spot-note cascade.
export function selectUnitInfo (
  s: AuthState,
  host: string,
  assetID: number
): UnitInfo | null {
  return s.exchanges[host]?.assets[assetID]?.unitInfo ??
    s.assets[assetID]?.unitInfo ?? null
}
