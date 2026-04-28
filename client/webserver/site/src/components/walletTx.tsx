import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatCoinAtom, formatFiat, atomToConventional, ageSince
} from '../hooks/useFormatters'
import { explorerURL } from './CoinExplorers'
import { CopyButton } from './common/CopyButton'
import { FormOverlay } from './common/FormOverlay'
import type {
  WalletTransaction, SupportedAsset, UnitInfo
} from '../stores/types'

// ---------------------------------------------------------------------------
// Constants - tx types & i18n keys
// ---------------------------------------------------------------------------

export const TX_HISTORY_PAGE_SIZE = 10

export const txTypeUnknown = 0
export const txTypeSend = 1
export const txTypeReceive = 2
export const txTypeSwap = 3
export const txTypeRedeem = 4
export const txTypeRefund = 5
export const txTypeSplit = 6
export const txTypeCreateBond = 7
export const txTypeRedeemBond = 8
export const txTypeApproveToken = 9
export const txTypeAcceleration = 10
export const txTypeSelfSend = 11
export const txTypeRevokeTokenApproval = 12
export const txTypeTicketPurchase = 13
export const txTypeTicketVote = 14
export const txTypeTicketRevocation = 15
export const txTypeSwapOrSend = 16
export const txTypeMixing = 17
export const txTypeBridgeInitiation = 18
export const txTypeBridgeCompletion = 19

export const positiveTxTypes = [
  txTypeReceive, txTypeRedeem, txTypeRefund, txTypeRedeemBond,
  txTypeTicketVote, txTypeTicketRevocation, txTypeBridgeCompletion
]
export const negativeTxTypes = [
  txTypeSend, txTypeSwap, txTypeCreateBond, txTypeTicketPurchase,
  txTypeSwapOrSend, txTypeBridgeInitiation
]
export const noAmtTxTypes = [
  txTypeSplit, txTypeApproveToken, txTypeAcceleration,
  txTypeRevokeTokenApproval
]

