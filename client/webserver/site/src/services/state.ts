// Cookie keys.
export const darkModeLK = 'darkMode'
export const authCK = 'dexauth'
export const pwKeyCK = 'sessionkey'

// Local storage keys.
export const popupsLK = 'popups'
export const loggersLK = 'loggers'
export const recordersLK = 'recorders'
export const lastMarketLK = 'selectedMarket'
export const lastMMMarketLK = 'mmMarket'
export const optionsExpansionLK = 'mmOptsExpand'
export const leftMarketDockLK = 'leftmarketdock'
export const selectedAssetLK = 'selectedasset'
export const pendingTxsExpandedLK = 'pendingTxsExpanded'
export const orderDisclaimerAckedLK = 'ordAck'
export const lastCandleDurationLK = 'lastCandleDuration'
export const lastCandleZoomLevelLK = 'lastCandleZoomLevel'
export const localeSpecsKey = 'localeSpecsLK'
export const localeKey = 'localeLK'
export const newUserBannerDismissedLK = 'newUserBannerDismissed'

export function setCookie (cname: string, cvalue: string) {
  const d = new Date()
  d.setTime(d.getTime() + (86400 * 365 * 10 * 1000))
  const expires = 'expires=' + d.toUTCString()
  document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/'
}

export function getCookie (cname: string): string | null {
  for (const cstr of document.cookie.split(';')) {
    const [k, v] = cstr.split('=')
    if (k.trim() === cname) return v
  }
  return null
}

export function removeCookie (cKey: string) {
  document.cookie = `${cKey}=;expires=Thu, 01 Jan 1970 00:00:01 GMT;`
}

export function isDark (): boolean {
  return fetchLocal(darkModeLK) === '1'
}

export function storeLocal (k: string, v: any) {
  window.localStorage.setItem(k, JSON.stringify(v))
}

export function fetchLocal (k: string): any {
  const v = window.localStorage.getItem(k)
  if (v !== null) {
    return JSON.parse(v)
  }
  return null
}

export function removeLocal (k: string) {
  window.localStorage.removeItem(k)
}

// Set defaults unless already chosen by the user.
if (fetchLocal(darkModeLK) === null) storeLocal(darkModeLK, '1')
if (fetchLocal(popupsLK) === null) storeLocal(popupsLK, '1')
if (fetchLocal(leftMarketDockLK) === null) storeLocal(leftMarketDockLK, '1')
