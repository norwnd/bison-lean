import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { storeLocal, fetchLocal } from '../services/state'
import { ROUTES } from './routes'

export const lastVisitedPageLK = 'lastVisitedPage'

// Pre-auth routes are the only ROUTES entries we don't want to restore
// after login — every other route in ROUTES is a valid post-login target.
// Derived this way (block-list) so adding a new authed route to ROUTES
// requires no change here; adding a new *pre-auth* route needs one line.
const PRE_AUTH_ROUTES: ReadonlySet<string> = new Set([
  ROUTES.LOGIN,
  ROUTES.REGISTER,
  ROUTES.INIT,
])

// Converts a React Router path like `/order/:oid` into a strict regex
// (`^/order/[^/]+$`). Only handles the route-path grammar we actually
// use (literal segments + `:param`); no wildcard or optional segments.
function routeToRegex (path: string): RegExp {
  const body = path
    .split('/')
    .map(seg => seg.startsWith(':') ? '[^/]+' : seg)
    .join('/')
  return new RegExp(`^${body}$`)
}

// Whitelist built from ROUTES at module load — anything not in this list
// (the `/` index, pre-auth routes, unknown routes from older app
// versions) is ignored on both save and load.
const AUTHED_ROUTE_PATTERNS: RegExp[] = Object.values(ROUTES)
  .filter(path => !PRE_AUTH_ROUTES.has(path))
  .map(routeToRegex)

function pathnameOf (fullPath: string): string {
  return fullPath.split('?')[0].split('#')[0]
}

function isKnownAuthedPath (pathname: string): boolean {
  return AUTHED_ROUTE_PATTERNS.some(rx => rx.test(pathname))
}

export function saveLastVisitedPage (fullPath: string): void {
  if (!isKnownAuthedPath(pathnameOf(fullPath))) return
  storeLocal(lastVisitedPageLK, fullPath)
}

export function loadLastVisitedPage (): string {
  const stored = fetchLocal(lastVisitedPageLK)
  if (typeof stored !== 'string' || !stored) return ROUTES.WALLETS
  if (!isKnownAuthedPath(pathnameOf(stored))) return ROUTES.WALLETS
  return stored
}

export function useTrackLastVisitedPage (): void {
  const { pathname, search, hash } = useLocation()
  useEffect(() => {
    saveLastVisitedPage(`${pathname}${search}${hash}`)
  }, [pathname, search, hash])
}
