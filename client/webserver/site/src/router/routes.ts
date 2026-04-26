export const ROUTES = {
  LOGIN: '/login',
  INIT: '/init',
  MARKETS: '/markets',
  WALLETS: '/wallets',
  ORDERS: '/orders',
  ORDER: '/order/:oid',
  SETTINGS: '/settings',
  DEX_SETTINGS: '/dexsettings/:host',
  MM: '/mm',
  MM_SETTINGS: '/mmsettings',
  MM_ARCHIVES: '/mmarchives',
  MM_LOGS: '/mmlogs',
  PROPOSALS: '/proposals',
  PROPOSAL: '/proposal/:token',
} as const

export function orderPath (oid: string): string {
  return `/order/${oid}`
}

export function dexSettingsPath (host: string): string {
  return `/dexsettings/${encodeURIComponent(host)}`
}

export function proposalPath (token: string): string {
  return `/proposal/${token}`
}

// T18#4: MMLogsPage's `?returnPage=...` query param identifies where
// the Back button should navigate to. Only two valid values; typing
// them centrally prevents typos from silently falling through to
// the default ('mm') on either side of the producer/consumer boundary
// (MMArchivesPage produces, MMLogsPage consumes).
export type MMLogsReturnPage = 'mm' | 'mmarchives'
