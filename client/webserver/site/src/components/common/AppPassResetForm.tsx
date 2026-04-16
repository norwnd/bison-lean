import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'

interface Props {
  onSuccess: () => void
}

export function AppPassResetForm ({ onSuccess }: Props) {
  const { t } = useTranslation()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [seed, setSeed] = useState('')
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError('')
    if (newPassword === '') {
      setError(t('NO_PASS_ERROR_MSG'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('PASSWORD_NOT_MATCH'))
      return
    }
    setLoading(true)
    const res = await postJSON('/api/resetapppassword', {
      newPass: newPassword,
      seed: seed,
    })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg)
      return
    }
    setError('')
    setSuccessMsg(t('PASSWORD_RESET_SUCCESS_MSG'))
    setTimeout(() => onSuccess(), 3000)
  }

  // Wrapping in a `<form>` lets HTML's native semantics handle keyboard
  // submission: Enter on either password input fires `onSubmit` while
  // Enter on the seed `<textarea>` inserts a newline as expected. The
  // submit button is `type="submit"` so the form's onSubmit is the
  // single source of truth for invocation (no duplicate onClick).
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submit()
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="px-3 py-2">
        <div className="fs18 mb-2">{t('Reset App Password')}</div>
        <p className="fs15">{t('reset_app_pw_msg')}</p>
        <div className="mb-2">
          <label className="form-label">{t('New Password')}</label>
          <input
            type="password"
            className="form-control"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoFocus
            disabled={loading}
          />
        </div>
        <div className="mb-2">
          <label className="form-label">{t('Confirm New Password')}</label>
          <input
            type="password"
            className="form-control"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="mb-2">
          <label className="form-label">{t('Restoration Seed')}</label>
          <textarea
            className="form-control"
            value={seed}
            onChange={e => setSeed(e.target.value)}
            rows={3}
            disabled={loading}
          />
        </div>
        {error && (
          <div className="fs15 text-danger mb-2">{error}</div>
        )}
        {successMsg && (
          <div className="fs15 text-success mb-2">{successMsg}</div>
        )}
        <button
          type="submit"
          className="btn btn-primary w-100"
          disabled={loading || successMsg !== ''}
        >
          {loading ? '...' : t('Submit')}
        </button>
      </div>
    </form>
  )
}
