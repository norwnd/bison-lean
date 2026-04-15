import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON } from '../services/api'
import { ROUTES } from '../router/routes'
import { SuccessCheckmarkModal } from '../components/common/SuccessCheckmarkModal'

interface ProposalDetail {
  token: string
  name: string
  status: number
  statusStr: string
  voteStatus: number
  voteStatusStr: string
  yesPercent: number
  noPercent: number
  approvalThreshold: number
  body: string
  votingPower: number
  timestamp: number
}

export default function ProposalPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const assetID = Number(searchParams.get('assetID')) || 42

  const [proposal, setProposal] = useState<ProposalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [voteChoice, setVoteChoice] = useState<'yes' | 'no' | null>(null)
  const [voteFormOpen, setVoteFormOpen] = useState(false)
  const [voteError, setVoteError] = useState('')
  const [voteLoading, setVoteLoading] = useState(false)
  // PP-01: vote-success modal (was inline `successMessage` text). The
  // animated checkmark mirrors vanilla `proposal.ts` `showSuccess()` ->
  // `forms.showSuccess()` -> `animateCheckmark()`.
  const [showSuccessModal, setShowSuccessModal] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)

  const fetchProposal = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    const resp = await getJSON(`/api/proposal/${token}?assetID=${assetID}`)
    setLoading(false)
    if (!resp.requestSuccessful) {
      setError(resp.msg || t('Failed to load proposal'))
      return
    }
    setProposal(resp)
  }, [token, assetID, t])

  useEffect(() => {
    fetchProposal()
  }, [fetchProposal])

  // Handle external links in proposal body content.
  useEffect(() => {
    if (!bodyRef.current) return
    bodyRef.current.querySelectorAll('a').forEach(a => {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    })
  }, [proposal?.body])

  const handleVote = async () => {
    if (!proposal || !voteChoice) return
    if (proposal.votingPower < 1) return

    setVoteError('')
    setVoteLoading(true)
    const resp = await postJSON('/api/castvote', {
      token: proposal.token,
      assetID,
      bit: voteChoice,
    })
    setVoteLoading(false)

    if (resp.msg) {
      setVoteError(resp.msg)
      return
    }

    // PP-01: open animated success modal instead of showing inline text.
    // The modal auto-closes after 2700ms (1200ms animation + 1500ms hold)
    // matching vanilla `animateCheckmark()` + the subsequent pause.
    setVoteFormOpen(false)
    setVoteChoice(null)
    setShowSuccessModal(true)
  }

  const openVoteForm = () => {
    setVoteError('')
    setVoteChoice(null)
    setVoteFormOpen(true)
  }

  if (loading) {
    return (
      <div id="main" className="py-5 overflow-y-auto">
        <section className="flex-stretch-column mw-500 mx-auto pb-3 pt-2 px-3">
          <div className="text-center my-5">{t('Loading...')}</div>
        </section>
      </div>
    )
  }

  if (error) {
    return (
      <div id="main" className="py-5 overflow-y-auto">
        <section className="flex-stretch-column mw-500 mx-auto pb-3 pt-2 px-3">
          <div className="d-flex justify-content-start align-items-center">
            <span
              className="ico-wide-headed-left-arrow fs24 py-1 lh1 hoverbg pointer"
              onClick={() => navigate(ROUTES.PROPOSALS)}
            />
          </div>
          <div className="text-danger m-2 p-3">{error}</div>
        </section>
      </div>
    )
  }

  if (!proposal) return null

  const hasVotes = proposal.yesPercent > 0 || proposal.noPercent > 0

  return (
    <div id="main" className="py-5 overflow-y-auto">
      <section className="flex-stretch-column mw-500 mx-auto pb-3 pt-2 px-3">
        {/* Back navigation */}
        <div className="d-flex justify-content-start align-items-center">
          <span
            className="ico-wide-headed-left-arrow fs24 py-1 lh1 hoverbg pointer"
            onClick={() => navigate(ROUTES.PROPOSALS)}
          />
        </div>

        {/* PP-01: animated vote-success modal (was inline success text).
            Uses `VOTE_CAST_MESSAGE` i18n key to match vanilla
            `intl.prep(intl.ID_VOTE_CAST_MESSAGE)` (PP-03). Auto-closes
            after 2700ms via the modal's internal timer. */}
        <SuccessCheckmarkModal
          show={showSuccessModal}
          message={t('VOTE_CAST_MESSAGE')}
          onClose={() => setShowSuccessModal(false)}
        />

        {/* Proposal header */}
        <div className="d-flex justify-content-between mt-3">
          <h5 className="pb-0 mb-0">{proposal.name}</h5>
          <small className={
            proposal.voteStatusStr === 'Approved'
? 'buycolor'
              : proposal.voteStatusStr === 'Rejected'
? 'text-danger'
                : 'text-color-secondary'
          }>
            {proposal.voteStatusStr}
          </small>
        </div>

        <hr className="mt-2" />

        {/* Proposal metadata */}
        <div className="mb-2">
          <div className="d-flex">
            <span>{t('Token')}</span>
            <span className="ms-auto">{proposal.token}</span>
          </div>
          <div className="d-flex">
            <span>{t('Status')}</span>
            <span className="ms-auto">{proposal.statusStr}</span>
          </div>
        </div>

        {/* Vote bars */}
        {hasVotes && (
          <>
            <div className="d-flex mb-2 mt-1">
              <div className="me-2 d-flex">
                <div className="yes-indicator mt-2 me-1" /> {t('Yes')}: {proposal.yesPercent.toFixed(1)}%
              </div>
              <div className="d-flex">
                <div className="no-indicator mt-2 me-1" /> {t('No')}: {proposal.noPercent.toFixed(1)}%
              </div>
            </div>

            <div className="d-flex align-items-center mb-2">
              <div
                className="vote-bar"
                style={{
                  '--yes': `${proposal.yesPercent}%`,
                  '--no': `${proposal.noPercent}%`,
                  '--approval-threshold': String(proposal.approvalThreshold),
                } as React.CSSProperties}
              >
                <div className="vote-yes" />
                <div className="vote-no" />
                <span className="approval-threshold" />
              </div>
            </div>
          </>
        )}

        {/* Vote button */}
        {proposal.votingPower > 0 && (
          <button
            type="button"
            className="btn w-100 rounded25 mt-2 mb-2"
            onClick={openVoteForm}
          >
            {t('Vote Now')}
          </button>
        )}

        {/* PP-02 + PP-04: vote form slide-in animation. Wrap in
            `overflow-hidden` to clip the form's off-screen
            `translateX(100%)` start state so the slide-in-from-right
            keyframe doesn't leak into surrounding layout. CSS animation
            replays automatically on each mount because `voteFormOpen`
            unmounts/remounts the wrapper, and CSS animations clean up
            on their own when the element unmounts -- no manual
            `animation.stop()` equivalent needed. */}
        {voteFormOpen && (
          <div className="overflow-hidden">
            <div className="mb-3 slide-in-from-right">
              <div className="form-closer" onClick={() => setVoteFormOpen(false)}>
                <span className="ico-cross" />
              </div>
              <header>{t('Vote')}</header>
              <p className="text-muted mt-2">{t('Cast your vote on this proposal')}</p>
              <div>{t('Voting power')}: {proposal.votingPower}</div>

              <div className="vote-actions mt-2">
                <button
                  type="button"
                  className={`vote-btn vote-yes rounded3${voteChoice === 'yes' ? ' active' : ''}`}
                  onClick={() => setVoteChoice('yes')}
                >
                  <span className="icon">
                    <svg className="vote-icon" viewBox="0 0 24 24" width="20" height="20" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="label">{t('Yes')}</span>
                </button>

                <button
                  type="button"
                  className={`vote-btn vote-no mt-2 rounded3${voteChoice === 'no' ? ' active' : ''}`}
                  onClick={() => setVoteChoice('no')}
                >
                  <span className="icon">
                    <svg className="vote-icon" viewBox="0 0 24 24" width="20" height="20" fill="none">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="label">{t('No')}</span>
                </button>
              </div>

              <button
                type="button"
                className="mt-3"
                onClick={handleVote}
                disabled={!voteChoice || voteLoading}
              >
                {voteLoading ? '...' : t('Submit Vote')}
              </button>

              {voteError && (
                <div className="text-danger text-center mt-2">{voteError}</div>
              )}
            </div>
          </div>
        )}

        {/* Proposal body */}
        <div className="d-flex align-items-center mt-2">
          <h5>{t('Proposal')}</h5>
        </div>
        <div
          ref={bodyRef}
          className="card p-3 proposal-content"
          dangerouslySetInnerHTML={{ __html: proposal.body }}
        />
      </section>
    </div>
  )
}
