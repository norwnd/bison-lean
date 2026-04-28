import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LoginForm } from '../components/common/LoginForm'
import { AppPassResetForm } from '../components/common/AppPassResetForm'

// LoginPage holds the form for login and password reset.
//
// Lifecycle parity with vanilla `login.ts` (LP-02): vanilla constructs
// LoginForm and AppPassResetForm once and toggles them via
// `prepAndDisplayLoginForm()`, which calls `refresh()` (clear inputs +
// hide error) and `focus()` (focus first input) on each show. React
// achieves the same effect via conditional rendering: each form's local
// `useState` is reinitialized on remount and the first input has
// `autoFocus`, so toggling `showResetForm` produces the same visible
// behavior as vanilla's imperative refresh/focus calls.
//
// Concretely:
//   - Initial mount: LoginForm fresh state + autoFocus on pw input
//   - "Forgot Password?" click: LoginForm unmounts, AppPassResetForm
//     mounts fresh (empty fields, autoFocus on newPassword)
//   - Reset success / backdrop dismiss: AppPassResetForm unmounts,
//     LoginForm mounts fresh (empty pw, error cleared, autoFocus on pw)
export default function LoginPage () {
  const { t } = useTranslation()

  const [showResetForm, setShowResetForm] = useState(false)

  // Post-login navigation is handled by GuestGuard (router/guards.tsx):
  // once `authed` flips true, GuestGuard re-renders and <Navigate>'s to
  // loadLastVisitedPage(). LoginPage stays UI-only.

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
            <LoginForm />
            <div className="text-center mt-2">
              <button
                className="btn btn-link"
                onClick={() => setShowResetForm(true)}
              >
                {/* LP-03: vanilla's `forms.tmpl` uses `[[[Forgot Password]]]`
                    keyed as `Forgot Password` (no `?`) in `locales/en-us.go`
                    L477 - the question mark lives in the translation, not
                    the key. */}
                {t('FORGOT_PASSWORD')}
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
