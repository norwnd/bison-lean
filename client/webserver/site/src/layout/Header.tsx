import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES } from '../router/routes'

export function Header () {
  const { t } = useTranslation()
  const authed = useAuthStore(s => s.authed)
  const exchanges = useAuthStore(s => s.exchanges)
  const hasConnection = Object.keys(exchanges).length > 0

  return (
    <header id="header" className="d-flex align-items-center justify-content-between border-bottom">
      {/* Left side: portal slot for page-specific header content (e.g. market stats) */}
      <div id="headerSlot" className="d-flex align-items-center flex-grow-1 overflow-hidden" />

      <div className="mainlinks fs18 pe-2 text-nowrap d-flex h-100">
        {authed && (
          <Link to={ROUTES.WALLETS} className="demi hoverbg d-flex align-items-center">
            {t('Wallet')}
          </Link>
        )}
        {authed && hasConnection && (
          <Link to={ROUTES.MARKETS} className="demi hoverbg d-flex align-items-center">
            {t('Trade')}
          </Link>
        )}
        {authed && hasConnection && (
          <Link to={ROUTES.MM} className="ico-robot lh1 fs32 hoverbg d-flex align-items-center" />
        )}
        <Link to={authed ? ROUTES.SETTINGS : ROUTES.LOGIN} className="d-flex align-items-center hoverbg position-relative pointer">
          <span className="ico-hamburger fs20 p-2" />
        </Link>
      </div>
    </header>
  )
}
