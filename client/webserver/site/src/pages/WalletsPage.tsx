import {
  useState, useEffect, useCallback, useMemo
} from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { DepositAddress } from '../components/common/DepositAddress'
import {
  formatCoinValue, formatFullPrecision, formatFiatConversion,
  formatFourSigFigs
} from '../hooks/useFormatters'
import { explorerURL } from '../components/CoinExplorers'
import { filled } from '../components/AccountUtils'
import type {
  SupportedAsset, WalletState,
  BalanceNote, WalletStateNote,
  RateNote,
  WalletTransaction, TxHistoryResult, Order, UnitInfo,
  CoreNote, TicketStakingStatus, VotingServiceProvider
} from '../stores/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const traitRescanner = 1
const traitTxFeeEstimator = 1 << 9
const traitTicketBuyer = 1 << 15
const traitFundsMixer = 1 << 17

const DCR_ASSET_ID = 42
const TX_HISTORY_PAGE_SIZE = 10

const txTypeUnknown = 0
const txTypeSend = 1
const txTypeReceive = 2
const txTypeSwap = 3
const txTypeRedeem = 4
const txTypeRefund = 5
const txTypeSplit = 6
const txTypeCreateBond = 7
const txTypeRedeemBond = 8
const txTypeApproveToken = 9
const txTypeAcceleration = 10
const txTypeSelfSend = 11
const txTypeRevokeTokenApproval = 12
const txTypeTicketPurchase = 13
const txTypeTicketVote = 14
const txTypeTicketRevocation = 15
const txTypeSwapOrSend = 16
const txTypeMixing = 17
const txTypeBridgeInitiation = 18
const txTypeBridgeCompletion = 19

const positiveTxTypes = [
  txTypeReceive, txTypeRedeem, txTypeRefund, txTypeRedeemBond,
  txTypeTicketVote, txTypeTicketRevocation, txTypeBridgeCompletion
]
const negativeTxTypes = [
  txTypeSend, txTypeSwap, txTypeCreateBond, txTypeTicketPurchase,
  txTypeSwapOrSend, txTypeBridgeInitiation
]
const noAmtTxTypes = [
  txTypeSplit, txTypeApproveToken, txTypeAcceleration,
  txTypeRevokeTokenApproval
]

