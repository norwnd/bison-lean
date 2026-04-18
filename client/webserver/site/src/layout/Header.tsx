import { startTransition, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from '../router/routes'

export function Header () {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const authed = useAuthStore(s => s.authed)
  const exchanges = useAuthStore(s => s.exchanges)
  const hasConnection = Object.keys(exchanges).length > 0

  const go = useCallback((to: string) => () => {
    startTransition(() => { navigate(to) })
  }, [navigate])

  const isActive = (path: string) => pathname.startsWith(path)

  const burgerTarget = authed ? ROUTES.SETTINGS : ROUTES.LOGIN
  const burgerActive = isActive(burgerTarget)

  return (
    <header id="header">
      {/* Left side: portal slot for page-specific header content (e.g. market stats) */}
      <div id="headerSlot" />

      <nav className="header-nav">
        {authed && (
          <div
            className={`header-btn demi${isActive(ROUTES.WALLETS) ? ' active' : ''}`}
            onClick={go(ROUTES.WALLETS)}
          >
            {t('Wallet')}
          </div>
        )}
        {authed && hasConnection && (
          <div
            className={`header-btn demi${isActive(ROUTES.MARKETS) ? ' active' : ''}`}
            onClick={go(ROUTES.MARKETS)}
          >
            {t('Trade')}
          </div>
        )}
        {authed && hasConnection && (
          <div
            className={`header-btn${isActive(ROUTES.MM) ? ' active' : ''}`}
            onClick={go(ROUTES.MM)}
          >
            <span className="ico-robot fs32 lh1" />
          </div>
        )}
        <div
          className={`header-btn${burgerActive ? ' active' : ''}`}
          onClick={burgerActive ? undefined : go(burgerTarget)}
        >
          <span className="ico-hamburger fs20" />
        </div>
      </nav>
    </header>
  )
}
