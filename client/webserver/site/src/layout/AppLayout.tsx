import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useWebSocketStore } from '../stores/useWebSocketStore'
import { useNotificationStore } from '../stores/useNotificationStore'
import { useActionRequiredStore } from '../stores/useActionRequiredStore'
import { useMarketStore } from '../stores/useMarketStore'
import { useMMStore } from '../stores/useMMStore'
import { useUIStore } from '../stores/useUIStore'
import { useTrackLastVisitedPage } from '../router/lastVisitedPage'
import { Header } from './Header'
import { NewUserBanner } from './NewUserBanner'
import { PopupNotes } from '../components/notifications/PopupNotes'
import { ActionRequiredDialog } from '../components/notifications/ActionRequiredDialog'
import { handleAutoBumpCapped } from '../components/notifications/autoBumpCappedToast'
import { handleLostNonce } from '../components/notifications/lostNonceToast'
import { networkSuffix } from '../components/notifications/actionRequiredUtils'
import type { ActionRequiredNote, ActionResolvedNote, AutoBumpCappedNote, CustomWalletNote, LostNonceNote, WalletNote } from '../stores/types'

// Data-freshness contract for the React app:
//
//   1. After every successful WS open (initial connect AND every
//      reconnect), `fetchUser()` runs. This is the foundation —
//      anything that happened between login and the WS subscriber
//      being live (post-login DEX auth completion, server-side state
//      change before our handlers were registered, etc.) is caught up
//      via /api/user before pages render off the store.
//
//   2. Every WS note that changes persistent state has a typed merge
//      handler in this dispatcher. Notes carrying the new payload
//      (`reputation`, `bondpost`) feed `applyReputationNote` /
//      `applyBondPostNote` which mutate the auth slice in place — no
//      /api/user round trip. Notes that only carry signals or partial
//      payloads (`feepayment`) fall back to fetchUser.
//
//   3. Pages SHOULD NOT call fetchUser, force re-renders, or
//      otherwise duplicate this dispatcher's job. They subscribe to
//      store slices and re-render automatically. Page-level
//      `useNotifications` hooks are reserved for *ephemeral* effects
//      (toasts, animations, in-flight wizard state, route-bound
//      reload triggers) — never for "make my page see fresh data".
//
// If a page exhibits stale data, the fix is in this dispatcher (or
// in the relevant store's typed merge), not in the page.
export function AppLayout () {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const fetchBuildInfo = useAuthStore(s => s.fetchBuildInfo)
  const applyReputationNote = useAuthStore(s => s.applyReputationNote)
  const applyBondPostNote = useAuthStore(s => s.applyBondPostNote)
  const connect = useWebSocketStore(s => s.connect)
  const subscribe = useWebSocketStore(s => s.subscribe)
  const notify = useNotificationStore(s => s.notify)
  const enqueueAction = useActionRequiredStore(s => s.enqueue)
  const resolveAction = useActionRequiredStore(s => s.resolve)
  const darkMode = useUIStore(s => s.darkMode)

  const {
    handleBalanceNote, handleWalletStateNote, handleWalletSyncNote,
    handleSpotPriceNote, handleRateNote, handleWalletCreationNote,
    handleConnEventNote,
  } = useMarketStore()

  const { handleRunStatsNote, handleEpochReportNote, handleCEXProblemsNote } = useMMStore()

  // Persist the current route to localStorage on every navigation so
  // login (and the `/` index route) can restore it.
  useTrackLastVisitedPage()

  useEffect(() => {
    document.body.classList.toggle('dark', darkMode)
  }, [darkMode])

  // Initial data fetch — runs once on mount.
  useEffect(() => {
    fetchUser()
    fetchBuildInfo()
  }, [])

  // WebSocket connection — reactive to user becoming available.
  // When the user logs in (user goes from null → object), this effect fires
  // and connects the WS. On page refresh with an active session, fetchUser()
  // populates user immediately, so this also runs on the first render cycle.
  const wsInitRef = useRef(false)
  useEffect(() => {
    if (!user || wsInitRef.current) return
    wsInitRef.current = true

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUri = `${proto}://${window.location.host}/ws`

    connect(wsUri, () => {
      // Fires on every WS open — first connect AND every reconnect.
      // Refetching here is the foundation of the store's "live after
      // open" invariant: any auth completion / notification activity
      // that happened between login and this subscriber being live
      // (or while the WS was closed) is caught up via /api/user before
      // pages start rendering off the store.
      fetchUser()
    })

    // Register the global notification route.
    subscribe('notify', (note: any) => {
      notify(note)
      // Dispatch to typed handlers based on note type.
      switch (note.type) {
        case 'balance': handleBalanceNote(note); break
        case 'walletstate': handleWalletStateNote(note); break
        case 'walletconfig': handleWalletStateNote(note); break
        case 'walletsync': handleWalletSyncNote(note); break
        case 'spots': handleSpotPriceNote(note); break
        case 'fiatrateupdate': handleRateNote(note); break
        case 'createwallet': handleWalletCreationNote(note); break
        case 'conn': {
          handleConnEventNote(note)
          // DEX (re)connection or admin enable can change more than
          // just connectionStatus — markets list, bondAssets, fee
          // configs, even auth state may have changed during the
          // outage / while disabled. Refresh the full /api/user so
          // pages reading from the store see the updated shape; on
          // disconnect/disable, skip the fetch (the note itself is
          // the new truth — nothing to retrieve).
          if (note.topic === 'DEXConnected' || note.topic === 'DEXEnabled') {
            fetchUser()
          }
          break
        }
        // Reputation / bondpost notes carry the new auth state in their
        // payloads, so we merge directly instead of refetching /api/user.
        // `reputation` carries just `rep`; effectiveTier is recomputed
        // from rep client-side (mirrors server's
        // `(*Reputation).EffectiveTier()`). `bondpost` may carry the full
        // ExchangeAuth (`note.auth`) on confirmation/registration/expiry
        // edges; informational variants (in-flight confirmation count,
        // errors) carry `auth=null` and the merge no-ops on those.
        // `feepayment` notes are emitted only on errors
        // (TopicAccountUnlockError / TopicWalletUnlockError) and don't
        // carry auth — fetchUser is a defensive re-sync.
        case 'feepayment': fetchUser(); break
        case 'reputation': applyReputationNote(note); break
        case 'bondpost': applyBondPostNote(note); break
        // `dex_auth` covers both auth-success and auth-failure edges,
        // plus unrelated housekeeping (UnknownOrders, OrdersReconciled) —
        // filter by topic. DexAuthError* with authenticated=false means
        // the background authDEX goroutine failed (bad password, bond
        // wallet, etc.); surface via authFailed so UI overlays can show
        // the cause instead of sitting on a spinner forever.
        case 'dex_auth': {
          if (!note.authenticated && (note.topic === 'DexAuthError' || note.topic === 'DexAuthErrorBond')) {
            const msg = note.details || note.subject || 'DEX authentication failed'
            useAuthStore.getState().setAuthFailed(note.host, msg)
          }
          break
        }
        case 'runstats': handleRunStatsNote(note); break
        case 'epochreport': handleEpochReportNote(note); break
        case 'cexproblems': handleCEXProblemsNote(note); break
        // walletnote is the wallet-emitter wrapper. We demux by the
        // payload's `route` field to feed action-required prompts into
        // the dialog queue and to promote selected data notes (e.g.
        // autoBumpCapped) into user-visible toasts.
        case 'walletnote': {
          const wn = note as WalletNote
          switch (wn.payload.route) {
            case 'actionRequired':
              enqueueAction(wn.payload as ActionRequiredNote)
              break
            case 'actionResolved':
              resolveAction((wn.payload as ActionResolvedNote).uniqueID)
              break
            case 'autoBumpCapped': {
              const cw = wn.payload as CustomWalletNote
              const inner = cw.payload as AutoBumpCappedNote
              const allAssets = useAuthStore.getState().assets
              const asset = allAssets[cw.assetID]
              const assetName = asset?.name || `asset ${cw.assetID}`
              const network = networkSuffix(allAssets, cw.assetID, t)
              handleAutoBumpCapped(inner, cw.assetID, assetName, network, t)
              break
            }
            case 'lostNonce': {
              const cw = wn.payload as CustomWalletNote
              const inner = cw.payload as LostNonceNote
              const allAssets = useAuthStore.getState().assets
              const asset = allAssets[cw.assetID]
              const assetName = asset?.name || `asset ${cw.assetID}`
              const network = networkSuffix(allAssets, cw.assetID, t)
              handleLostNonce(inner, cw.assetID, assetName, network, t)
              break
            }
          }
          break
        }
      }
    })
  }, [user])

  return (
    <>
      {/* B-XB1: new-user banner sits above the header, mirroring vanilla's
          placement at the top of `<body>` before the header template
          (bodybuilder.tmpl L25). Renders null until the user has a
          `seedGenTime`, and hides itself forever once dismissed for that
          seed (dismissed state persisted via newUserBannerDismissedLK).
          Closes LP-01 (high) + IP-01 (low) — no per-page calls needed,
          the banner reacts to `useAuthStore.seedGenTime` transitions. */}
      <NewUserBanner />
      <Header />
      <main id="main" className="flex-grow-1 position-relative d-flex flex-column" style={{ minHeight: 0 }}>
        <Outlet />
      </main>
      <PopupNotes />
      <ActionRequiredDialog />
    </>
  )
}