// WP-10: tx-type i18n keys. Mirrors vanilla `wallets.ts`
// `txTypeTranslationKeys` array indexed by tx type, then resolved
// via `intl.prep(txTypeTranslationKeys[txType])`.
export const TX_TYPE_KEYS: Record<number, string> = {
  [txTypeUnknown]: 'TX_TYPE_UNKNOWN',
  [txTypeSend]: 'TX_TYPE_SEND',
  [txTypeReceive]: 'TX_TYPE_RECEIVE',
  [txTypeSwap]: 'TX_TYPE_SWAP',
  [txTypeRedeem]: 'TX_TYPE_REDEEM',
  [txTypeRefund]: 'TX_TYPE_REFUND',
  [txTypeSplit]: 'TX_TYPE_SPLIT',
  [txTypeCreateBond]: 'TX_TYPE_CREATE_BOND',
  [txTypeRedeemBond]: 'TX_TYPE_REDEEM_BOND',
  [txTypeApproveToken]: 'TX_TYPE_APPROVE_TOKEN',
  [txTypeAcceleration]: 'TX_TYPE_ACCELERATION',
  [txTypeSelfSend]: 'TX_TYPE_SELF_TRANSFER',
  [txTypeRevokeTokenApproval]: 'TX_TYPE_REVOKE_TOKEN_APPROVAL',
  [txTypeTicketPurchase]: 'TX_TYPE_TICKET_PURCHASE',
  [txTypeTicketVote]: 'TX_TYPE_TICKET_VOTE',
  [txTypeTicketRevocation]: 'TX_TYPE_TICKET_REVOCATION',
  [txTypeSwapOrSend]: 'TX_TYPE_SWAP_OR_SEND',
  [txTypeMixing]: 'TX_TYPE_MIX',
  [txTypeBridgeInitiation]: 'TX_TYPE_BRIDGE_INITIATION',
  [txTypeBridgeCompletion]: 'TX_TYPE_BRIDGE_COMPLETION',
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function txTypeLabel (t: (k: string) => string, txType: number): string {
  const key = TX_TYPE_KEYS[txType] ?? 'TX_TYPE_UNKNOWN'
  return t(key)
}

export function txSignAndClass (txType: number): [string, string] {
  if (positiveTxTypes.includes(txType)) return ['+', 'text-success']
  if (negativeTxTypes.includes(txType)) return ['-', 'text-danger']
  return ['', '']
}

// txStatus maps a transaction's confirms / confirmed flags to a
// user-facing status string. The three states match the Status column
// values agreed in the /wallets refresh: Pending (no confirms yet),
// X/Y conf (mid-confirmation), Confirmed (target reached).
export function txStatus (t: (k: string) => string, tx: WalletTransaction): string {
  if (tx.confirmed) return t('Confirmed')
  if (tx.confirms && tx.confirms.current > 0) {
    if (tx.confirms.current >= tx.confirms.target) return t('Confirmed')
    return `${tx.confirms.current}/${tx.confirms.target} ${t('Confs').toLowerCase()}`
  }
  return t('Pending')
}

// feeUSD converts a tx fee (in atoms of the network/parent asset) to a
// $ string, mirroring the rounding rules used by the Transaction Costs
// panel in WalletDetail. Returns "-" when no fiat rate is available
// for the fee asset, "$0.01" for sub-cent positives so users can tell
// the fee is non-zero, and "$X.XX" otherwise.
//
// For tokens the network/gas fee is paid in the parent asset (POL/ETH),
// not the token itself - so callers pass `parentAsset` (or null for
// non-tokens) and we pick the fee asset's UnitInfo + fiat rate
// accordingly. Same convention as the Transaction Costs panel.
export function feeUSD (
  feeAtoms: number,
  asset: SupportedAsset,
  parentAsset: SupportedAsset | null,
  fiatRatesMap: Record<number, number>
): string {
  if (feeAtoms <= 0) return '-'
  const feeAsset = parentAsset ?? asset
  const feeUI = feeAsset.unitInfo
  const feeFiatRate = fiatRatesMap[feeAsset.id] ?? 0
  if (feeFiatRate <= 0) return '-'
  const v = atomToConventional(feeAtoms, feeUI) * feeFiatRate
  // formatFiat truncates to 2 decimals, masking real sub-cent fees
  // (e.g. POL at $0.09 + 143 gwei = ~$0.0003) as a flat "$0.00".
  // Round any positive sub-cent value up to $0.01 so the user can
  // tell the fee isn't actually zero.
  if (v > 0 && v < 0.005) return '$0.01'
  return `$${formatFiat(v)}`
}

// mergePendingAndHistory combines pending txs (live, from
// `wallet.pendingTxs`) with historical txs (from /api/txhistory) into a
// single list with pending first. A tx that's still pending locally
// might also appear in a fetched history page once it's been observed
// by the wallet - when that happens we keep the pending state (which
// has the freshest confirms data) and drop the history copy.
export function mergePendingAndHistory (
  pending: WalletTransaction[],
  history: WalletTransaction[]
): WalletTransaction[] {
  if (pending.length === 0) return history
  const seen = new Set(pending.map(p => p.id))
  const filteredHistory = history.filter(h => !seen.has(h.id))
  return [...pending, ...filteredHistory]
}

// ---------------------------------------------------------------------------
// TxTable - shared row rendering for both the embedded /wallets section
// and the dedicated /wallets/:assetID/transactions page.
// ---------------------------------------------------------------------------

export interface TxTableProps {
  txs: WalletTransaction[]
  asset: SupportedAsset
  parentAsset: SupportedAsset | null
  fiatRatesMap: Record<number, number>
  net: number
  onRowClick: (tx: WalletTransaction) => void
  // showID toggles the ID column on/off. The embedded /wallets
  // section drops it (rows are too narrow to fit a full hash); the
  // dedicated /wallets/:assetID/transactions page keeps it and
  // renders the full untrimmed hash. Default true preserves the
  // historical behavior for any other caller.
  showID?: boolean
  // fixedLayout pins column widths so they don't reflow as new
  // rows scroll into view (otherwise auto table-layout re-computes
  // widths every time the windowed slice changes - the user sees
  // columns shifting around as they scroll). Currently only used
  // by /wallets/:assetID/transactions; the embedded section's
  // 10-row table never re-windows so it doesn't need it.
  fixedLayout?: boolean
  // Optional virtualization spacers - when provided, an empty <tr>
  // of the given pixel height is rendered above / below the visible
  // rows inside <tbody>. Lets the parent (e.g. the full
  // /wallets/:assetID/transactions page) render only a windowed
  // slice of `txs` while keeping the scroll bar position correct.
  // Defaults to 0 so the embedded section (which renders all 10
  // entries) is unaffected.
  topSpacerPx?: number
  bottomSpacerPx?: number
}

// Per-column min widths in `ch` for the columns whose content is
// well-bounded by character count (numbers, short labels). The ID
// column is special: it holds a 64-char hash, but the body font
// renders mixed hex chars (0-9 + a-f) substantially wider than the
// font's "0" glyph that defines `1ch`, so a `ch` estimate
// systematically under-sizes it. We measure the ID column's actual
// pixel width once after first paint instead - see idColPxFallback
// below for the seed used before that measurement.
const COL_MIN_CH = {
  type: 25,    // longest TX_TYPE_* label is "Revoke Token Approval" (21)
  age: 11,    // "365d 24h" / "999y 12mo" worst case
  amount: 20, // "+1234567.89012345" with sign + decimals
  fee: 10,   // "$12345.67"
  status: 14, // "999/999 confs" worst case
}
// Initial ID column width used until JS measures the actual hash
// rendering. 80ch is a generous over-estimate (closer to typical
// non-mono hex rendering than `66ch` was) so the first paint
// looks reasonable even before the measurement settles in.
const ID_COL_FALLBACK_CH = 80
// Buffer added to the measured hash width to leave room for the
// trailing CopyButton + margin + cell padding. 36px covers the
// btn-sm padding, the icon, and the `me-1` gap on the link.
const ID_COL_TRAILING_PX = 36

const NON_ID_COL_TOTAL_CH = COL_MIN_CH.type + COL_MIN_CH.age +
  COL_MIN_CH.amount + COL_MIN_CH.fee + COL_MIN_CH.status

export function TxTable ({
  txs, asset, parentAsset, fiatRatesMap, net, onRowClick,
  showID = true, fixedLayout = false,
  topSpacerPx = 0, bottomSpacerPx = 0
}: TxTableProps) {
  const { t } = useTranslation()
  const ui = asset.unitInfo
  const assetID = asset.id
  // colSpan for spacer rows must match the visible column count or
  // the row collapses to one cell width (and breaks the spacer's
  // height under some renderers). showID flips one column in/out.
  const colCount = showID ? 6 : 5

  // Measure the rendered width of a hash once so the ID column can
  // be sized to fit exactly. Without this, `ch`-based sizing
  // under-estimates - the body font's "0" glyph (defining 1ch) is
  // narrower than the average hex character, so 64ch ends up
  // smaller than a 64-char hash actually renders.
  const measureRef = useRef<HTMLSpanElement>(null)
  const [idColWidthPx, setIdColWidthPx] = useState<number | null>(null)
  // Sample = the first hash we have. If txs[] later includes hashes
  // of different lengths (e.g. swapping wallets), the dep on
  // sampleHash re-runs the measurement.
  const sampleHash = fixedLayout && showID && txs.length > 0
    ? txs[0].id
    : null
  useLayoutEffect(() => {
    if (!sampleHash) return
    const el = measureRef.current
    if (!el) return
    const w = el.getBoundingClientRect().width
    if (w <= 0) return
    const target = w + ID_COL_TRAILING_PX
    // Compare the candidate (measured + trailing buffer) against
    // the stored value, not the bare measurement - otherwise the
    // effect would re-fire every render with a constant ~buffer-px
    // delta, even though React would dedupe the setState.
    if (idColWidthPx === null || Math.abs(target - idColWidthPx) > 0.5) {
      setIdColWidthPx(target)
    }
  }, [sampleHash, idColWidthPx])

  // colWidth distributes any remaining table space equally across
  // the six visible columns once each column has its content
  // minimum. The ID column carries a measured pixel value (not
  // ch); the others stay in ch. Combined the calc resolves
  // correctly under either unit.
  const idMinExpr = idColWidthPx !== null
    ? `${idColWidthPx}px`
    : `${ID_COL_FALLBACK_CH}ch`
  const minTotalExpr = `(${idMinExpr} + ${NON_ID_COL_TOTAL_CH}ch)`
  const colWidth = (minCh: number) =>
    `calc(${minCh}ch + max(0px, (100% - ${minTotalExpr}) / 6))`
  const idColCalc =
    `calc(${idMinExpr} + max(0px, (100% - ${minTotalExpr}) / 6))`

  return (
    <>
      {/* Off-screen measurement element used to compute the ID
          column's natural pixel width once a hash is available.
          Positioned absolutely far off-screen so it has no layout
          effect; visibility:hidden keeps it from painting; the
          browser still computes a getBoundingClientRect on it. */}
      {sampleHash && (
        <span
          ref={measureRef}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            visibility: 'hidden',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
          }}
        >
          {sampleHash}
        </span>
      )}
      <table
        className="compact row-border row-hover"
        style={fixedLayout
          ? {
              tableLayout: 'fixed',
              width: '100%',
              // Floor so narrow viewports get a horizontal scrollbar
              // (via the parent's overflowX: auto) instead of cells
              // collapsing under the per-column minimums.
              minWidth: `calc(${minTotalExpr})`,
              // Cascades to all cells; keeps every entry on one row.
              whiteSpace: 'nowrap'
            }
          : undefined}
      >
        {/* <colgroup> only kicks in when fixedLayout=true. Each
            column gets its content-minimum plus an equal share of
            remaining table width via calc(). The embedded section
            never sets fixedLayout, so it keeps auto layout. */}
        {fixedLayout && (
          <colgroup>
            <col style={{ width: colWidth(COL_MIN_CH.type) }} />
            {showID && <col style={{ width: idColCalc }} />}
            <col style={{ width: colWidth(COL_MIN_CH.age) }} />
            <col style={{ width: colWidth(COL_MIN_CH.amount) }} />
            <col style={{ width: colWidth(COL_MIN_CH.fee) }} />
            <col style={{ width: colWidth(COL_MIN_CH.status) }} />
          </colgroup>
        )}
        <thead className="fs15">
          <tr>
            <th>{t('Type')}</th>
            {showID && <th className="d-none d-sm-table-cell">{t('ID')}</th>}
            <th>{t('Age')}</th>
            <th className="text-end">{t('Amount')}</th>
            <th className="text-end">{t('Fee')}</th>
            <th>{t('Status')}</th>
          </tr>
        </thead>
        <tbody>
          {topSpacerPx > 0 && (
            <tr style={{ borderTop: 'none' }}>
              <td colSpan={colCount} style={{ height: topSpacerPx, padding: 0 }} />
            </tr>
          )}
          {txs.map(tx => {
            const [sign, cls] = txSignAndClass(tx.type)
            const label = txTypeLabel(t, tx.type)
            const url = explorerURL(assetID, tx.id, net)
            return (
              <tr
                key={tx.id}
                className="pointer"
                onClick={() => onRowClick(tx)}
              >
                <td>{label}</td>
                {showID && (
                  <td
                    className="d-none d-sm-table-cell"
                    onClick={e => e.stopPropagation()}
                  >
                    {url
                      ? <a href={url} target="_blank" rel="noopener noreferrer" className="subtlelink me-1">{tx.id}</a>
                      : <span className="me-1">{tx.id}</span>}
                    <CopyButton text={tx.id} />
                  </td>
                )}
                <td>{tx.timestamp > 0 ? ageSince(tx.timestamp * 1000) : t('Pending')}</td>
                <td className={`text-end ${cls}`}>
                  {noAmtTxTypes.includes(tx.type)
                    ? '-'
                    : `${sign}${formatCoinAtom(tx.amount, ui)}`}
                </td>
                <td className="text-end">{feeUSD(tx.fees, asset, parentAsset, fiatRatesMap)}</td>
                <td>{txStatus(t, tx)}</td>
              </tr>
            )
          })}
          {bottomSpacerPx > 0 && (
            <tr style={{ borderTop: 'none' }}>
              <td colSpan={colCount} style={{ height: bottomSpacerPx, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}

// ---------------------------------------------------------------------------
// TxDetailModal - per-tx detail view, opened by row click in either
// the embedded /wallets section or the full /wallets/:assetID/transactions
// page.
// ---------------------------------------------------------------------------

export interface TxDetailModalProps {
  tx: WalletTransaction | null
  asset: SupportedAsset
  parentAsset: SupportedAsset | null
  fiatRatesMap: Record<number, number>
  net: number
  onClose: () => void
}

export function TxDetailModal ({
  tx, asset, parentAsset, fiatRatesMap, net, onClose
}: TxDetailModalProps) {
  const { t } = useTranslation()
  const ui: UnitInfo = asset.unitInfo
  if (!tx) return null
  const url = explorerURL(asset.id, tx.id, net)

  return (
    <FormOverlay bare show onClose={onClose}>
      <div className="bg-body border rounded p-4" style={{ minWidth: 460, maxWidth: 560 }}>
        <div className="d-flex align-items-center justify-content-between mb-3">
          <span className="fs18 demi">{t('TRANSACTION_DETAILS')}</span>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={onClose}
          >
            {t('Close')}
          </button>
        </div>

        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Type')}:</span> {txTypeLabel(t, tx.type)}
        </div>
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Status')}:</span> {txStatus(t, tx)}
        </div>
        <div className="mb-2 fs14 d-flex align-items-center flex-wrap gap-1">
          <span className="text-secondary">{t('ID')}:</span>
          <code className="text-break fs12">{tx.id}</code>
          <CopyButton text={tx.id} />
        </div>
        {!noAmtTxTypes.includes(tx.type) && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Amount')}:</span>{' '}
            {formatCoinAtom(tx.amount, ui)} {ui.conventional.unit}
          </div>
        )}
        {tx.fees > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Fee')}:</span>{' '}
            {feeUSD(tx.fees, asset, parentAsset, fiatRatesMap)}
          </div>
        )}
        {tx.recipient && (
          <div className="mb-2 fs14 d-flex align-items-center flex-wrap gap-1">
            <span className="text-secondary">{t('Recipient')}:</span>
            <code className="text-break fs12">{tx.recipient}</code>
          </div>
        )}
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Time')}:</span>{' '}
          {tx.timestamp > 0
            ? new Date(tx.timestamp * 1000).toLocaleString()
            : t('Pending')}
        </div>
        {tx.blockNumber > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Block')}:</span>{' '}
            {tx.blockNumber}
          </div>
        )}
        {tx.confirms && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Confirmations')}:</span>{' '}
            {tx.confirms.current}/{tx.confirms.target}
          </div>
        )}
        {tx.bondInfo && (
          <>
            <div className="mb-2 fs14 d-flex align-items-center flex-wrap gap-1">
              <span className="text-secondary">{t('BOND_ID')}:</span>
              <code className="text-break fs12">{tx.bondInfo.bondID}</code>
            </div>
            <div className="mb-2 fs14">
              <span className="text-secondary">{t('LOCK_TIME')}:</span>{' '}
              {new Date(tx.bondInfo.lockTime * 1000).toLocaleString()}
            </div>
          </>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-outline-primary mt-2"
          >
            {t('VIEW_IN_EXPLORER')}
          </a>
        )}
      </div>
    </FormOverlay>
  )
}
