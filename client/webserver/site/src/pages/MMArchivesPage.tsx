import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { formatProfit, shortSymbol, logoPath } from '../hooks/useFormatters'
import { ROUTES, type MMLogsReturnPage } from '../router/routes'

interface MarketMakingRun {
  startTime: number
  market: { baseID: number; quoteID: number; host: string }
  profit: number
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
        <h2 className="mb-0">{t('ARCHIVED_MARKET_MAKING_RUNS')}</h2>
      </div>

      {error && <div className="text-danger mb-3">{error}</div>}

      <div className="mb-3">
        <span className="me-3">{t('TOTAL_RUNS')}: {runs.length}</span>
        <span>
          {t('TOTAL_PROFIT')}: <span className={total.cls}>{total.text}</span>
        </span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>{t('START_TIME')}</th>
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
                  {baseSym && <img src={logoPath(baseSym)} width={20} height={20} alt={baseSym} />}
                  {quoteSym && <img src={logoPath(quoteSym)} width={20} height={20} alt={quoteSym} />}
                  <span>{shortSymbol(baseSym)}-{shortSymbol(quoteSym)}</span>
                </td>
                <td className={p.cls}>{p.text}</td>
                <td>
                  {/* MMA-01 + T18#3: use URLSearchParams for safe
                      URL construction, matching MMPage.tsx's pattern
                      instead of manually-concatenated template strings
                      with individual encodeURIComponent calls. The
                      `returnPage=mmarchives` param is T18#4-typed via
                      MMLogsReturnPage to prevent typos on the
                      producer side. Vanilla `mmarchives.ts` L48:
                      `loadPage('mmlogs', { ..., returnPage: 'mmarchives' })`. */}
                  <button
                    className="btn btn-sm btn-outline-secondary me-1"
                    onClick={() => {
                      const returnPage: MMLogsReturnPage = 'mmarchives'
                      const params = new URLSearchParams({
                        baseID: String(baseID),
                        quoteID: String(quoteID),
                        host,
                        startTime: String(startTime),
                        returnPage,
                      })
                      navigate(`${ROUTES.MM_LOGS}?${params.toString()}`)
                    }}
                  >
                    {t('Logs')}
                  </button>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => {
                      const params = new URLSearchParams({
                        baseID: String(baseID),
                        quoteID: String(quoteID),
                        host,
                      })
                      navigate(`${ROUTES.MM_SETTINGS}?${params.toString()}`)
                    }}
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
