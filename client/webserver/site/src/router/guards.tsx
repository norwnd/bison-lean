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

// AuthGuard redirects to /login if the user is not authenticated.
export function AuthGuard () {
  const ready = useWaitForInitialFetch()
  const authed = useAuthStore(s => s.authed)
  if (!ready) return null
  if (!authed) return <Navigate to={ROUTES.LOGIN} replace />
  return <Outlet />
}

// InitGuard redirects to /login if the app is already initialized.
// Used for the /init route which should only be accessible during first setup.
export function InitGuard ({ children }: { children: React.ReactNode }) {
  const ready = useWaitForInitialFetch()
  const inited = useAuthStore(s => s.inited)
  if (!ready) return null
  if (inited) return <Navigate to={ROUTES.LOGIN} replace />
  return <>{children}</>
}

// GuestGuard redirects already-authenticated users to their last-visited
// page. Used for /login so hitting it directly after logging in bounces
// the user forward instead of showing the login form.
export function GuestGuard ({ children }: { children: React.ReactNode }) {
  const ready = useWaitForInitialFetch()
  const authed = useAuthStore(s => s.authed)
  if (!ready) return null
  if (authed) return <Navigate to={loadLastVisitedPage()} replace />
  return <>{children}</>
}

// DexConnectionGuard redirects to /register if no DEX connections exist.
export function DexConnectionGuard () {
  const ready = useWaitForInitialFetch()
  const exchanges = useAuthStore(s => s.exchanges)
  if (!ready) return null
  const hasConnection = Object.keys(exchanges).length > 0
  if (!hasConnection) return <Navigate to={ROUTES.REGISTER} replace />
  return <Outlet />
}
