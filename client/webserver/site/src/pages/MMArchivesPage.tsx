import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { ROUTES, type MMLogsReturnPage } from '../router/routes'

interface MarketMakingRun {
  startTime: number
  market: { baseID: number; quoteID: number; host: string }
  profit: number
}

function formatProfit (profit: number): { text: string; colorClass: string } {
  const s = profit.toFixed(2)
  if (s === '-0.00' || s === '0.00') return { text: '$0.00', colorClass: '' }
  if (profit < 0) return { text: `-$${s.substring(1)}`, colorClass: 'sellcolor' }
  return { text: `$${s}`, colorClass: 'buycolor' }
}

export default function MMArchivesPage () {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const assets = useAuthStore(s => s.assets)

  const [runs, setRuns] = useState<MarketMakingRun[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const res = await getJSON('/api/archivedmmruns')
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to load archived runs')
        return
      }
      setRuns(res.runs || [])
    })()
  }, [])

  const totalProfit = runs.reduce((sum, r) => sum + r.profit, 0)
  const total = formatProfit(totalProfit)

  const symbolFor = (assetID: number) => assets[assetID]?.symbol?.toLowerCase() ?? ''

  return (
    <div className="p-3">
      <div className="d-flex align-items-center mb-3">
        <button className="btn btn-secondary me-3" onClick={() => navigate(ROUTES.MM)}>
          {t('Back')}
        </button>
        <h2 className="mb-0">{t('Archived Market Making Runs')}</h2>
      </div>

      {error && <div className="text-danger mb-3">{error}</div>}

      <div className="mb-3">
        <span className="me-3">{t('Total Runs')}: {runs.length}</span>
        <span>
          {t('Total Profit')}: <span className={total.colorClass}>{total.text}</span>
        </span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>{t('Start Time')}</th>
            <th>{t('Market')}</th>
            <th>{t('Profit')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, i) => {
            const { startTime, market: { baseID, quoteID, host }, profit } = run
            const p = formatProfit(profit)
            const baseSym = symbolFor(baseID)
            const quoteSym = symbolFor(quoteID)
            return (
              <tr key={i}>
                <td>{new Date(startTime * 1000).toLocaleString()}</td>
                <td className="d-flex align-items-center gap-1">
                  {baseSym && <img src={`/img/coins/${baseSym}.png`} width={20} height={20} alt={baseSym} />}
                  {quoteSym && <img src={`/img/coins/${quoteSym}.png`} width={20} height={20} alt={quoteSym} />}
                  <span>{baseSym.toUpperCase()}-{quoteSym.toUpperCase()}</span>
                </td>
                <td className={p.colorClass}>{p.text}</td>
                <td>
                  {/* MMA-01: pass `returnPage=mmarchives` so MMLogsPage's
                      back button returns here instead of falling back to
                      its `'mm'` default. Mirrors vanilla `mmarchives.ts`
                      L48: `loadPage('mmlogs', { ..., returnPage: 'mmarchives' })`.
                      T18#4: typed via MMLogsReturnPage to prevent typos. */}
                  <button
                    className="btn btn-sm btn-outline-secondary me-1"
                    onClick={() => {
                      const returnPage: MMLogsReturnPage = 'mmarchives'
                      navigate(`${ROUTES.MM_LOGS}?baseID=${baseID}&quoteID=${quoteID}&host=${encodeURIComponent(host)}&startTime=${startTime}&returnPage=${returnPage}`)
                    }}
                  >
                    {t('Logs')}
                  </button>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => navigate(`${ROUTES.MM_SETTINGS}?baseID=${baseID}&quoteID=${quoteID}&host=${encodeURIComponent(host)}`)}
                  >
                    {t('Settings')}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