const TX_TYPE_LABELS: Record<number, string> = {
  [txTypeUnknown]: 'Unknown',
  [txTypeSend]: 'Send',
  [txTypeReceive]: 'Receive',
  [txTypeSwap]: 'Swap',
  [txTypeRedeem]: 'Redeem',
  [txTypeRefund]: 'Refund',
  [txTypeSplit]: 'Split',
  [txTypeCreateBond]: 'Create Bond',
  [txTypeRedeemBond]: 'Redeem Bond',
  [txTypeApproveToken]: 'Approve Token',
  [txTypeAcceleration]: 'Acceleration',
  [txTypeSelfSend]: 'Self Transfer',
  [txTypeRevokeTokenApproval]: 'Revoke Approval',
  [txTypeTicketPurchase]: 'Ticket Purchase',
  [txTypeTicketVote]: 'Ticket Vote',
  [txTypeTicketRevocation]: 'Ticket Revocation',
  [txTypeSwapOrSend]: 'Swap/Send',
  [txTypeMixing]: 'Mix',
  [txTypeBridgeInitiation]: 'Bridge',
  [txTypeBridgeCompletion]: 'Bridge Complete'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logoPath (symbol: string): string {
  let s = symbol.split('.')[0]
  if (s === 'weth') s = 'eth'
  return `/img/coins/${s}.png`
}

function ageSince (ms: number): string {
  let dur = Date.now() - ms
  if (dur < 1000) return '0s'
  const units: [number, string][] = [
    [31536000000, 'y'], [2592000000, 'mo'], [86400000, 'd'],
    [3600000, 'h'], [60000, 'min'], [1000, 's']
  ]
  let chunks = 0
  let result = ''
  for (const [divisor, label] of units) {
    const n = Math.floor(dur / divisor)
    dur %= divisor
    if (n === 0 && chunks === 0) continue
    result += `${n}${label} `
    chunks++
    if (chunks >= 2) break
  }
  return result.trim()
}

function txSignAndClass (txType: number): [string, string] {
  if (positiveTxTypes.includes(txType)) return ['+', 'text-success']
  if (negativeTxTypes.includes(txType)) return ['-', 'text-danger']
  return ['', '']
}

function totalFiatBalance (
  assets: Record<number, SupportedAsset>,
  fiatRatesMap: Record<number, number>
): number {
  let total = 0
  for (const asset of Object.values(assets)) {
    if (!asset.wallet) continue
    const bal = asset.wallet.balance
    const rate = fiatRatesMap[asset.id]
    if (!rate) continue
    const conv = asset.unitInfo.conventional.conversionFactor
    total += ((bal.available + bal.locked + bal.immature) / conv) * rate
  }
  return total
}

/** Group assets by normalized ticker for the sidebar. */
interface TickerGroup {
  ticker: string
  symbol: string
  name: string
  assetIDs: number[]
  primaryAssetID: number
  hasWallet: boolean
  totalFiat: number
}

function buildTickerGroups (
  assets: Record<number, SupportedAsset>,
  fiatRatesMap: Record<number, number>
): TickerGroup[] {
  const groups: Record<string, TickerGroup> = {}
  for (const asset of Object.values(assets)) {
    const baseSym = asset.symbol.split('.')[0].toUpperCase()
    const ticker = baseSym === 'WETH'
      ? 'ETH'
      : baseSym
    if (!groups[ticker]) {
      groups[ticker] = {
        ticker,
        symbol: asset.symbol,
        name: asset.name,
        assetIDs: [],
        primaryAssetID: asset.id,
        hasWallet: false,
        totalFiat: 0
      }
    }
    const g = groups[ticker]
    g.assetIDs.push(asset.id)
    if (!asset.token && asset.wallet) {
      g.primaryAssetID = asset.id
    }
    if (asset.wallet) {
      g.hasWallet = true
      const bal = asset.wallet.balance
      const rate = fiatRatesMap[asset.id] ?? 0
      const conv = asset.unitInfo.conventional.conversionFactor
      g.totalFiat += ((bal.available + bal.locked + bal.immature) / conv) * rate
    }
  }
  return Object.values(groups).sort((a, b) => {
    if (a.hasWallet !== b.hasWallet) {
      return a.hasWallet
        ? -1
        : 1
    }
    return b.totalFiat - a.totalFiat
  })
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function WalletsPage () {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const user = useAuthStore(s => s.user)
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(null)
  const [activeForm, setActiveForm] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Force re-render on note arrival so balances refresh.
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick(n => n + 1), [])

  // -----------------------------------------------------------------------
  // WS subscriptions
  // -----------------------------------------------------------------------

  const noteReceivers = useMemo(() => ({
    balance: (note: CoreNote) => {
      const n = note as BalanceNote
      const store = useAuthStore.getState()
      const asset = store.assets[n.assetID]
      if (!asset) return
      asset.wallet.balance = n.balance
      store.walletMap[n.assetID] = asset.wallet
      bump()
    },
    walletstate: (note: CoreNote) => {
      const n = note as WalletStateNote
      const store = useAuthStore.getState()
      const assetID = n.wallet.assetID
      const asset = store.assets[assetID]
      if (!asset) return
      asset.wallet = n.wallet
      store.walletMap[assetID] = n.wallet
      bump()
    },
    walletsync: (_note: CoreNote) => {
      bump()
    },
    fiatrateupdate: (note: CoreNote) => {
      const n = note as RateNote
      const store = useAuthStore.getState()
      Object.assign(store.fiatRatesMap, n.fiatRates)
      bump()
    },
    createwallet: (_note: CoreNote) => {
      fetchUser()
    },
    transaction: (_note: CoreNote) => {
      bump()
    }
  }), [bump, fetchUser])

  useNotifications(noteReceivers)

  // -----------------------------------------------------------------------
  // Sidebar
  // -----------------------------------------------------------------------

  const tickerGroups = useMemo(
    () => buildTickerGroups(assets, fiatRatesMap),
    [assets, fiatRatesMap]
  )

  const filteredGroups = useMemo(() => {
    if (!searchQuery) return tickerGroups
    const q = searchQuery.toLowerCase()
    return tickerGroups.filter(g =>
      g.ticker.toLowerCase().includes(q) ||
      g.name.toLowerCase().includes(q)
    )
  }, [tickerGroups, searchQuery])

  // Auto-select the first wallet-bearing asset on mount.
  useEffect(() => {
    if (selectedAssetID !== null) return
    const first = tickerGroups.find(g => g.hasWallet)
    if (first) setSelectedAssetID(first.primaryAssetID)
  }, [tickerGroups, selectedAssetID])

  const selectedAsset = selectedAssetID !== null
    ? assets[selectedAssetID]
    : null
  const selectedWallet = selectedAsset?.wallet ?? null
  const net = user?.net ?? 0

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="d-flex" style={{ height: '100%' }}>
      {/* ---- Sidebar ---- */}
      <div
        className="border-end overflow-y-auto flex-shrink-0"
        style={{ width: 260, minHeight: 0 }}
      >
        <div className="p-2">
          <div className="fs14 text-secondary mb-1">
            {t('Total')}: ${formatFourSigFigs(totalFiatBalance(assets, fiatRatesMap))}
          </div>
          <input
            type="text"
            className="form-control form-control-sm mb-2"
            placeholder={t('Search assets...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {filteredGroups.map(g => {
          const selected = g.assetIDs.includes(selectedAssetID ?? -1)
          return (
            <div
              key={g.ticker}
              className={`d-flex align-items-center gap-2 px-3 py-2 cursor-pointer ${selected ? 'bg-primary bg-opacity-10' : ''}`}
              onClick={() => setSelectedAssetID(g.primaryAssetID)}
            >
              <img
                src={logoPath(g.symbol)}
                alt={g.ticker}
                width={28}
                height={28}
              />
              <div className="flex-grow-1 overflow-hidden">
                <div className="fs14 fw-bold text-truncate">{g.ticker}</div>
                <div className="fs12 text-secondary text-truncate">{g.name}</div>
              </div>
              {g.hasWallet && (
                <div className="text-end fs12 text-secondary">
                  ${formatFourSigFigs(g.totalFiat, 2)}
                </div>
              )}
              {!g.hasWallet && (
                <span className="fs11 text-secondary">{t('No wallet')}</span>
              )}
            </div>
          )
        })}
      </div>

      {/* ---- Main Content ---- */}
      <div className="flex-grow-1 overflow-y-auto p-3" style={{ minHeight: 0 }}>
        {!selectedAsset && (
          <div className="text-center text-secondary py-5">
            {t('Select an asset from the sidebar.')}
          </div>
        )}
        {selectedAsset && selectedWallet && (
          <WalletDetail
            asset={selectedAsset}
            wallet={selectedWallet}
            assets={assets}
            fiatRatesMap={fiatRatesMap}
            net={net}
            setActiveForm={setActiveForm}
          />
        )}
        {selectedAsset && !selectedWallet && (
          <NoWalletView
            asset={selectedAsset}
            onCreated={() => fetchUser()}
          />
        )}
      </div>

      {/* ---- Modals ---- */}
      <FormOverlay show={activeForm === 'receive'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 340 }}>
          <div className="fs18 mb-3">{t('Receive')}</div>
          {selectedAssetID !== null && (
            <DepositAddress assetID={selectedAssetID} />
          )}
        </div>
      </FormOverlay>

      <FormOverlay show={activeForm === 'send'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380 }}>
          {selectedAsset && selectedWallet && (
            <SendForm
              asset={selectedAsset}
              wallet={selectedWallet}
              assets={assets}
              fiatRatesMap={fiatRatesMap}
              onSuccess={() => setActiveForm(null)}
            />
          )}
        </div>
      </FormOverlay>

      <FormOverlay show={activeForm === 'txHistory'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 500, maxHeight: '80vh', overflowY: 'auto' }}>
          {selectedAssetID !== null && (
            <TxHistoryView
              assetID={selectedAssetID}
              assets={assets}
              net={net}
            />
          )}
        </div>
      </FormOverlay>

      <FormOverlay show={activeForm === 'config'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380 }}>
          {selectedAsset && selectedWallet && (
            <WalletConfigView
              asset={selectedAsset}
              wallet={selectedWallet}
              onClose={() => setActiveForm(null)}
            />
          )}
        </div>
      </FormOverlay>

      <FormOverlay show={activeForm === 'staking'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 400, maxHeight: '80vh', overflowY: 'auto' }}>
          {selectedAssetID === DCR_ASSET_ID && (
            <StakingView
              assetID={DCR_ASSET_ID}
              assets={assets}
            />
          )}
        </div>
      </FormOverlay>

      <FormOverlay show={activeForm === 'orders'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 500, maxHeight: '80vh', overflowY: 'auto' }}>
          {selectedAssetID !== null && (
            <RecentOrdersView
              assetID={selectedAssetID}
              assets={assets}
            />
          )}
        </div>
      </FormOverlay>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NoWalletView
