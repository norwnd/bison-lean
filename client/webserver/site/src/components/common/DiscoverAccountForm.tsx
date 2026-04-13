import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { Exchange } from '../../stores/types'

interface Props {
  addr: string
  onSuccess: (xc: Exchange) => void
}

export function DiscoverAccountForm ({ addr, onSuccess }: Props) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError('')
    setLoading(true)
    const res = await postJSON('/api/discoveracct', { addr })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg)
      return
    }
    if (res.paid) {
      await fetchUser()
      return
    }
    onSuccess(res.xc)
  }

  return (
    <div className="form-closer">
      <div className="px-3 py-2">
        <div className="fs18 mb-2">{addr}</div>
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
