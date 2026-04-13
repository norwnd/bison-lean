export const ROUTES = {
  LOGIN: '/login',
  REGISTER: '/register',
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
