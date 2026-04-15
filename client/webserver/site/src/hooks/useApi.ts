import { useState, useCallback, useRef } from 'react'
import { postJSON, getJSON } from '../services/api'

interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

// useApi wraps a REST call with loading/error state tracking and
// version-based request cancellation (prevents stale responses from
// overwriting newer ones).
export function useApi<T = any> () {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: false,
    error: null,
  })
  const versionRef = useRef(0)

  const post = useCallback(async (addr: string, body?: any): Promise<T | null> => {
    const version = ++versionRef.current
    setState(prev => ({ ...prev, loading: true, error: null }))
    const resp = await postJSON(addr, body)
    if (version !== versionRef.current) return null // stale
    if (!resp.requestSuccessful || !resp.ok) {
      setState({ data: null, loading: false, error: resp.msg || 'Request failed' })
      return null
    }
    setState({ data: resp, loading: false, error: null })
    return resp
  }, [])

  const get = useCallback(async (addr: string): Promise<T | null> => {
    const version = ++versionRef.current
    setState(prev => ({ ...prev, loading: true, error: null }))
    const resp = await getJSON(addr)
    if (version !== versionRef.current) return null
    if (!resp.requestSuccessful || !resp.ok) {
      setState({ data: null, loading: false, error: resp.msg || 'Request failed' })
      return null
    }
    setState({ data: resp, loading: false, error: null })
    return resp
  }, [])

  const reset = useCallback(() => {
    versionRef.current++
    setState({ data: null, loading: false, error: null })
  }, [])

  return { ...state, post, get, reset }
}

// T18#14: `checkResponse` previously lived here as a duplicate of
// the identical helper in `services/api.ts`. Call sites have been
// migrated to import from `services/api.ts` directly. Keeping the
// single source of truth there next to the other REST infrastructure.