// ---------------------------------------------------------------------------

function NoWalletView ({ asset, onCreated }: {
  asset: SupportedAsset
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  return (
    <div className="text-center py-4">
      <img src={logoPath(asset.symbol)} alt={asset.symbol} width={48} height={48} className="mb-3" />
      <div className="fs18 mb-2">{asset.name}</div>
      <p className="text-secondary fs14 mb-3">{t('No wallet configured for this asset.')}</p>
      {error && <div className="text-danger fs14 mb-2">{error}</div>}
      <button
        className="btn btn-primary"
        disabled={creating}
        onClick={async () => {
          setCreating(true)
          setError('')
          // For simple wallet creation without config, use the API directly.
          // Full wallet config forms would need the NewWalletForm component.
          onCreated()
          setCreating(false)
        }}
      >
        {creating
          ? '...'
          : t('Create Wallet')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WalletDetail
// ---------------------------------------------------------------------------

interface WalletDetailProps {
  asset: SupportedAsset
  wallet: WalletState
  assets: Record<number, SupportedAsset>
  fiatRatesMap: Record<number, number>
  net: number
  setActiveForm: (f: string | null) => void
}

function WalletDetail ({
  asset, wallet, assets, fiatRatesMap,
  net, setActiveForm
}: WalletDetailProps) {
  const { t } = useTranslation()
  const bal = wallet.balance
  const ui = asset.unitInfo
  const rate = fiatRatesMap[asset.id] ?? 0
  const parentAsset = asset.token
    ? assets[asset.token.parentID]
    : null

  const isTicketBuyer = (wallet.traits & traitTicketBuyer) !== 0 && asset.id === DCR_ASSET_ID
  const isMixer = (wallet.traits & traitFundsMixer) !== 0

  // Pending transactions
  const pendingTxs = wallet.pendingTxs
    ? Object.values(wallet.pendingTxs)
    : []

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-center gap-3 mb-4">
        <img src={logoPath(asset.symbol)} alt={asset.symbol} width={48} height={48} />
        <div>
          <div className="fs22 fw-bold">{asset.name}</div>
          <div className="fs14 text-secondary">
            {asset.unitInfo.conventional.unit}
            {wallet.synced
              ? ''
              : ` - ${t('Syncing')} ${(wallet.syncProgress * 100).toFixed(1)}%`}
          </div>
        </div>
        <div className="ms-auto d-flex align-items-center gap-1">
          <span className={`badge ${wallet.open ? 'bg-success' : 'bg-secondary'}`}>
            {wallet.open
              ? t('Unlocked')
              : t('Locked')}
          </span>
          {wallet.running && wallet.peerCount > 0 && (
            <span className="badge bg-info">{wallet.peerCount} {t('peers')}</span>
          )}
        </div>
      </div>

      {/* Balance */}
      <div className="border rounded p-3 mb-3">
        <div className="row">
          <div className="col">
            <div className="fs12 text-secondary">{t('Available')}</div>
            <div className="fs18 fw-bold">{formatCoinValue(bal.available, ui)}</div>
            <div className="fs12 text-secondary">${formatFiatConversion(bal.available, rate, ui)}</div>
          </div>
          {bal.locked > 0 && (
            <div className="col">
              <div className="fs12 text-secondary">{t('Locked')}</div>
              <div className="fs14">{formatCoinValue(bal.locked, ui)}</div>
              <div className="fs12 text-secondary">${formatFiatConversion(bal.locked, rate, ui)}</div>
            </div>
          )}
          {bal.immature > 0 && (
            <div className="col">
              <div className="fs12 text-secondary">{t('Immature')}</div>
              <div className="fs14">{formatCoinValue(bal.immature, ui)}</div>
            </div>
          )}
          {bal.reservesDeficit > 0 && (
            <div className="col">
              <div className="fs12 text-secondary text-warning">{t('Reserves Deficit')}</div>
              <div className="fs14 text-warning">{formatCoinValue(bal.reservesDeficit, ui)}</div>
            </div>
          )}
        </div>

        {/* Bond/order locked breakdown */}
        {(bal.orderlocked > 0 || bal.bondlocked > 0 || bal.contractlocked > 0) && (
          <div className="d-flex flex-wrap gap-3 mt-2 fs12 text-secondary">
            {bal.orderlocked > 0 && (
              <span>{t('Orders')}: {formatCoinValue(bal.orderlocked, ui)}</span>
            )}
            {bal.bondlocked > 0 && (
              <span>{t('Bonds')}: {formatCoinValue(bal.bondlocked, ui)}</span>
            )}
            {bal.contractlocked > 0 && (
              <span>{t('Contracts')}: {formatCoinValue(bal.contractlocked, ui)}</span>
            )}
          </div>
        )}

        {/* Parent asset balance for tokens */}
        {parentAsset && parentAsset.wallet && (
          <div className="mt-2 pt-2 border-top">
            <div className="d-flex align-items-center gap-2 fs12 text-secondary">
              <img src={logoPath(parentAsset.symbol)} alt={parentAsset.symbol} width={16} height={16} />
              <span>
                {parentAsset.unitInfo.conventional.unit}{' '}
                {t('fee balance')}: {formatCoinValue(parentAsset.wallet.balance.available, parentAsset.unitInfo)}
              </span>
            </div>
          </div>
        )}

        {/* Other/custom balances */}
        {bal.other && Object.keys(bal.other).length > 0 && (
          <div className="mt-2 pt-2 border-top">
            {Object.entries(bal.other).map(([label, cb]) => (
              <div key={label} className="fs12 text-secondary">
                {label}: {formatCoinValue(cb.amt, ui)}
                {cb.locked
                  ? ` (${t('locked')})`
                  : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="d-flex flex-wrap gap-2 mb-3">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setActiveForm('send')}
          disabled={!wallet.open}
        >
          {t('Send')}
        </button>
        <button
          className="btn btn-outline-primary btn-sm"
          onClick={() => setActiveForm('receive')}
        >
          {t('Receive')}
        </button>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={() => setActiveForm('config')}
        >
          {t('Settings')}
        </button>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={() => setActiveForm('txHistory')}
        >
          {t('History')}
        </button>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={() => setActiveForm('orders')}
        >
          {t('Orders')}
        </button>
        {isTicketBuyer && (
          <button
            className="btn btn-outline-secondary btn-sm"
            onClick={() => setActiveForm('staking')}
          >
            {t('Staking')}
          </button>
        )}
      </div>

      {/* Mixing toggle (DCR) */}
      {isMixer && wallet.running && (
        <MixingToggle assetID={asset.id} />
      )}

      {/* Pending Transactions */}
      {pendingTxs.length > 0 && (
        <PendingTransactions
          txs={pendingTxs}
          ui={ui}
          assetID={asset.id}
          net={net}
        />
      )}

      {/* Sync status */}
      {!wallet.synced && wallet.syncStatus && (
        <div className="border rounded p-2 mb-3 fs12 text-secondary">
          {t('Sync progress')}: {(wallet.syncProgress * 100).toFixed(1)}%
          {' '}({wallet.syncStatus.blocks}/{wallet.syncStatus.targetHeight} {t('blocks')})
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PendingTransactions
// ---------------------------------------------------------------------------

function PendingTransactions ({ txs, ui, assetID, net }: {
  txs: WalletTransaction[]
  ui: UnitInfo
  assetID: number
  net: number
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border rounded p-2 mb-3">
      <div
        className="d-flex align-items-center cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="fs14 fw-bold flex-grow-1">
          {t('Pending Transactions')} ({txs.length})
        </span>
        <span className="fs12">{expanded
          ? '\u25B2'
          : '\u25BC'}</span>
      </div>
      {expanded && (
        <div className="mt-2">
          {txs.map(tx => {
            const [sign, cls] = txSignAndClass(tx.type)
            const label = TX_TYPE_LABELS[tx.type] ?? 'Unknown'
            const url = explorerURL(assetID, tx.id, net)
            return (
              <div key={tx.id} className="d-flex align-items-center gap-2 py-1 border-top fs12">
                <span className="text-secondary">{label}</span>
                {!noAmtTxTypes.includes(tx.type) && (
                  <span className={cls}>{sign}{formatCoinValue(tx.amount, ui)}</span>
                )}
                <span className="text-secondary ms-auto">{ageSince(tx.timestamp * 1000)} ago</span>
                {url && (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="fs11">
                    {t('View')}
                  </a>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MixingToggle
// ---------------------------------------------------------------------------

function MixingToggle ({ assetID }: { assetID: number }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const res = await postJSON('/api/mixingstats', { assetID })
      if (cancelled) return
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to load mixing status')
        return
      }
      setEnabled(res.stats?.enabled ?? false)
    }
    load()
    return () => { cancelled = true }
  }, [assetID])

  const toggle = useCallback(async () => {
    const newState = !enabled
    setLoading(true)
    setError('')
    const res = await postJSON('/api/configuremixer', { assetID, enabled: newState })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to toggle mixer')
      return
    }
    setEnabled(newState)
  }, [assetID, enabled])

  if (loading && enabled === null) {
    return (
      <div className="border rounded p-2 mb-3 fs12 text-secondary">
        {t('Loading mixing status...')}
      </div>
    )
  }

  return (
    <div className="border rounded p-2 mb-3 d-flex align-items-center gap-2">
      <span className="fs14 fw-bold">{t('Fund Mixing')}</span>
      <div className="form-check form-switch ms-auto">
        <input
          className="form-check-input"
          type="checkbox"
          checked={enabled ?? false}
          onChange={toggle}
          disabled={loading}
        />
      </div>
      {enabled && <span className="fs12 text-success">{t('Active')}</span>}
      {enabled === false && <span className="fs12 text-secondary">{t('Off')}</span>}
      {error && <span className="fs12 text-danger">{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SendForm
// ---------------------------------------------------------------------------

interface SendFormProps {
  asset: SupportedAsset
  wallet: WalletState
  assets: Record<number, SupportedAsset>
  fiatRatesMap: Record<number, number>
  onSuccess: () => void
}

function SendForm ({ asset, wallet, assets, fiatRatesMap, onSuccess }: SendFormProps) {
  const { t } = useTranslation()
  const ui = asset.unitInfo
  const rate = fiatRatesMap[asset.id] ?? 0
  const conv = ui.conventional.conversionFactor

  const [step, setStep] = useState<'input' | 'confirm'>('input')
  const [addr, setAddr] = useState('')
  const [amtStr, setAmtStr] = useState('')
  const [subtract, setSubtract] = useState(false)
  const [addrValid, setAddrValid] = useState<boolean | null>(null)
  const [txFee, setTxFee] = useState(0)
  const [feeErr, setFeeErr] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const hasFeeEstimator = (wallet.traits & traitTxFeeEstimator) !== 0
  const token = asset.token
  const feeAsset = token
    ? assets[token.parentID]
    : null
  const feeUI = feeAsset
    ? feeAsset.unitInfo
    : ui
  const feeRate = feeAsset
    ? (fiatRatesMap[token!.parentID] ?? 0)
    : rate

  const validateAddr = useCallback(async (address: string) => {
    if (!address) {
      setAddrValid(null)
      return
    }
    const res = await postJSON('/api/validateaddress', {
      addr: address,
      assetID: asset.id
    })
    setAddrValid(checkResponse(res))
  }, [asset.id])

  const handleStepSend = useCallback(async () => {
    setError('')
    setFeeErr('')
    if (!addr) {
      setError(t('Please enter an address.'))
      return
    }
    const value = Math.round(parseFloat(amtStr || '0') * conv)
    if (value <= 0) {
      setError(t('Please enter a valid amount.'))
      return
    }

    // Validate address first
    const valRes = await postJSON('/api/validateaddress', { addr, assetID: asset.id })
    if (!checkResponse(valRes)) {
      setError(t('Invalid address.'))
      return
    }

    // Estimate fee
    if (hasFeeEstimator) {
      setLoading(true)
      const feeRes = await postJSON('/api/txfee', {
        addr,
        assetID: asset.id,
        subtract,
        value
      })
      setLoading(false)
      if (!checkResponse(feeRes)) {
        setFeeErr(feeRes.msg || t('Fee estimation failed'))
        // Still proceed to confirm without fee estimate
      } else if (!feeRes.validaddress) {
        setError(t('Invalid address.'))
        return
      } else {
        setTxFee(feeRes.txfee ?? 0)
      }
    }

    setStep('confirm')
  }, [addr, amtStr, asset.id, conv, hasFeeEstimator, subtract, t])

  const handleSend = useCallback(async () => {
    setError('')
    if (!password) {
      setError(t('Password is required.'))
      return
    }
    const value = Math.round(parseFloat(amtStr || '0') * conv)
    setLoading(true)
    const res = await postJSON('/api/send', {
      assetID: asset.id,
      address: addr,
      subtract,
      value,
      pw: password
    })
    setLoading(false)
    setPassword('')
    if (!checkResponse(res)) {
      setError(res.msg || t('Send failed.'))
      return
    }
    onSuccess()
  }, [addr, amtStr, asset.id, conv, onSuccess, password, subtract, t])

  const valueAtoms = Math.round(parseFloat(amtStr || '0') * conv)

  if (step === 'confirm') {
    return (
      <div>
        <div className="fs18 mb-3">{t('Confirm Send')}</div>
        <div className="d-flex align-items-center gap-2 mb-3">
          <img src={logoPath(asset.symbol)} alt={asset.symbol} width={24} height={24} />
          <span className="fw-bold">{asset.unitInfo.conventional.unit}</span>
        </div>

        <div className="mb-2 fs14">
          <span className="text-secondary">{t('To')}:</span>{' '}
          <code className="text-break">{addr}</code>
        </div>
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Amount')}:</span>{' '}
          {formatFullPrecision(valueAtoms, ui)}
          {rate > 0 && (
            <span className="text-secondary"> (${formatFiatConversion(valueAtoms, rate, ui)})</span>
          )}
        </div>
        {txFee > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Estimated Fee')}:</span>{' '}
            {formatFullPrecision(txFee, feeUI)}
            {feeRate > 0 && (
              <span className="text-secondary"> (${formatFiatConversion(txFee, feeRate, feeUI)})</span>
            )}
          </div>
        )}
        {feeErr && (
          <div className="fs12 text-warning mb-2">{t('Fee estimate unavailable')}: {feeErr}</div>
        )}
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Balance after send')}:</span>{' '}
          {formatFullPrecision(
            Math.max(0, wallet.balance.available - valueAtoms - (token ? 0 : txFee)),
            ui
          )}
        </div>

        <div className="mb-3">
          <label className="form-label fs14">{t('App Password')}</label>
          <input
            type="password"
            className="form-control form-control-sm"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
            autoFocus
          />
        </div>

        {error && <div className="text-danger fs14 mb-2">{error}</div>}

        <div className="d-flex gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSend}
            disabled={loading}
          >
            {loading
              ? '...'
              : t('Send')}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setStep('input'); setError(''); setPassword('') }}
          >
            {t('Back')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="fs18 mb-3">{t('Send')} {asset.unitInfo.conventional.unit}</div>

      <div className="mb-3">
        <label className="form-label fs14">{t('Address')}</label>
        <input
          type="text"
          className={`form-control form-control-sm ${addrValid === true
            ? 'border-success'
            : addrValid === false
              ? 'border-danger'
              : ''}`}
          value={addr}
          onChange={e => { setAddr(e.target.value); validateAddr(e.target.value) }}
          placeholder={t('Recipient address')}
        />
      </div>

      <div className="mb-2">
        <label className="form-label fs14">{t('Amount')}</label>
        <input
          type="number"
          className="form-control form-control-sm"
          value={amtStr}
          onChange={e => setAmtStr(e.target.value)}
          placeholder="0.00"
          step="any"
          min="0"
        />
        {rate > 0 && amtStr && (
          <div className="fs12 text-secondary mt-1">
            ~${formatFourSigFigs(parseFloat(amtStr || '0') * rate, 2)}
          </div>
        )}
      </div>

      <div className="mb-2 fs12">
        <span
          className="text-primary cursor-pointer"
          onClick={() => {
            const avail = wallet.balance.available / conv
            setAmtStr(String(avail))
          }}
        >
          {t('Max')}: {formatCoinValue(wallet.balance.available, ui)}
        </span>
      </div>

      <label className="d-block fs12 mb-3">
        <input
          type="checkbox"
          className="me-1"
          checked={subtract}
          onChange={e => setSubtract(e.target.checked)}
        />
        {t('Subtract fee from amount')}
      </label>

      {error && <div className="text-danger fs14 mb-2">{error}</div>}

      <button
        className="btn btn-primary btn-sm"
        onClick={handleStepSend}
        disabled={loading}
      >
        {loading
          ? '...'
          : t('Continue')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TxHistoryView
// ---------------------------------------------------------------------------

function TxHistoryView ({ assetID, assets, net }: {
  assetID: number
  assets: Record<number, SupportedAsset>
  net: number
}) {
  const { t } = useTranslation()
  const asset = assets[assetID]
  const ui = asset?.unitInfo
  const [pages, setPages] = useState<TxHistoryResult[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [detailTx, setDetailTx] = useState<WalletTransaction | null>(null)

  const fetchPage = useCallback(async (refID?: string) => {
    setLoading(true)
    const res = await postJSON('/api/txhistory', {
      assetID,
      n: TX_HISTORY_PAGE_SIZE,
      refID,
      past: true
    })
    setLoading(false)
    if (!checkResponse(res)) return null
    return res as TxHistoryResult
  }, [assetID])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const first = await fetchPage()
      if (cancelled || !first) return
      setPages([first])
      setCurrentPage(0)
    }
    load()
    return () => { cancelled = true }
  }, [fetchPage])

  const goNext = useCallback(async () => {
    const nextIdx = currentPage + 1
    if (pages[nextIdx]) {
      setCurrentPage(nextIdx)
      return
    }
    const lastPage = pages[pages.length - 1]
    if (!lastPage?.txs?.length) return
    const refID = lastPage.txs[lastPage.txs.length - 1].id
    const nextPage = await fetchPage(refID)
    if (!nextPage) return
    setPages(prev => [...prev, nextPage])
    setCurrentPage(nextIdx)
  }, [currentPage, fetchPage, pages])

  const goPrev = useCallback(() => {
    if (currentPage > 0) setCurrentPage(currentPage - 1)
  }, [currentPage])

  const txPage = pages[currentPage]
  const txs = txPage?.txs ?? []

  if (!ui) return null

  if (detailTx) {
    const url = explorerURL(assetID, detailTx.id, net)
    return (
      <div>
        <div className="d-flex align-items-center mb-3">
          <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => setDetailTx(null)}>
            {t('Back')}
          </button>
          <span className="fs18">{t('Transaction Details')}</span>
        </div>

        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Type')}:</span> {TX_TYPE_LABELS[detailTx.type] ?? 'Unknown'}
        </div>
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('ID')}:</span>{' '}
          <code className="text-break fs12">{detailTx.id}</code>
        </div>
        {!noAmtTxTypes.includes(detailTx.type) && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Amount')}:</span>{' '}
            {formatFullPrecision(detailTx.amount, ui)}
          </div>
        )}
        {detailTx.fees > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Fees')}:</span>{' '}
            {formatFullPrecision(detailTx.fees, ui)}
          </div>
        )}
        {detailTx.recipient && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Recipient')}:</span>{' '}
            <code className="text-break fs12">{detailTx.recipient}</code>
          </div>
        )}
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('Time')}:</span>{' '}
          {detailTx.timestamp > 0
            ? new Date(detailTx.timestamp * 1000).toLocaleString()
            : t('Pending')}
        </div>
        {detailTx.blockNumber > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Block')}:</span>{' '}
            {detailTx.blockNumber}
          </div>
        )}
        {detailTx.confirms && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Confirmations')}:</span>{' '}
            {detailTx.confirms.current}/{detailTx.confirms.target}
          </div>
        )}
        {detailTx.bondInfo && (
          <>
            <div className="mb-2 fs14">
              <span className="text-secondary">{t('Bond ID')}:</span>{' '}
              <code className="text-break fs12">{detailTx.bondInfo.bondID}</code>
            </div>
            <div className="mb-2 fs14">
              <span className="text-secondary">{t('Lock Time')}:</span>{' '}
              {new Date(detailTx.bondInfo.lockTime * 1000).toLocaleString()}
            </div>
          </>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-outline-primary mt-2">
            {t('View in Explorer')}
          </a>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="fs18 mb-3">{t('Transaction History')}</div>

      {loading && txs.length === 0 && (
        <div className="text-center py-3">
          <span className="spinner-border spinner-border-sm" />
        </div>
      )}

      {!loading && txs.length === 0 && (
        <div className="text-center py-3 text-secondary fs14">{t('No transactions')}</div>
      )}

      {txs.length > 0 && (
        <table className="table table-sm table-hover fs12 mb-2">
          <thead>
            <tr>
              <th>{t('Type')}</th>
              <th>{t('Amount')}</th>
              <th>{t('Fees')}</th>
              <th>{t('Age')}</th>
              <th>{t('Confs')}</th>
            </tr>
          </thead>
          <tbody>
            {txs.map(tx => {
              const [sign, cls] = txSignAndClass(tx.type)
              return (
                <tr
                  key={tx.id}
                  className="cursor-pointer"
                  onClick={() => setDetailTx(tx)}
                >
                  <td>{TX_TYPE_LABELS[tx.type] ?? 'Unknown'}</td>
                  <td className={cls}>
                    {noAmtTxTypes.includes(tx.type)
                      ? '-'
                      : `${sign}${formatCoinValue(tx.amount, ui)}`}
                  </td>
                  <td>{tx.fees > 0
                    ? formatCoinValue(tx.fees, ui)
                    : '-'}</td>
                  <td>{tx.timestamp > 0
                    ? ageSince(tx.timestamp * 1000)
                    : t('Pending')}</td>
                  <td>{tx.confirms
                    ? `${tx.confirms.current}/${tx.confirms.target}`
                    : tx.confirmed
                      ? '\u2713'
                      : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {(currentPage > 0 || txPage?.moreAvailable) && (
        <div className="d-flex align-items-center gap-2 fs12">
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={currentPage === 0}
            onClick={goPrev}
          >
            {t('Prev')}
          </button>
          <span>{t('Page')} {currentPage + 1}</span>
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={!txPage?.moreAvailable}
            onClick={goNext}
          >
            {t('Next')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RecentOrdersView
// ---------------------------------------------------------------------------

function RecentOrdersView ({ assetID, assets }: {
  assetID: number
  assets: Record<number, SupportedAsset>
}) {
  const { t } = useTranslation()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const res = await postJSON('/api/orders', {
        assets: [assetID],
        n: 10
      })
      if (cancelled) return
      setLoading(false)
      if (!checkResponse(res)) return
      setOrders(res.orders ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [assetID])

  const asset = assets[assetID]
  if (!asset) return null

  return (
    <div>
      <div className="fs18 mb-3">{t('Recent Orders')}</div>

      {loading && (
        <div className="text-center py-3">
          <span className="spinner-border spinner-border-sm" />
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center py-3 text-secondary fs14">{t('No orders')}</div>
      )}

      {orders.length > 0 && (
        <table className="table table-sm table-hover fs12">
          <thead>
            <tr>
              <th>{t('Market')}</th>
              <th>{t('Type')}</th>
              <th>{t('Side')}</th>
              <th>{t('Qty')}</th>
              <th>{t('Filled')}</th>
              <th>{t('Status')}</th>
              <th>{t('Age')}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(ord => {
              const baseAsset = assets[ord.baseID]
              const quoteAsset = assets[ord.quoteID]
              const baseSymbol = baseAsset?.unitInfo?.conventional?.unit ?? ord.baseSymbol
              const quoteSymbol = quoteAsset?.unitInfo?.conventional?.unit ?? ord.quoteSymbol
              const filledPct = ord.qty > 0
                ? (filled(ord) / ord.qty * 100).toFixed(1)
                : '0.0'
              const statusStr = ord.status === 1
                ? 'Epoch'
                : ord.status === 2
                  ? 'Booked'
                  : ord.status === 3
                    ? 'Executed'
                    : ord.status === 4
                      ? 'Canceled'
                      : ord.status === 5
                        ? 'Revoked'
                        : 'Unknown'
              return (
                <tr key={ord.id || ord.stamp}>
                  <td>{baseSymbol}-{quoteSymbol}</td>
                  <td>{ord.type === 1
                    ? 'Limit'
                    : 'Market'}</td>
                  <td>{ord.sell
                    ? t('Sell')
                    : t('Buy')}</td>
                  <td>{baseAsset
                    ? formatCoinValue(ord.qty, baseAsset.unitInfo)
                    : String(ord.qty)}</td>
                  <td>{filledPct}%</td>
                  <td>{statusStr}</td>
                  <td>{ageSince(ord.submitTime)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WalletConfigView
// ---------------------------------------------------------------------------

function WalletConfigView ({ asset, wallet, onClose }: {
  asset: SupportedAsset
  wallet: WalletState
  onClose: () => void
}) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const [config, setConfig] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isRescanner = (wallet.traits & traitRescanner) !== 0

  // Load wallet settings
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const res = await postJSON('/api/walletsettings', { assetID: asset.id })
      if (cancelled) return
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to load settings')
        return
      }
      setConfig(res.map ?? {})
    }
    load()
    return () => { cancelled = true }
  }, [asset.id])

  const handleLockUnlock = useCallback(async () => {
    setError('')
    setSuccess('')
    setLoading(true)
    if (wallet.open) {
      const res = await postJSON('/api/closewallet', { assetID: asset.id })
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to lock wallet')
        return
      }
      await fetchUser()
      setSuccess(t('Wallet locked.'))
    } else {
      const res = await postJSON('/api/openwallet', { assetID: asset.id })
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to unlock wallet')
        return
      }
      await fetchUser()
      setSuccess(t('Wallet unlocked.'))
    }
  }, [asset.id, fetchUser, t, wallet.open])

  const handleRescan = useCallback(async () => {
    setError('')
    setSuccess('')
    const res = await postJSON('/api/rescanwallet', { assetID: asset.id })
    if (!checkResponse(res)) {
      setError(res.msg || 'Rescan failed')
      return
    }
    setSuccess(t('Rescan started.'))
  }, [asset.id, t])

  const handleSave = useCallback(async () => {
    setError('')
    setSuccess('')
    setSaving(true)
    const res = await postJSON('/api/reconfigurewallet', {
      assetID: asset.id,
      config,
      walletType: wallet.type
    })
    setSaving(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Save failed')
      return
    }
    await fetchUser()
    setSuccess(t('Settings saved.'))
  }, [asset.id, config, fetchUser, t, wallet.type])

  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-3">
        <img src={logoPath(asset.symbol)} alt={asset.symbol} width={24} height={24} />
        <span className="fs18">{asset.name} {t('Settings')}</span>
      </div>

      {loading && (
        <div className="text-center py-3">
          <span className="spinner-border spinner-border-sm" />
        </div>
      )}

      {!loading && (
        <>
          <div className="mb-3 fs14">
            <span className="text-secondary">{t('Wallet Type')}:</span> {wallet.type || 'Default'}
          </div>

          {/* Config key-value pairs */}
          {Object.entries(config).map(([key, val]) => (
            <div key={key} className="mb-2">
              <label className="form-label fs12 text-secondary mb-0">{key}</label>
              <input
                type="text"
                className="form-control form-control-sm"
                value={val}
                onChange={e => setConfig(prev => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}

          {error && <div className="text-danger fs14 mb-2">{error}</div>}
          {success && <div className="text-success fs14 mb-2">{success}</div>}

          <div className="d-flex flex-wrap gap-2 mt-3">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? '...'
                : t('Save')}
            </button>
            <button
              className="btn btn-outline-secondary btn-sm"
              onClick={handleLockUnlock}
              disabled={loading}
            >
              {wallet.open
                ? t('Lock')
                : t('Unlock')}
            </button>
            {isRescanner && (
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={handleRescan}
              >
                {t('Rescan')}
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm ms-auto"
              onClick={onClose}
            >
              {t('Close')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StakingView (DCR only)
// ---------------------------------------------------------------------------

function StakingView ({ assetID, assets }: {
  assetID: number
  assets: Record<number, SupportedAsset>
}) {
  const { t } = useTranslation()
  const asset = assets[assetID]
  const ui = asset?.unitInfo
  const wallet = asset?.wallet
  const conv = ui?.conventional?.conversionFactor ?? 1e8

  const [stakeStatus, setStakeStatus] = useState<TicketStakingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // VSP picker
  const [vsps, setVsps] = useState<VotingServiceProvider[]>([])
  const [showVspPicker, setShowVspPicker] = useState(false)
  const [vspLoading, setVspLoading] = useState(false)

  // Purchase
  const [purchaseN, setPurchaseN] = useState('1')
  const [purchasing, setPurchasing] = useState(false)
  const [purchaseError, setPurchaseError] = useState('')
  const [purchaseSuccess, setPurchaseSuccess] = useState('')

  // Load stake status
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const res = await postJSON('/api/stakestatus', assetID)
      if (cancelled) return
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to load staking status')
        return
      }
      setStakeStatus(res.status as TicketStakingStatus)
    }
    load()
    return () => { cancelled = true }
  }, [assetID])

  const loadVSPs = useCallback(async () => {
    setVspLoading(true)
    const res = await postJSON('/api/listvsps', assetID)
    setVspLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to load VSPs')
      return
    }
    setVsps(res.vsps ?? [])
    setShowVspPicker(true)
  }, [assetID])

  const selectVSP = useCallback(async (vsp: VotingServiceProvider) => {
    const res = await postJSON('/api/setvsp', { assetID, url: vsp.url })
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to set VSP')
      return
    }
    setStakeStatus(prev => prev
      ? { ...prev, vsp: vsp.url }
      : prev)
    setShowVspPicker(false)
  }, [assetID])

  const purchaseTickets = useCallback(async () => {
    setPurchaseError('')
    setPurchaseSuccess('')
    const n = parseInt(purchaseN)
    if (n < 1) return
    setPurchasing(true)
    const res = await postJSON('/api/purchasetickets', { assetID, n })
    setPurchasing(false)
    if (!checkResponse(res)) {
      setPurchaseError(res.msg || 'Purchase failed')
      return
    }
    setPurchaseSuccess(t('Purchased {{n}} ticket(s)', { n }))
  }, [assetID, purchaseN, t])

  if (!ui || !wallet) return null

  if (loading) {
    return (
      <div className="text-center py-3">
        <span className="spinner-border spinner-border-sm" />
      </div>
    )
  }

  if (error && !stakeStatus) {
    return <div className="text-danger fs14">{error}</div>
  }

  if (!stakeStatus) return null

  const stats = stakeStatus.stats

  if (showVspPicker) {
    return (
      <div>
        <div className="d-flex align-items-center mb-3">
          <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => setShowVspPicker(false)}>
            {t('Back')}
          </button>
          <span className="fs18">{t('Select VSP')}</span>
        </div>

        {vspLoading && (
          <div className="text-center py-3">
            <span className="spinner-border spinner-border-sm" />
          </div>
        )}

        {vsps.length > 0 && (
          <table className="table table-sm table-hover fs12">
            <thead>
              <tr>
                <th>{t('VSP')}</th>
                <th>{t('Fee')}</th>
                <th>{t('Voting')}</th>
              </tr>
            </thead>
            <tbody>
              {vsps.map(vsp => (
                <tr
                  key={vsp.url}
                  className="cursor-pointer"
                  onClick={() => selectVSP(vsp)}
                >
                  <td>{vsp.url}</td>
                  <td>{vsp.feePercentage.toFixed(2)}%</td>
                  <td>{vsp.voting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="fs18 mb-3">{t('Staking')}</div>

      {/* Ticket Price */}
      <div className="border rounded p-3 mb-3">
        <div className="row">
          <div className="col">
            <div className="fs12 text-secondary">{t('Ticket Price')}</div>
            <div className="fs16 fw-bold">
              {formatFourSigFigs(stakeStatus.ticketPrice / conv)} DCR
            </div>
          </div>
          <div className="col">
            <div className="fs12 text-secondary">{t('Vote Reward')}</div>
            <div className="fs14">
              {formatFourSigFigs(stakeStatus.votingSubsidy / conv)} DCR
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="border rounded p-3 mb-3">
        <div className="fs14 fw-bold mb-2">{t('Ticket Stats')}</div>
        <div className="row fs12">
          <div className="col-6 mb-1">
            <span className="text-secondary">{t('Total Tickets')}:</span> {stats.ticketCount}
          </div>
          <div className="col-6 mb-1">
            <span className="text-secondary">{t('Votes')}:</span> {stats.votes}
          </div>
          <div className="col-6 mb-1">
            <span className="text-secondary">{t('Revokes')}:</span> {stats.revokes}
          </div>
          <div className="col-6 mb-1">
            <span className="text-secondary">{t('Mempool')}:</span> {stats.mempool}
          </div>
          {stats.queued > 0 && (
            <div className="col-6 mb-1">
              <span className="text-secondary">{t('Queued')}:</span> {stats.queued}
            </div>
          )}
          <div className="col-6 mb-1">
            <span className="text-secondary">{t('Total Rewards')}:</span>{' '}
            {formatFourSigFigs(stats.totalRewards / conv)} DCR
          </div>
        </div>
      </div>

      {/* VSP */}
      <div className="border rounded p-3 mb-3">
        <div className="d-flex align-items-center gap-2 mb-2">
          <span className="fs14 fw-bold">{t('VSP')}</span>
          <button className="btn btn-sm btn-outline-secondary ms-auto" onClick={loadVSPs}>
            {stakeStatus.vsp
              ? t('Change')
              : t('Select VSP')}
          </button>
        </div>
        {stakeStatus.vsp && (
          <div className="fs12">{stakeStatus.vsp}</div>
        )}
        {!stakeStatus.vsp && !stakeStatus.isRPC && (
          <div className="fs12 text-warning">{t('Please select a VSP to purchase tickets.')}</div>
        )}
      </div>

      {/* Purchase Tickets */}
      {(stakeStatus.vsp || stakeStatus.isRPC) && (
        <div className="border rounded p-3 mb-3">
          <div className="fs14 fw-bold mb-2">{t('Purchase Tickets')}</div>
          <div className="fs12 text-secondary mb-2">
            {t('Available')}: {formatCoinValue(wallet.balance.available, ui)} DCR
          </div>
          <div className="d-flex align-items-center gap-2">
            <input
              type="number"
              className="form-control form-control-sm"
              style={{ width: 80 }}
              value={purchaseN}
              onChange={e => {
                const v = parseInt(e.target.value)
                setPurchaseN(v >= 1
                  ? String(v)
                  : '1')
              }}
              min="1"
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={purchaseTickets}
              disabled={purchasing}
            >
              {purchasing
                ? '...'
                : t('Purchase')}
            </button>
          </div>
          {purchaseError && <div className="text-danger fs12 mt-2">{purchaseError}</div>}
          {purchaseSuccess && <div className="text-success fs12 mt-2">{purchaseSuccess}</div>}
        </div>
      )}

      {error && <div className="text-danger fs12 mt-2">{error}</div>}
    </div>
  )
}
