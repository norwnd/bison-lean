import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import type { Exchange } from '../../stores/types'

// DiscoverAccountForm performs account discovery for a pre-selected
// DEX address. Used by RegisterPage when a `host` URL param is
// provided (deep-link flow). Mirrors vanilla `forms.ts`
// `DiscoverAccountForm` (L1714-1759):
//
// - On mount, automatically submits to `/api/discoveracct` so the
//   user doesn't have to click anything for the deep-link flow.
//   Vanilla achieves this via `currentForm.click()` from register.ts.
// - If the response says `paid: true`, the account is already
//   registered → invoke `onPaid()` (the parent then navigates away).
// - Otherwise, invoke `onSuccess(xc)` so the parent advances to fee
//   asset selection.
interface Props {
  addr: string
  onSuccess: (xc: Exchange) => void
  // Called when the API reports the account is already paid. The
  // parent should refetch user state and navigate away from the
  // registration flow.
  onPaid?: () => void
}

export function DiscoverAccountForm ({ addr, onSuccess, onPaid }: Props) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Auto-submit guard: ensure we only fire once per mount. React 18
  // strict mode runs effects twice in dev which would otherwise hit
  // /api/discoveracct twice.
  const autoSubmitted = useRef(false)

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
      onPaid?.()
      return
    }
    onSuccess(res.xc)
  }

  // RP-01: auto-submit on mount. Mirrors vanilla `register.ts`
  // (L130-132) which calls `this.discoverAcctForm.page.submit.click()`
  // when the discover form is the initial form. A failure (network or
  // server error) leaves the manual Submit button visible so the user
  // can retry. Intentionally only fires once per mount — `submit` is a
  // closure over `addr` which is part of the parent's prop contract;
  // if the parent supplies a different `addr`, remounting the
  // component is the expected pattern.
  useEffect(() => {
    if (autoSubmitted.current) return
    autoSubmitted.current = true
    submit()
  }, [])

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
