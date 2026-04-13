import { useMemo } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'
import { strongTier, parcelLimitScoreMultiplier } from '../AccountUtils'

interface Props {
  host: string
}

export function ReputationMeter ({ host }: Props) {
  const exchanges = useAuthStore(s => s.exchanges)
  const exchange = exchanges[host]

  const data = useMemo(() => {
    if (!exchange) return null
    const { auth, maxScore, penaltyThreshold } = exchange
    const { rep: { score } } = auth

    const displayTier = strongTier(auth)
    const minScore = displayTier ? displayTier * penaltyThreshold * -1 : penaltyThreshold * -1
    const warnPct = 25
    const scorePct = 100 - warnPct
    const pos = score >= 0
      ? warnPct + (score / maxScore) * scorePct
      : warnPct - (Math.min(warnPct, score / minScore * warnPct))
    const bonus = score > 0 ? 1 + score / maxScore * (parcelLimitScoreMultiplier - 1) : 1

    const penaltyMarkers: number[] = []
    if (displayTier > 1) {
      const markerPct = warnPct / displayTier
      for (let i = 1; i < displayTier; i++) {
        penaltyMarkers.push(markerPct * i)
      }
    }

    return { score, minScore, maxScore, pos, bonus, penaltyMarkers, displayTier }
  }, [exchange])

  if (!data) return null

  const { score, minScore, maxScore, pos, bonus, penaltyMarkers } = data
  const isPositive = score > 0

  return (
    <div className={`reputation-meter${isPositive ? ' positive' : ' negative'}`}>
      <div className="score-tray position-relative" style={{ height: '24px', background: '#333', borderRadius: '4px', overflow: 'hidden' }}>
        <div
          className="score-warn"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '25%', background: 'rgba(209, 14, 14, 0.2)' }}
        />
        {penaltyMarkers.map((pct, i) => (
          <div
            key={i}
            className="penalty-marker"
            style={{
              position: 'absolute', left: `${pct}%`, top: 0, bottom: 0,
              width: '1px', background: '#d10e0e'
            }}
          />
        ))}
        <div
          className="score-pointer"
          style={{
            position: 'absolute', top: '2px', bottom: '2px', width: '3px',
            background: isPositive ? '#2e9f67' : '#d10e0e',
            borderRadius: '2px', left: `${pos}%`, transform: 'translateX(-50%)'
          }}
        />
      </div>
      <div className="d-flex justify-content-between mt-1 fs12">
        <span>{minScore}</span>
        <span>
          Score: <strong style={{ color: isPositive ? '#2e9f67' : '#d10e0e' }}>{score}</strong>
          {' | Limit bonus: '}
          <strong>{bonus.toFixed(1)}x</strong>
        </span>
        <span>{maxScore}</span>
      </div>
    </div>
  )
}
