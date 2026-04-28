import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from './routes'
import { loadLastVisitedPage } from './lastVisitedPage'

// useWaitForInitialFetch blocks every guard until the first fetchUser()
// resolves. Without this, guards would act on Zustand's initial state
// (authed=false, inited=false, exchanges={}) and mis-redirect on every
// page refresh.
function useWaitForInitialFetch (): boolean {
  return useAuthStore(s => s.initialFetchDone)
}

// AuthGuard redirects to /init if the app is not initialized, then to /login
// if the user is not authenticated. The init check has to happen here because
// the SPA catch-all serves every page route - there is no server-side
// `requireInit` middleware in front of these any more.
export function AuthGuard () {
  const ready = useWaitForInitialFetch()
  const inited = useAuthStore(s => s.inited)
  const authed = useAuthStore(s => s.authed)
  if (!ready) return null
  if (!inited) return <Navigate to={ROUTES.INIT} replace />
  if (!authed) return <Navigate to={ROUTES.LOGIN} replace />
  return <Outlet />
}

// InitGuard redirects to /login if the app is already initialized.
// Used for the /init route which should only be accessible during first setup.
//
// `initInProgress` is honoured so that a fetchUser() call mid-init flow
// (which would flip `inited` to true) doesn't yank the user out of the
// QuickConfig/SeedBackup steps before they finish - InitPage clears
// the flag once it has its own navigate ready to fire.
export function InitGuard ({ children }: { children: React.ReactNode }) {
  const ready = useWaitForInitialFetch()
  const inited = useAuthStore(s => s.inited)
  const initInProgress = useAuthStore(s => s.initInProgress)
  if (!ready) return null
  if (inited && !initInProgress) return <Navigate to={ROUTES.LOGIN} replace />
  return <>{children}</>
}

// GuestGuard redirects already-authenticated users to their last-visited
// page. Used for /login so hitting it directly after logging in bounces
// the user forward instead of showing the login form. Also bounces
// un-initialized users to /init - otherwise the login form's submit would
// hit the server's `rejectUninited` middleware and surface a confusing
// "Precondition Required" error to the user before they have a chance to
// set their password.
export function GuestGuard ({ children }: { children: React.ReactNode }) {
  const ready = useWaitForInitialFetch()
  const inited = useAuthStore(s => s.inited)
  const authed = useAuthStore(s => s.authed)
  if (!ready) return null
  if (!inited) return <Navigate to={ROUTES.INIT} replace />
  if (authed) return <Navigate to={loadLastVisitedPage()} replace />
  return <>{children}</>
}

// DexConnectionGuard redirects to /wallets if no DEX connections exist.
// `Core.initialize()` auto-connects the network's CertStore-blessed DEX
// hosts on every startup, so a freshly inited user is never short a
// connection in the happy path. The fallback to /wallets is for the rare
// case where every CertStore connect failed (e.g. simnet harness offline)
// - sending the user to /wallets keeps them on a working surface.
export function DexConnectionGuard () {
  const ready = useWaitForInitialFetch()
  const exchanges = useAuthStore(s => s.exchanges)
  if (!ready) return null
  const hasConnection = Object.keys(exchanges).length > 0
  if (!hasConnection) return <Navigate to={ROUTES.WALLETS} replace />
  return <Outlet />
}
