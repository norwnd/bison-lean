import { Link } from 'react-router-dom'
import { useAuthStore } from '../../stores/useAuthStore'
import { explorerURL } from '../CoinExplorers'
import { parseRichNote } from '../../services/notifier'
import { orderPath } from '../../router/routes'

// RichNote renders a Core note `details` string with `{{{order|HASH}}}`
// and `{{{ASSETID|COINHASH}}}` tokens replaced by clickable links —
// internal route for orders, external coin-explorer URL for coins.
// Mirrors dev2 `notifications.ts insertRichNote()`.
export function RichNote ({ details }: { details: string }) {
  const net = useAuthStore(s => s.user?.net) ?? 0
  const segments = parseRichNote(details)
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.value}</span>
        if (seg.kind === 'order') {
          return (
            <Link key={i} to={orderPath(seg.hash)} className="subtlelink">
              {seg.hash.slice(0, 8)}
            </Link>
          )
        }
        const url = explorerURL(seg.assetID, seg.hash, net)
        if (!url) return <span key={i}>{seg.hash.slice(0, 8)}</span>
        return (
          <a key={i} href={url} target="_blank" rel="noreferrer">
            {seg.hash.slice(0, 8)}
          </a>
        )
      })}
    </>
  )
}
