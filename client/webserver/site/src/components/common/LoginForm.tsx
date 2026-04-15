import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'

interface Props {
  onSuccess: () => void
}

export function LoginForm ({ onSuccess }: Props) {
  const { t } = useTranslation()
  const login = useAuthStore(s => s.login)

  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError('')
    if (password === '') {
      setError(t('NO_PASS_ERROR_MSG'))
      return
    }
    setLoading(true)
    const result = await login(password)
    setLoading(false)
    setPassword('')
    if (!result.ok) {
      // Surface the server's actual error message (e.g. "incorrect
      // password"), mirroring vanilla `forms.ts` `LoginForm.submit()`
      // L1838: `Doc.showFormError(page.errMsg, res.msg)`.
      setError(result.msg)
      return
    }
    onSuccess()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') submit()
  }

  return (
    <div className="form-closer">
      <div className="px-3 py-2">
        <div className="fs18 mb-2">{t('Password')}</div>
        <input
          type="password"
          className="form-control mb-2"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          disabled={loading}
        />
        {error && (
          <div className="fs15 text-danger mb-2">{error}</div>
        )}
        <button
          className="btn btn-primary w-100"
          onClick={submit}
          disabled={loading}
        >
          {loading ? '...' : t('Submit')}
        </button>
      </div>
    </div>
  )
}
