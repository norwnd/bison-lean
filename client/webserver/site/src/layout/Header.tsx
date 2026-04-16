import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from '../router/routes'

function navCls (path: string, current: string): string {
  const active = current.startsWith(path) ? ' active' : ''
  return `navlink hoverbg d-flex align-items-center${active}`
}

export function Header () {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const authed = useAuthStore(s => s.authed)
  const exchanges = useAuthStore(s => s.exchanges)
  const hasConnection = Object.keys(exchanges).length > 0

  const settingsPath = authed ? ROUTES.SETTINGS : ROUTES.LOGIN

  return (
    <header id="header" className="d-flex align-items-center justify-content-between border-bottom">
      {/* Left side: portal slot for page-specific header content (e.g. market stats) */}
      <div id="headerSlot" className="d-flex align-items-center flex-grow-1 overflow-hidden" />

      <div className="mainlinks fs18 text-nowrap d-flex">
        {authed && (
          <Link to={ROUTES.WALLETS} className={`demi ${navCls(ROUTES.WALLETS, pathname)}`}>
            {t('Wallet')}
          </Link>
        )}
        {authed && hasConnection && (
          <Link to={ROUTES.MARKETS} className={`demi ${navCls(ROUTES.MARKETS, pathname)}`}>
            {t('Trade')}
          </Link>
        )}
        {authed && hasConnection && (
          <Link to={ROUTES.MM} className={`ico-robot lh1 fs32 ${navCls(ROUTES.MM, pathname)}`} />
        )}
        <Link to={settingsPath} className={navCls(settingsPath, pathname)}>
          <span className="ico-hamburger fs20" />
        </Link>
      </div>
    </header>
  )
}
