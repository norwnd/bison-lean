import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { LoginForm } from '../components/common/LoginForm'
import { AppPassResetForm } from '../components/common/AppPassResetForm'
import { ROUTES } from '../router/routes'

export default function LoginPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [showResetForm, setShowResetForm] = useState(false)

  const handleLoginSuccess = useCallback(async () => {
    await fetchUser()
    navigate(ROUTES.WALLETS)
  }, [fetchUser, navigate])

  const handleResetSuccess = useCallback(() => {
    setShowResetForm(false)
  }, [])

  const handleBackdropMouseDown = useCallback((e: React.MouseEvent) => {
    if (showResetForm && e.target === e.currentTarget) {
      setShowResetForm(false)
    }
  }, [showResetForm])

  return (
    <div className="d-flex align-items-center justify-content-center py-5" onMouseDown={handleBackdropMouseDown}>
      <div className="col-12 col-sm-8 col-md-6 col-lg-4">
        {!showResetForm
? (
          <div>
            <LoginForm onSuccess={handleLoginSuccess} />
            <div className="text-center mt-2">
              <button
                className="btn btn-link"
                onClick={() => setShowResetForm(true)}
              >
                {t('Forgot Password?')}
              </button>
            </div>
          </div>
        )
: (
          <AppPassResetForm onSuccess={handleResetSuccess} />
        )}
      </div>
    </div>
  )
}
