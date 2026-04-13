import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from './routes'

// AuthGuard redirects to /login if the user is not authenticated.
export function AuthGuard () {
  const authed = useAuthStore(s => s.authed)
  if (!authed) return <Navigate to={ROUTES.LOGIN} replace />
  return <Outlet />
}

// InitGuard redirects to /login if the app is already initialized.
// Used for the /init route which should only be accessible during first setup.
export function InitGuard ({ children }: { children: React.ReactNode }) {
  const inited = useAuthStore(s => s.inited)
  if (inited) return <Navigate to={ROUTES.LOGIN} replace />
  return <>{children}</>
}

// DexConnectionGuard redirects to /register if no DEX connections exist.
export function DexConnectionGuard () {
  const exchanges = useAuthStore(s => s.exchanges)
  const hasConnection = Object.keys(exchanges).length > 0
  if (!hasConnection) return <Navigate to={ROUTES.REGISTER} replace />
  return <Outlet />
}
