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

export function AppLayout () {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const fetchBuildInfo = useAuthStore(s => s.fetchBuildInfo)
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
      // On reconnect, refetch user to sync state.
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
        case 'conn': handleConnEventNote(note); break
        // MP-65 / MP-66 reputation refresh — vanilla (markets.ts L544-545)
        // calls `updateReputation()` from its own per-page `feepayment` and
        // `reputation` feeders, which is a local re-render against
        // `app().exchanges[host].auth`. Vanilla's auth is kept fresh by a
        // global note-dispatcher in `app.ts` (the equivalent of this
        // switch). We don't have the per-note merge logic for reputation
        // payloads in the React store yet, so the safest reactive
        // equivalent is to refetch the user — `fetchUser` re-pulls
        // `/api/user`, which includes `auth.effectiveTier`,
        // `auth.pendingStrength`, `auth.rep`, etc. Once the auth state
        // refreshes, every page's `tierData` / reputation memo
        // recomputes automatically. This benefits MarketsPage,
        // DexSettingsPage, MMPage, and any other reputation-aware view.
        case 'feepayment': fetchUser(); break
        case 'reputation': fetchUser(); break
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
