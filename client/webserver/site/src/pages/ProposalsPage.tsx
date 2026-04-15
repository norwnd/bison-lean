import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getJSON } from '../services/api'
import { proposalPath } from '../router/routes'
import { FormOverlay } from '../components/common/FormOverlay'

interface Proposal {
  token: string
  name: string
  status: number
  statusStr: string
  voteStatus: number
  voteStatusStr: string
  yesPercent: number
  noPercent: number
  approvalThreshold: number
  timestamp: number
}

interface PaginationInfo {
  currentPage: number
  totalPages: number
  hasPrev: boolean
  hasNext: boolean
}

const VOTE_STATUS_OPTIONS = [
  { key: 'all', label: 'all' },
  { key: 'authorized', label: 'authorized' },
  { key: 'started', label: 'started' },
  { key: 'finished', label: 'finished' },
  { key: 'approved', label: 'approved' },
  { key: 'rejected', label: 'rejected' },
]

export default function ProposalsPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [activeStatus, setActiveStatus] = useState(searchParams.get('status') || 'all')
  const [searchQuery, setSearchQuery] = useState(searchParams.get('query') || '')
  const [pagination, setPagination] = useState<PaginationInfo | null>(null)

  const currentPage = Number(searchParams.get('page')) || 1

  const fetchProposals = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (activeStatus && activeStatus !== 'all') params.set('status', activeStatus)
    if (searchQuery) params.set('query', searchQuery)
    params.set('page', String(currentPage))
    const qs = params.toString()
    const resp = await getJSON(`/api/proposals${qs ? `?${qs}` : ''}`)
    setLoading(false)
    if (!resp.requestSuccessful) {
      setError(resp.msg || t('Failed to load proposals'))
      return
    }
    setProposals(resp.proposals || [])
    if (resp.pagination) {
      setPagination(resp.pagination)
    }
  }, [activeStatus, searchQuery, currentPage, t])

  useEffect(() => {
    fetchProposals()
  }, [fetchProposals])

  const applyFilter = (status: string) => {
    setActiveStatus(status)
    setFilterOpen(false)
    const params = new URLSearchParams()
    if (status && status !== 'all') params.set('status', status)
    if (searchQuery) params.set('query', searchQuery)
    params.set('page', '1')
    setSearchParams(params)
  }

  const handleSearch = () => {
    if (!searchQuery) return
    const params = new URLSearchParams()
    if (activeStatus && activeStatus !== 'all') params.set('status', activeStatus)
    params.set('query', searchQuery)
    params.set('page', '1')
    setSearchParams(params)
  }

  const clearSearch = () => {
    if (!searchQuery) return
    setSearchQuery('')
    const params = new URLSearchParams()
    if (activeStatus && activeStatus !== 'all') params.set('status', activeStatus)
    params.set('page', '1')
    setSearchParams(params)
  }

  const goToPage = (page: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', String(page))
    setSearchParams(params)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  return (
    <div id="main" className="py-5 overflow-y-auto">
      {/* T18#2: use the shared `mw-500` utility class instead of the
          old `#proposals { max-width: 500px }` ID rule. */}
      <section className="flex-stretch-column mw-500 mx-auto pb-3 pt-2 px-3">
        <div className="d-flex justify-content-start align-items-center">
          <span
            className="ico-wide-headed-left-arrow fs24 py-1 px-2 lh1 hoverbg pointer"
            onClick={() => navigate('/wallets')}
          />
        </div>

        {/* Search and filter bar */}
        <div className="d-flex align-items-center mb-2">
          <div className="search-bar flex-grow-1">
            <input
              type="search"
              placeholder={t('Search...')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <button type="button" className="search-clear p-0" onClick={clearSearch}>
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" className="p-0" onClick={handleSearch}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <line x1="20" y1="20" x2="16.5" y2="16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <button type="button" className="filter-btn ms-2" onClick={() => setFilterOpen(!filterOpen)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M3 6h18M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* T17: filter form now renders as a fixed-overlay modal via
            FormOverlay (backdrop dim + center + Esc/backdrop close),
            matching vanilla's `#forms > form` pattern. The inner card
            uses the shared `.modal-form` class for the border/shadow/
            padding look. `slide-in-from-right` still replays on each
            open because FormOverlay returns null when `show` is false,
            so the children remount. Overflow-hidden still needed to
            clip the slide-in start state (`translateX(100%)`) -- the
            backdrop extends full-viewport so it's a safe clipping
            context. */}
        <FormOverlay show={filterOpen} onClose={() => setFilterOpen(false)}>
          <div className="overflow-hidden">
            <div className="modal-form filter-form mw-500 slide-in-from-right">
              <div className="form-closer" onClick={() => setFilterOpen(false)}>
                <span className="ico-cross" />
              </div>
              <div className="fs22 fw-bold mb-3">{t('Filter')}</div>
              <div className="filter-list-wrap">
                <div className="filter-list">
                  {VOTE_STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`filter-pill${activeStatus === opt.key ? ' active-opt' : ''}`}
                      onClick={() => applyFilter(opt.key)}
                    >
                      {t(opt.label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </FormOverlay>

        <div className="mb-3" />

        {/* Content */}
        {loading
          ? (
          <div className="text-center my-5">
            <span>{t('Loading...')}</span>
          </div>
            )
          : error
            ? (
          <div className="text-center my-5">
            <div className="text-danger m-2 p-3">{error}</div>
          </div>
              )
            : proposals.length === 0
              ? (
          <div className="text-center my-5">
            <p className="text-muted">{t('No proposals found')}</p>
          </div>
                )
              : (
          <>
            {proposals.map(p => (
              <div
                key={p.token}
                className="card mb-3 border-0 p-3 rounded3 proposal"
                onClick={() => navigate(proposalPath(p.token))}
              >
                <div className="d-flex justify-content-between">
                  <h6 className="pb-0 mb-0">{p.name}</h6>
                  <small className={
                    p.voteStatusStr === 'Approved'
? 'buycolor'
                      : p.voteStatusStr === 'Rejected'
? 'text-danger'
                        : 'text-color-secondary'
                  }>
                    {p.voteStatusStr}
                  </small>
                </div>

                {p.yesPercent > 0 || p.noPercent > 0
? (
                  <>
                    <div className="d-flex mb-2">
                      <div className="me-2 d-flex">
                        <div className="yes-indicator mt-2 me-1" /> {t('Yes')}: {p.yesPercent.toFixed(1)}%
                      </div>
                      <div className="d-flex">
                        <div className="no-indicator mt-2 me-1" /> {t('No')}: {p.noPercent.toFixed(1)}%
                      </div>
                    </div>
                    <div className="d-flex align-items-center mt-1 mb-2">
                      <div
                        className="vote-bar"
                        style={{
                          '--yes': `${p.yesPercent}%`,
                          '--no': `${p.noPercent}%`,
                          '--approval-threshold': String(p.approvalThreshold),
                        } as React.CSSProperties}
                      >
                        <div className="vote-yes" />
                        <div className="vote-no" />
                        <span className="approval-threshold" />
                      </div>
                    </div>
                  </>
                )
: null}
              </div>
            ))}

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <div className="pagination justify-content-center d-flex">
                {pagination.hasPrev && (
                  <div className="page-item m-1">
                    <span className="page-link" onClick={() => goToPage(currentPage - 1)}>&#8249;</span>
                  </div>
                )}
                {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map(num => (
                  <div key={num} className="page-item m-1">
                    <span
                      className={`page-link${num === currentPage ? ' is-active' : ''}`}
                      onClick={() => goToPage(num)}
                    >
                      {num}
                    </span>
                  </div>
                ))}
                {pagination.hasNext && (
                  <div className="page-item m-1">
                    <span className="page-link" onClick={() => goToPage(currentPage + 1)}>&#8250;</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
