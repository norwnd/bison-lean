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
// single list with pending first. Dedupes by tx id across BOTH lists
// AND within each list, so:
//   - a tx that's pending locally and also appears in a fetched
//     history page only renders once (pending wins, since it has the
//     freshest confirms data)
//   - any duplicates introduced by chained loadMore calls (the
//     /api/txhistory endpoint includes the refID tx in its response,
//     so the first row of each new page is the last row of the
//     previous one) get squashed.
export function mergePendingAndHistory (
  pending: WalletTransaction[],
  history: WalletTransaction[]
): WalletTransaction[] {
  const seen = new Set<string>()
  const out: WalletTransaction[] = []
  for (const tx of pending) {
    if (seen.has(tx.id)) continue
    seen.add(tx.id)
    out.push(tx)
  }
  for (const tx of history) {
    if (seen.has(tx.id)) continue
    seen.add(tx.id)
    out.push(tx)
  }
  return out
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

// Per-column minimum pixel widths sized to fit the worst-case
// content. Each column actually renders at `min + extra/N` where
// extra is the table's leftover width past the sum of mins and N
// is the visible column count, so any space the viewport gives us
// past the content minimums is split evenly across all columns
// (the ID column doesn't hog its share).
const COL_PX = {
  type: 130,    // longest TX_TYPE_* label "Revoke Token Approval"
  id: 760,     // 64-char hash + CopyButton + cell padding
  age: 80,    // "999y 12mo" / "365d 24h" worst case
  amount: 130, // signed atom-formatted amounts with decimals
  fee: 70,    // "$12345.67"
  status: 100, // "999/999 confs" / "Confirmed"
}
const COL_PX_TOTAL = COL_PX.type + COL_PX.id + COL_PX.age +
  COL_PX.amount + COL_PX.fee + COL_PX.status

// colWidth distributes the table's leftover width past the minimums
// equally across N columns. Pure-px calc() to avoid the ch quirks
// that mis-sized this earlier.
const colWidth = (minPx: number, n: number) =>
  `calc(${minPx}px + max(0px, (100% - ${COL_PX_TOTAL}px) / ${n}))`

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

  return (
    <table
      className="compact row-border row-hover"
      style={fixedLayout
        ? {
            tableLayout: 'fixed',
            // width: 100% lets the table fill the scroller so the
            // calc() in <col> resolves `(100% - mins)/N` against
            // the full viewport - that's what gives every column
            // an equal share of the leftover space instead of the
            // ID column hogging it as natural slack.
            width: '100%',
            // Floor so narrow viewports don't shrink columns below
            // their content - the parent's overflowX:auto kicks in
            // for a horizontal scrollbar instead.
            minWidth: `${COL_PX_TOTAL}px`,
            // Cascades to all cells; keeps every entry on one row.
            whiteSpace: 'nowrap'
          }
        : undefined}
    >
      {/* <colgroup> only kicks in when fixedLayout=true. Each
          column gets its content min plus an equal share of any
          extra table width via calc(). The embedded section uses
          showID=false (skipping fixedLayout via WalletDetail's
          TransactionsSection) so it keeps auto layout. */}
      {fixedLayout && (
        <colgroup>
          <col style={{ width: colWidth(COL_PX.type, colCount) }} />
          {showID && <col style={{ width: colWidth(COL_PX.id, colCount) }} />}
          <col style={{ width: colWidth(COL_PX.age, colCount) }} />
          <col style={{ width: colWidth(COL_PX.amount, colCount) }} />
          <col style={{ width: colWidth(COL_PX.fee, colCount) }} />
          <col style={{ width: colWidth(COL_PX.status, colCount) }} />
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
