import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/useAuthStore'
import { useWebSocketStore } from '../stores/useWebSocketStore'
import { useNotificationStore } from '../stores/useNotificationStore'
import { useMarketStore } from '../stores/useMarketStore'
import { useMMStore } from '../stores/useMMStore'
import { useUIStore } from '../stores/useUIStore'
import { Header } from './Header'

export function AppLayout () {
  const user = useAuthStore(s => s.user)
  const fetchUser = useAuthStore(s => s.fetchUser)
  const fetchBuildInfo = useAuthStore(s => s.fetchBuildInfo)
  const connect = useWebSocketStore(s => s.connect)
  const subscribe = useWebSocketStore(s => s.subscribe)
  const notify = useNotificationStore(s => s.notify)
  const darkMode = useUIStore(s => s.darkMode)

  const {
    handleBalanceNote, handleWalletStateNote, handleWalletSyncNote,
    handleSpotPriceNote, handleRateNote, handleWalletCreationNote,
    handleConnEventNote,
  } = useMarketStore()

  const { handleRunStatsNote, handleEpochReportNote, handleCEXProblemsNote } = useMMStore()

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
        case 'spotprice': handleSpotPriceNote(note); break
        case 'fiatrateupdate': handleRateNote(note); break
        case 'walletcreation': handleWalletCreationNote(note); break
        case 'conn': handleConnEventNote(note); break
        case 'runstats': handleRunStatsNote(note); break
        case 'epochreport': handleEpochReportNote(note); break
        case 'cexproblems': handleCEXProblemsNote(note); break
      }
    })
  }, [user])

  return (
    <>
      <Header />
      <main id="main" className="flex-grow-1 position-relative d-flex flex-column" style={{ minHeight: 0 }}>
        <Outlet />
      </main>
    </>
  )
}
