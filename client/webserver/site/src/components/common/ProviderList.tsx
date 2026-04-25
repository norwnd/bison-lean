import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'

// ProviderInfo mirrors the Go-side asset.ProviderInfo struct shape, as
// returned by the /api/walletproviders endpoint.
interface ProviderInfo {
  url: string
  isDefault: boolean
  healthy: boolean
  probed: boolean
  lastProbed: string // RFC3339 from Go time.Time; empty string if never probed
  lastErr?: string
}

interface Props {
  assetID: number
  // value is the persisted "providers" setting — a space-separated list
  // of user-added provider URLs. Empty string when the user hasn't
  // added any of their own.
  value: string
  // onChange fires whenever the user-added URL list changes.
  onChange: (value: string) => void
  // disabled when the wallet has active orders or other reasons.
  disabled?: boolean
}

const POLL_INTERVAL_MS = 5000

function parseUserURLs (value: string): string[] {
  return value.split(/\s+/).map(s => s.trim()).filter(s => s !== '')
}

function joinUserURLs (urls: string[]): string {
  return urls.join(' ')
}

// formatTimeAgo turns an RFC3339 timestamp into a short relative string
// (e.g. "12s ago", "3m ago"). Returns empty for empty input.
function formatTimeAgo (rfc3339: string): string {
  if (!rfc3339) return ''
  const t = new Date(rfc3339).getTime()
  if (Number.isNaN(t)) return ''
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  return `${diffHr}h ago`
}

// ProviderList replaces the generic "providers" text input with a
// per-provider editable list. Default providers (hardcoded in the
// wallet) are non-deletable and always displayed first; user-added
// providers can be added/deleted. A green/red status dot reflects the
// most recent health-probe outcome for each, with a hover tooltip
// showing the last error and last-checked time.
export function ProviderList ({ assetID, value, onChange, disabled }: Props) {
  const { t } = useTranslation()
  // entries is the displayed list = (defaults from API) ∪ (user-added).
  // Health fields come from the API; user-added URLs that aren't yet
  // in the API response render as "not yet probed" until they show up.
  const [apiEntries, setApiEntries] = useState<ProviderInfo[]>([])
  const [adding, setAdding] = useState(false)
  const [newURL, setNewURL] = useState('')

  const userURLs = useMemo(() => parseUserURLs(value), [value])

  const updateUserURLs = useCallback((urls: string[]) => {
    onChange(joinUserURLs(urls))
  }, [onChange])

  // Fetch /api/walletproviders on mount and re-fetch periodically so
  // health dots stay fresh while the form is open.
  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      const res = await postJSON('/api/walletproviders', { assetID })
      if (cancelled) return
      if (!checkResponse(res)) return
      setApiEntries((res.providers ?? []) as ProviderInfo[])
    }
    fetchOnce()
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [assetID])

  // Build the rendered list: defaults from API (always present, in API
  // order), then user-added (locally-tracked URLs, with health pulled
  // from API when available).
  const apiByURL = useMemo(() => {
    const m = new Map<string, ProviderInfo>()
    for (const e of apiEntries) m.set(e.url, e)
    return m
  }, [apiEntries])

  const defaults = useMemo(() => apiEntries.filter(e => e.isDefault), [apiEntries])
  const userEntries = useMemo<ProviderInfo[]>(() => {
    const seen = new Set<string>()
    const out: ProviderInfo[] = []
    for (const u of userURLs) {
      if (seen.has(u)) continue
      seen.add(u)
      const apiE = apiByURL.get(u)
      if (apiE && !apiE.isDefault) {
        out.push(apiE)
      } else if (!apiE) {
        // Locally-typed URL not yet in the active pool (typed but
        // not saved, or just added — the next reconfigure will pick
        // it up). Render with "not probed" status.
        out.push({
          url: u,
          isDefault: false,
          healthy: false,
          probed: false,
          lastProbed: '',
        })
      }
    }
    return out
  }, [userURLs, apiByURL])

  const handleAdd = useCallback(() => {
    const trimmed = newURL.trim()
    if (!trimmed) {
      setAdding(false)
      return
    }
    // Reject if duplicate of an existing user-added or a default.
    if (userURLs.includes(trimmed)) {
      setAdding(false)
      setNewURL('')
      return
    }
    if (apiByURL.get(trimmed)?.isDefault) {
      setAdding(false)
      setNewURL('')
      return
    }
    updateUserURLs([...userURLs, trimmed])
    setNewURL('')
    setAdding(false)
  }, [newURL, userURLs, apiByURL, updateUserURLs])

  const handleDelete = useCallback((url: string) => {
    updateUserURLs(userURLs.filter(u => u !== url))
  }, [userURLs, updateUserURLs])

  const renderRow = (p: ProviderInfo) => {
    const tooltip = !p.probed
      ? t('PROVIDER_NOT_PROBED')
      : p.healthy
        ? `${t('PROVIDER_OK')} · ${formatTimeAgo(p.lastProbed)}`
        : `${p.lastErr || t('PROVIDER_UNREACHABLE')} · ${formatTimeAgo(p.lastProbed)}`
    const dotClass = !p.probed
      ? 'provider-status-dot unknown'
      : p.healthy
        ? 'provider-status-dot healthy'
        : 'provider-status-dot unhealthy'
    return (
      <div key={p.url} className="provider-row d-flex align-items-center gap-2 mb-1">
        <span className={dotClass} title={tooltip} />
        <span className="provider-url flex-grow-1 text-truncate" title={p.url}>{p.url}</span>
        {p.isDefault
          ? (
              <span className="provider-badge fs13 text-secondary">{t('DEFAULT')}</span>
            )
          : (
              <button
                type="button"
                className="btn btn-sm btn-link text-danger p-0"
                onClick={() => handleDelete(p.url)}
                disabled={disabled}
                title={t('DELETE')}
              >
                ✕
              </button>
            )}
      </div>
    )
  }

  return (
    <div className="provider-list mb-3">
      <div className="fs15 mb-2">{t('RPC_PROVIDERS')}</div>
      {defaults.map(renderRow)}
      {userEntries.map(renderRow)}
      {adding
        ? (
            <div className="provider-row d-flex align-items-center gap-2 mt-2">
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder={t('PROVIDER_URL_PLACEHOLDER')}
                value={newURL}
                onChange={e => setNewURL(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } }}
                autoFocus
              />
              <button type="button" className="btn btn-sm btn-primary" onClick={handleAdd} disabled={disabled}>
                {t('ADD')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => { setAdding(false); setNewURL('') }}
              >
                {t('CANCEL')}
              </button>
            </div>
          )
        : (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary mt-2"
              onClick={() => setAdding(true)}
              disabled={disabled}
            >
              + {t('ADD_PROVIDER')}
            </button>
          )}
    </div>
  )
}

export default ProviderList
