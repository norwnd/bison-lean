import {
  useState, useEffect, useCallback, useMemo
} from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../services/api'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { DepositAddress } from '../components/common/DepositAddress'
import { CopyButton } from '../components/common/CopyButton'
import {
  formatCoinValue, formatFullPrecision, formatFiatConversion,
  formatFourSigFigs
} from '../hooks/useFormatters'
import { explorerURL } from '../components/CoinExplorers'
import { filled } from '../components/AccountUtils'
import { ROUTES } from '../router/routes'
import type {
  SupportedAsset, WalletState,
  BalanceNote, WalletStateNote,
  RateNote,
  WalletTransaction, TxHistoryResult, Order, UnitInfo,
  CoreNote, TicketStakingStatus, VotingServiceProvider,
  Exchange, Spot
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

// WP-10: tx-type i18n keys. Mirrors vanilla `wallets.ts` L154-176
// `txTypeTranslationKeys` array indexed by tx type, then resolved
// via `intl.prep(txTypeTranslationKeys[txType])`. The previous
// hardcoded English `TX_TYPE_LABELS` would never translate.
const TX_TYPE_KEYS: Record<number, string> = {
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

function txTypeLabel (t: (k: string) => string, txType: number): string {
  const key = TX_TYPE_KEYS[txType] ?? 'TX_TYPE_UNKNOWN'
  return t(key)
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

/** Collect markets from all exchanges where the selected asset is base or quote. */
interface MarketRow {
  host: string
  name: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
  spot: Spot | undefined
}

function collectMarketsForAsset (
  exchanges: Record<string, Exchange>,
  assetID: number
): MarketRow[] {
  const rows: MarketRow[] = []
  for (const xc of Object.values(exchanges)) {
    if (!xc.markets) continue
    for (const mkt of Object.values(xc.markets)) {
      if (mkt.baseid !== assetID && mkt.quoteid !== assetID) continue
      rows.push({
        host: xc.host,
        name: mkt.name,
        baseID: mkt.baseid,
        quoteID: mkt.quoteid,
        baseSymbol: mkt.basesymbol,
        quoteSymbol: mkt.quotesymbol,
        spot: mkt.spot
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function WalletsPage () {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)
  const exchanges = useAuthStore(s => s.exchanges)
  const user = useAuthStore(s => s.user)
  const fetchUser = useAuthStore(s => s.fetchUser)

  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(null)
  const [activeForm, setActiveForm] = useState<string | null>(null)

  // Force re-render on note arrival so balances refresh.
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick(n => n + 1), [])

  // -----------------------------------------------------------------------
  // WS subscriptions
  // -----------------------------------------------------------------------

  // WP-01: vanilla `wallets.ts` L464-465 routes both `walletstate` AND
  // `walletconfig` to `handleWalletStateNote`. The two notifications
  // carry the same `WalletStateNote` shape; `walletconfig` fires when
  // a wallet's config (e.g. node URL, password) is updated, while
  // `walletstate` fires for runtime state changes (sync, peers,
  // balance metadata). Both should refresh the same local state.
  const handleWalletStateNote = useCallback((note: CoreNote) => {
    const n = note as WalletStateNote
    const store = useAuthStore.getState()
    const assetID = n.wallet.assetID
    const asset = store.assets[assetID]
    if (!asset) return
    asset.wallet = n.wallet
    store.walletMap[assetID] = n.wallet
    bump()
  }, [bump])

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
    walletstate: handleWalletStateNote,
    // WP-01: same handler as `walletstate`. Mirrors vanilla
    // `wallets.ts` L464-465.
    walletconfig: handleWalletStateNote,
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
    },
    // WP-02: minimal `walletnote` (custom wallet note) handler.
    // Vanilla `wallets.ts` `handleCustomWalletNote()` (L2767) switches
    // on `payload.route` to dispatch:
    //   - `tipChange`         → updates per-asset sync height + DCR ticket stats
    //   - `ticketPurchaseUpdate` → processes Decred staking ticket updates
    //   - `transaction`       → forwards to tx-history + bridging popup
    // The DCR staking surfaces (B-L15) and the bridging popup (B-L16)
    // haven't been ported yet, so the React handler here is a stub
    // that just bumps the render tick for the `tipChange` /
    // `transaction` routes (which the existing tx-history table can
    // pick up reactively). Unknown routes are logged so they show
    // up in dev tools without crashing.
    walletnote: (note: CoreNote) => {
      const n = note as { payload?: { route?: string } }
      const route = n.payload?.route
      switch (route) {
        case 'tipChange':
        case 'transaction':
          bump()
          break
        case 'ticketPurchaseUpdate':
          // Decred ticket UI is a B-L15 item; bumping the render
          // tick is harmless until the consumer exists.
          bump()
          break
        default:
          if (route) console.debug('walletnote: unhandled route', route)
      }
    },
    // WP-03: minimal `bridge` notification handler. Vanilla
    // `handleBridgeNote()` (L2752) forwards updates to the bridging
    // popup, which doesn't exist in React yet (B-L16). Subscribe to
    // the channel so the note isn't silently dropped, and bump for
    // any future consumer.
    bridge: (_note: CoreNote) => {
      bump()
    },
  }), [bump, fetchUser, handleWalletStateNote])

  useNotifications(noteReceivers)

  // -----------------------------------------------------------------------
  // Sidebar
  // -----------------------------------------------------------------------

  const tickerGroups = useMemo(
    () => buildTickerGroups(assets, fiatRatesMap),
    [assets, fiatRatesMap]
  )

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
    <div className="d-flex fill-abs">
      {/* ---- Left Sidebar: Asset List ---- */}
      <section className="w-auto d-flex flex-column align-items-stretch overflow-y-auto hidden-overflow">
        {/* Holdings header */}
        <div className="flex-stretch-column pt-2 px-2 hoverbg pointer" onClick={() => setSelectedAssetID(null)}>
          <span className="grey fs16 lh1 mb-1">{t('Holdings')}</span>
          <span className="d-flex align-items-end lh1">
            <span className="fs20">${formatFourSigFigs(totalFiatBalance(assets, fiatRatesMap))}</span>
            <span className="fs18 grey ms-1">USD</span>
          </span>
          <div className="border-bottom mt-2"></div>
        </div>
        {/* Ticker balance rows */}
        <div className="flex-stretch-column border-bottom">
          {tickerGroups.map(g => {
            const selected = g.assetIDs.includes(selectedAssetID ?? -1)
            return (
              <div
                key={g.ticker}
                className={`flex-stretch-column pt-2 px-2 hoverbg pointer ${selected ? 'selected' : ''}`}
                onClick={() => setSelectedAssetID(g.primaryAssetID)}
                style={selected ? { backgroundColor: 'var(--body-bg)' } : undefined}
              >
                <div className="d-flex justify-content-between align-items-start">
                  <div className="flex-center me-4 lh1">
                    <img src={logoPath(g.symbol)} alt={g.ticker} className="mini-icon me-1" />
                    <span className="ms-1 fs22">{g.ticker}</span>
                  </div>
                  <div className="d-flex flex-column align-items-end">
                    {g.hasWallet
                      ? <>
                          <span className="fs22 lh1">{formatFourSigFigs(g.totalFiat, 2)}</span>
                          <div className="d-flex align-items-end fs15 grey lh1 pt-1">
                            <span className="me-1">${formatFourSigFigs(g.totalFiat, 2)}</span>
                            <span className="ms-1 fs12 grey">USD</span>
                          </div>
                        </>
                      : <span className="grey me-1">—</span>}
                  </div>
                </div>
                <div className="border-bottom mt-2"></div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ---- Two-Column Main Area ---- */}
      <div className="flex-grow-1 position-relative">
        <div className="fill-abs d-flex flex-wrap align-items-stretch stylish-overflow">
          {!selectedAsset && (
            <div className="text-center grey py-5 p-3 col-24">
              {t('Select an asset from the sidebar.')}
            </div>
          )}
          {selectedAsset && (
            <>
              {/* ---- Center Column: Wallet Detail ---- */}
              <div className="position-relative col-24 col-xl-12 col-xxl-9 flex-stretch-column">
                <div className="flex-stretch-column">
                  {selectedWallet && (
                    <WalletDetail
                      asset={selectedAsset}
                      wallet={selectedWallet}
                      assets={assets}
                      fiatRatesMap={fiatRatesMap}
                      setActiveForm={setActiveForm}
                    />
                  )}
                  {!selectedWallet && (
                    <NoWalletView
                      asset={selectedAsset}
                      onCreated={() => fetchUser()}
                    />
                  )}
                </div>
              </div>

              {/* ---- Right Column: Pending Tx, Markets, Recent Orders ---- */}
              <div className="position-relative col-24 col-xl-12 col-xxl-15 flex-stretch-column">
                <div className="flex-stretch-column">
                  {selectedWallet && (
                    <RightColumn
                      asset={selectedAsset}
                      wallet={selectedWallet}
                      assets={assets}
                      exchanges={exchanges}
                      net={net}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
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
// WalletDetail (Center Column)
// ---------------------------------------------------------------------------

interface WalletDetailProps {
  asset: SupportedAsset
  wallet: WalletState
  assets: Record<number, SupportedAsset>
  fiatRatesMap: Record<number, number>
  setActiveForm: (f: string | null) => void
}

function WalletDetail ({
  asset, wallet, assets, fiatRatesMap,
  setActiveForm
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

  const totalBal = bal.available + bal.locked + bal.immature

  return (
    <div>
      {/* ---- Header: Logo + asset name + total balance ---- */}
      <section>
        <div className="d-flex justify-content-between align-items-start p-3">
          <div className="flex-center">
            <img src={logoPath(asset.symbol)} alt={asset.symbol} className="large-icon" />
            <div className="fs24 ms-2 demi lh1">{asset.name}</div>
          </div>
          <div className="d-flex flex-column justify-content-end">
            <div className="d-flex align-items-end lh1">
              <span className="fs28 me-1">{formatCoinValue(totalBal, ui)}</span>
              <span className="fs20 grey">{ui.conventional.unit}</span>
            </div>
            {rate > 0 && (
              <div className="mt-1 lh1 grey fs15 d-flex justify-content-end align-items-center">
                ~ <span className="me-1">{formatFiatConversion(totalBal, rate, ui)}</span> USD
              </div>
            )}
          </div>
        </div>

        {/* ---- Balance breakdown table ---- */}
        <div className="border-top px-2">
          <table className="compact row-border no-bottom-border">
            <thead className="unbold fs15">
              <tr>
                <th>{t('Available')}</th>
                <th>{t('Locked')}</th>
                <th>{t('Immature')}</th>
                <th>{t('Status')}</th>
                <th>{t('Sync')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{formatCoinValue(bal.available, ui)}</td>
                <td>{formatCoinValue(bal.locked, ui)}</td>
                <td>{formatCoinValue(bal.immature, ui)}</td>
                <td className="text-center">
                  {wallet.open
                    ? <span className="ico-unlocked fs14" title={t('Ready')}></span>
                    : <span className="ico-locked fs14" title={t('Locked')}></span>}
                </td>
                <td className="text-nowrap fs14">
                  {wallet.synced
                    ? '100%'
                    : `${(wallet.syncProgress * 100).toFixed(1)}%`}
                </td>
                <td>
                  <span
                    className="ico-settings fs16 pointer hoverbg p-1"
                    onClick={() => setActiveForm('config')}
                  ></span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Bond/order locked breakdown */}
        {(bal.orderlocked > 0 || bal.bondlocked > 0 || bal.contractlocked > 0) && (
          <div className="d-flex flex-wrap gap-3 px-2 py-1 fs14 grey">
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

        {bal.reservesDeficit > 0 && (
          <div className="px-2 py-1 fs14 text-warning">
            {t('Reserves Deficit')}: {formatCoinValue(bal.reservesDeficit, ui)}
          </div>
        )}

        {/* Parent asset balance for tokens */}
        {parentAsset && parentAsset.wallet && (
          <div className="px-2 py-1 border-top">
            <div className="d-flex align-items-center gap-2 fs14 grey pt-1">
              <img src={logoPath(parentAsset.symbol)} alt={parentAsset.symbol} className="micro-icon" />
              <span>
                {parentAsset.unitInfo.conventional.unit}{' '}
                {t('fee balance')}: {formatCoinValue(parentAsset.wallet.balance.available, parentAsset.unitInfo)}
              </span>
            </div>
          </div>
        )}

        {/* Other/custom balances */}
        {bal.other && Object.keys(bal.other).length > 0 && (
          <div className="px-2 py-1 border-top">
            {Object.entries(bal.other).map(([label, cb]) => (
              <div key={label} className="fs14 grey pt-1">
                {label}: {formatCoinValue(cb.amt, ui)}
                {cb.locked
                  ? ` (${t('locked')})`
                  : ''}
              </div>
            ))}
          </div>
        )}

        {/* ---- Receive / Send buttons ---- */}
        <div className="d-flex align-items-stretch border-top">
          <div
            className="flex-grow-1 flex-center p-2 pointer hoverbg border-end"
            onClick={() => setActiveForm('receive')}
          >
            <span className="ico-qrcode fs15 me-1"></span>
            <span className="fs20">{t('Receive')}</span>
          </div>
          <button
            className="flex-grow-1 flex-center p-2 noborder"
            onClick={() => setActiveForm('send')}
            disabled={!wallet.open}
          >
            <span className="ico-send me-1"></span>
            <span className="fs20">{t('Send')}</span>
          </button>
        </div>
      </section>

      {/* ---- Exchange Rate ---- */}
      {rate > 0 && (
        <section className="flex-stretch-column">
          <div className="flex-center py-2 fs15 demi">{t('Exchange Rate')}</div>
          <div className="mx-2 border-bottom"></div>
          <div className="flex-grow-1 flex-center py-2">
            <span className="fs16 mb-1 demi">$</span>
            <span className="fs22 me-1 demi lh1">{formatFourSigFigs(rate)}</span>
          </div>
        </section>
      )}

      {/* ---- Transaction Fees ---- */}
      {wallet.feeState && (
        <section className="flex-stretch-column">
          <div className="flex-center py-2 fs18 demi">{t('Transaction Fees')}</div>
          <div className="mx-2 border-bottom"></div>
          <div className="d-flex">
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Send')}</span>
              <span className="flex-center lh1">
                <span className="fs16 mb-1">$</span>
                <span className="fs20">{rate > 0 ? formatFiatConversion(wallet.feeState.send, rate, ui) : '—'}</span>
              </span>
              <div className="fs14 grey">{formatCoinValue(wallet.feeState.send, ui)}</div>
            </div>
            <div className="my-2 border-end"></div>
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Sell')}</span>
              <span className="flex-center lh1">
                <span className="fs16 mb-1">$</span>
                <span className="fs20">{rate > 0 ? formatFiatConversion(wallet.feeState.swap, rate, ui) : '—'}</span>
              </span>
              <div className="fs14 grey">{formatCoinValue(wallet.feeState.swap, ui)}</div>
            </div>
            <div className="my-2 border-end"></div>
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Buy')}</span>
              <span className="flex-center lh1">
                <span className="fs16 mb-1">$</span>
                <span className="fs20">{rate > 0 ? formatFiatConversion(wallet.feeState.redeem, rate, ui) : '—'}</span>
              </span>
              <div className="fs14 grey">{formatCoinValue(wallet.feeState.redeem, ui)}</div>
            </div>
            <div className="my-2 border-end"></div>
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Rate')}</span>
              <div className="flex-center">
                <span className="fs22 me-1">{wallet.feeState.rate}</span>
                <span className="fs13">atoms/B</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ---- Staking (DCR only, inline) ---- */}
      {isTicketBuyer && wallet.running && (
        <StakingView
          assetID={DCR_ASSET_ID}
          assets={assets}
        />
      )}

      {/* ---- Mixing / Privacy (DCR only, inline) ---- */}
      {isMixer && wallet.running && (
        <MixingToggle assetID={asset.id} />
      )}

      {/* ---- Transaction History link ---- */}
      <div className="flex-center p-2 pointer hoverbg border-top" onClick={() => setActiveForm('txHistory')}>
        <span className="ico-textfile me-1"></span>
        <span className="fs18">{t('Transaction History')}</span>
      </div>

      {/* Sync status */}
      {!wallet.synced && wallet.syncStatus && (
        <div className="p-2 fs14 grey border-top">
          {t('Sync progress')}: {(wallet.syncProgress * 100).toFixed(1)}%
          {' '}({wallet.syncStatus.blocks}/{wallet.syncStatus.targetHeight} {t('blocks')})
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RightColumn: Pending Tx, Markets, Recent Trades
// ---------------------------------------------------------------------------

interface RightColumnProps {
  asset: SupportedAsset
  wallet: WalletState
  assets: Record<number, SupportedAsset>
  exchanges: Record<string, Exchange>
  net: number
}

function RightColumn ({
  asset, wallet, assets, exchanges, net
}: RightColumnProps) {
  // Pending transactions
  const pendingTxs = wallet.pendingTxs
    ? Object.values(wallet.pendingTxs)
    : []

  // Markets for this asset
  const marketRows = useMemo(
    () => collectMarketsForAsset(exchanges, asset.id),
    [exchanges, asset.id]
  )

  return (
    <div>
      {/* ---- Pending Transactions ---- */}
      <PendingTransactions
        txs={pendingTxs}
        ui={asset.unitInfo}
        assetID={asset.id}
        net={net}
      />

      {/* ---- Markets ---- */}
      <MarketsSection
        assetName={asset.name}
        marketRows={marketRows}
        assets={assets}
      />

      {/* ---- Recent Activity / Orders ---- */}
      <RecentOrdersView
        assetID={asset.id}
        assets={assets}
      />
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
  const [expanded, setExpanded] = useState(true)

  return (
    <section>
      <div className="flex-center py-3 fs18">
        {txs.length === 0
          ? <span>{t('no pending transactions')}</span>
          : <span>
              <span>{txs.length}</span>{' '}
              <span>{t('pending transactions')}</span>{' '}
              <span
                className="p-1 pointer hoverbg fs11 ico-arrowdown"
                onClick={() => setExpanded(!expanded)}
              ></span>
            </span>}
      </div>
      {expanded && txs.length > 0 && (
        <div className="px-2 pb-3">
          <table className="compact row-border border-top">
            <thead className="unbold fs15">
              <tr>
                <th>{t('Type')}</th>
                <th className="d-none d-sm-table-cell">{t('ID')}</th>
                <th>{t('Age')}</th>
                <th className="text-end">{t('Amount')}</th>
                <th>{t('Confirms')}</th>
              </tr>
            </thead>
            <tbody>
              {txs.map(tx => {
                const [sign, cls] = txSignAndClass(tx.type)
                // WP-10: locale-aware tx type label (was hardcoded English).
                const label = txTypeLabel(t, tx.type)
                const url = explorerURL(assetID, tx.id, net)
                return (
                  <tr key={tx.id}>
                    <td>{label}</td>
                    <td className="d-none d-sm-table-cell">
                      {/* WP-11: copy-to-clipboard button on transaction ID,
                          mirroring vanilla `setupCopyBtn()` next to TX
                          IDs in the wallets page. Uses the shared
                          CopyButton from B-L9. */}
                      <span className="d-inline-flex align-items-center gap-1">
                        {url
                          ? <a href={url} target="_blank" rel="noopener noreferrer" className="subtlelink">{tx.id.slice(0, 16)}...</a>
                          : <span>{tx.id.slice(0, 16)}...</span>}
                        <CopyButton text={tx.id} />
                      </span>
                    </td>
                    <td>{ageSince(tx.timestamp * 1000)}</td>
                    <td className={`text-end ${cls}`}>
                      {noAmtTxTypes.includes(tx.type)
                        ? '-'
                        : `${sign}${formatCoinValue(tx.amount, ui)}`}
                    </td>
                    <td>{tx.confirms
                      ? `${tx.confirms.current}/${tx.confirms.target}`
                      : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// MarketsSection
// ---------------------------------------------------------------------------

function MarketsSection ({ assetName, marketRows, assets }: {
  assetName: string
  marketRows: MarketRow[]
  assets: Record<number, SupportedAsset>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <section>
      <h4 className="m-3">{assetName} {t('Markets')}</h4>
      {marketRows.length === 0 && (
        <div className="flex-center p-2 mb-3 mx-3 fs18 border">{t('No markets')}</div>
      )}
      {marketRows.length > 0 && (
        <div>
          <table className="row-border row-hover border-top">
            <thead>
              <tr>
                <th>{t('Market')}</th>
                <th className="d-none d-md-table-cell d-lg-none d-xxl-table-cell">{t('Host')}</th>
                <th>{t('Price')}</th>
                <th className="text-end">{t('Volume')}</th>
              </tr>
            </thead>
            <tbody>
              {marketRows.map((row, idx) => {
                const baseAsset = assets[row.baseID]
                const quoteAsset = assets[row.quoteID]
                const quoteConv = quoteAsset?.unitInfo?.conventional?.conversionFactor ?? 1e8
                const baseConv = baseAsset?.unitInfo?.conventional?.conversionFactor ?? 1e8
                const spotRate = row.spot
                  ? row.spot.rate / 1e8
                  : 0
                const spotPriceConv = spotRate * (baseConv / quoteConv)
                const vol24 = row.spot
                  ? row.spot.vol24 / baseConv
                  : 0
                // WP-21: row click navigates to the markets page
                // pre-filtered to this market. Mirrors vanilla
                // `wallets.ts` which made the row a clickable link to
                // `/markets?host=...&base=...&quote=...`. The React
                // table row already had `cursor: pointer` styling but
                // no handler -- this wires it up.
                const goToMarket = () => {
                  const params = new URLSearchParams({
                    host: row.host,
                    baseID: String(row.baseID),
                    quoteID: String(row.quoteID),
                  })
                  navigate(`${ROUTES.MARKETS}?${params.toString()}`)
                }
                return (
                  <tr
                    key={`${row.host}-${row.name}-${idx}`}
                    className="pointer"
                    onClick={goToMarket}
                  >
                    <td>
                      <img src={logoPath(row.baseSymbol)} alt={row.baseSymbol} className="micro-icon me-1" />
                      <img src={logoPath(row.quoteSymbol)} alt={row.quoteSymbol} className="micro-icon me-1" />
                      <span className="demi">
                        {row.baseSymbol.toUpperCase()}-{row.quoteSymbol.toUpperCase()}
                      </span>
                    </td>
                    <td className="d-none d-md-table-cell d-lg-none d-xxl-table-cell">
                      <div className="short-host text-nowrap overflow-hidden">{row.host}</div>
                    </td>
                    <td>
                      {spotPriceConv > 0
                        ? <>
                            <span>{formatFourSigFigs(spotPriceConv)}</span>
                            <span className="fs13 grey">
                              <sup>{quoteAsset?.unitInfo?.conventional?.unit}</sup>/<sub>{baseAsset?.unitInfo?.conventional?.unit}</sub>
                            </span>
                          </>
                        : '-'}
                    </td>
                    <td className="text-end">
                      {vol24 > 0
                        ? <>
                            <span>{formatFourSigFigs(vol24)}</span>
                            <span className="fs15 grey ms-1">{baseAsset?.unitInfo?.conventional?.unit}</span>
                          </>
                        : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  // WP-18: mixing info popup state. Mirrors vanilla `wallets.ts`
  // L409 `Doc.bind(page.privacyInfoBttn, 'click', () => { this.forms.show(page.mixingInfo) })`.
  const [showInfo, setShowInfo] = useState(false)

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
      <section className="position-relative d-flex align-items-stretch flex-column border">
        <div className="w-100 d-flex align-items-stretch">
          <div className="flex-center flex-grow-1 p-2">
            <span className="ico-spinner spinner me-2"></span>
            <span>{t('loading privacy status')}</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="position-relative d-flex align-items-stretch flex-column border">
      <div className="w-100 d-flex align-items-stretch">
        <div className="p-2 flex-center fs35 ico-secretagent border-end"></div>
        <div className="flex-center flex-grow-1">
          {enabled
            ? <div className="flex-center fs20">
                <span className="on-indicator on me-2" style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: 'var(--indicator-good)', display: 'inline-block' }}></span>
                <span>{t('Privacy active')}</span>
              </div>
            : <div className="flex-center fs20">
                <span className="on-indicator off me-2" style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: 'var(--text-grey)', display: 'inline-block' }}></span>
                <span>{t('Privacy off')}</span>
              </div>}
        </div>
        {/* WP-18: privacy info button. Click opens a modal explaining
            CoinShuffle++ / StakeShuffle. Mirrors vanilla
            `privacyInfoBttn` (`wallets.tmpl` L392). */}
        <button
          type="button"
          className="btn flex-center p-3 border-0 border-start rounded-0 fs24 ico-info hoverbg"
          onClick={() => setShowInfo(true)}
          aria-label={t('Privacy info')}
          title={t('Privacy info')}
        />
        <div className="p-2 border-start flex-center">
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              checked={enabled ?? false}
              onChange={toggle}
              disabled={loading}
            />
          </div>
        </div>
      </div>
      {error && <div className="flex-center p-2 text-danger border-top">{error}</div>}

      {/* WP-18: privacy info modal. Renders the 5 vanilla bullet
          points from `wallets.tmpl` L1219-1238 using the existing
          i18n keys (privacy_intro / cspp_how / decred_privacy /
          privacy_optional / privacy_unlocked). */}
      <FormOverlay show={showInfo} onClose={() => setShowInfo(false)}>
        <div className="bg-body border rounded p-4" style={{ maxWidth: 425 }}>
          <ul className="ps-3 mb-0">
            <li className="mb-2">{t('privacy_intro')}</li>
            <li className="mb-2">{t('cspp_how')}</li>
            <li className="mb-2">{t('decred_privacy')}</li>
            <li className="mb-2">{t('privacy_optional')}</li>
            <li>{t('privacy_unlocked')}</li>
          </ul>
        </div>
      </FormOverlay>
    </section>
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
          <span className="text-secondary">{t('Type')}:</span> {txTypeLabel(t, detailTx.type)}
        </div>
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('ID')}:</span>{' '}
          <code className="text-break fs12">{detailTx.id}</code>
          {/* WP-11: also offer copy on the detail view's full id. */}
          <CopyButton text={detailTx.id} />
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
                  <td>{txTypeLabel(t, tx.type)}</td>
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
// RecentOrdersView (inline in right column)
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
    <section className="d-flex flex-column pb-3 border-bottom">
      <div className="d-flex align-items-center justify-content-between m-3">
        <h4 className="mb-0">{t('Recent')} {asset.name} {t('Activity')}</h4>
        {/* WP-21: "View All" link to the orders page pre-filtered to
            this asset. The OrdersPage `assets` URL param is consumed
            by its initial filter state. Uses `<Link>` (rather than a
            button + navigate) so it routes via react-router with
            proper link semantics, supports cmd-click / middle-click
            for new-tab, and reads as a link to assistive tech. */}
        <Link
          to={`${ROUTES.ORDERS}?assets=${assetID}`}
          className="fs14"
        >
          {t('View All')}
        </Link>
      </div>

      {loading && (
        <div className="text-center py-3">
          <span className="ico-spinner spinner me-2"></span>
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="flex-center p-2 mb-3 mx-3 fs18 border">{t('No Recent Activity')}</div>
      )}

      {orders.length > 0 && (
        <table className="row-border border-top">
          <thead>
            <tr>
              <th>{t('Trade')}</th>
              <th>{t('Status')}</th>
              <th className="d-none d-md-table-cell">{t('Filled')}</th>
              <th>{t('Age')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map(ord => {
              const baseAsset = assets[ord.baseID]
              const baseUI = baseAsset?.unitInfo
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
              const qtyStr = baseUI
                ? formatCoinValue(ord.qty, baseUI)
                : String(ord.qty)
              return (
                <tr key={ord.id || ord.stamp}>
                  <td className="text-nowrap">
                    {ord.sell
                      ? <>
                          <span>{qtyStr}</span>
                          <img src={logoPath(ord.baseSymbol)} alt={ord.baseSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{ord.baseSymbol.toUpperCase()}</span>
                          <span>&rarr;</span>
                          <img src={logoPath(ord.quoteSymbol)} alt={ord.quoteSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{ord.quoteSymbol.toUpperCase()}</span>
                        </>
                      : <>
                          <img src={logoPath(ord.quoteSymbol)} alt={ord.quoteSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{ord.quoteSymbol.toUpperCase()}</span>
                          <span>&rarr;</span>
                          <span>{qtyStr}</span>
                          <img src={logoPath(ord.baseSymbol)} alt={ord.baseSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{ord.baseSymbol.toUpperCase()}</span>
                        </>}
                  </td>
                  <td>{statusStr}</td>
                  <td className="d-none d-md-table-cell">{filledPct}%</td>
                  <td className="text-nowrap">{ageSince(ord.submitTime)}</td>
                  {/* WP-21 drive-by: use react-router `<Link>` instead
                      of the original `<a href>` so navigation stays
                      within the SPA (no full page reload) AND keeps
                      proper link semantics for assistive tech +
                      cmd-click new-tab support. */}
                  <td>
                    <Link
                      to={`/order/${ord.id}`}
                      className="ico-open fs14 plainlink"
                      aria-label={t('View order')}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
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
// StakingView (DCR only, rendered inline in center column)
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
  const loadStakeStatus = useCallback(async () => {
    const res = await postJSON('/api/stakestatus', assetID)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to load staking status')
      return
    }
    setStakeStatus(res.status as TicketStakingStatus)
  }, [assetID])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadStakeStatus().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [loadStakeStatus])

  // WP-14: refresh staking status on relevant WS notes so the
  // displayed ticket count, ticket price, and voting subsidy stay
  // current. Vanilla `wallets.ts` `handleCustomWalletNote()` (L2767)
  // dispatches `tipChange` and `ticketPurchaseUpdate` to update DCR
  // ticket stats. The bumps in the parent WP-02 stub trigger
  // re-renders but don't refetch -- this hook does the refetch.
  useNotifications(useMemo(() => ({
    walletnote: (note: CoreNote) => {
      const n = note as { payload?: { route?: string; assetID?: number } }
      const route = n.payload?.route
      const noteAssetID = n.payload?.assetID
      if (noteAssetID !== undefined && noteAssetID !== assetID) return
      if (route === 'tipChange' || route === 'ticketPurchaseUpdate') {
        loadStakeStatus()
      }
    },
  }), [assetID, loadStakeStatus]))

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
      <section className="position-relative d-flex align-items-stretch border">
        <div className="flex-center flex-grow-1 p-3">
          <span className="ico-spinner spinner me-2"></span>
        </div>
      </section>
    )
  }

  if (error && !stakeStatus) {
    return <div className="text-danger fs14 p-2">{error}</div>
  }

  if (!stakeStatus) return null

  const stats = stakeStatus.stats
  const stances = stakeStatus.stances
  const agendaCount = stances?.agendas?.length ?? 0
  const tspendCount = stances?.tspends?.length ?? 0
  const tkeyCount = stances?.treasuryKeys?.length ?? 0

  if (showVspPicker) {
    return (
      <section className="position-relative d-flex align-items-stretch flex-column border">
        <div className="d-flex align-items-center border-bottom px-3 py-2">
          <span className="pointer hoverbg p-1" onClick={() => setShowVspPicker(false)}>
            <span className="ico-arrowleft me-2"></span>
          </span>
          <span className="fs18">{t('Select VSP')}</span>
        </div>

        {vspLoading && (
          <div className="flex-center p-3">
            <span className="ico-spinner spinner me-2"></span>
          </div>
        )}

        {vsps.length > 0 && (
          <table className="compact row-border">
            <thead className="unbold fs15">
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
                  className="pointer hoverbg"
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
      </section>
    )
  }

  return (
    <section className="position-relative d-flex align-items-stretch border">
      <div className="flex-stretch-column flex-grow-1">
        <div className="d-flex align-items-center justify-content-start border-bottom px-3 py-2">
          <span className="ico-ticket me-2 fs20"></span>
          <span className="fs24">{t('Staking')}</span>
        </div>
        <div className="d-flex align-items-stretch flex-grow-1">
          {/* Stats */}
          <div className="flex-stretch-column justify-content-center fs14 flex-grow-1 p-2">
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('Active tickets')}</div>
              <div className="flex-center demi">{stats.ticketCount - stats.votes - stats.revokes}</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('Tickets bought')}</div>
              <div className="flex-center demi">{stats.ticketCount}</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('Total rewards')}</div>
              <div className="flex-center demi">{formatFourSigFigs(stats.totalRewards / conv)} DCR</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('Votes cast')}</div>
              <div className="flex-center demi">{stats.votes}</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('VSP')}</div>
              <div className="flex-center demi pointer hoverbg" onClick={loadVSPs}>
                <span className="ico-edit me-2"></span>
                <span>{stakeStatus.vsp || t('None')}</span>
              </div>
            </div>
          </div>

          {/* Set Votes sidebar */}
          {(agendaCount > 0 || tspendCount > 0 || tkeyCount > 0) && (
            <div className="flex-center p-3 flex-column border-start hoverbg pointer">
              <div className="flex-center fs18">
                <span className="fs22 ico-check"></span>
                <span className="ms-2 fs18">{t('Set Votes')}</span>
              </div>
              <hr className="dashed my-1 w-75" />
              <div className="flex-center flex-column fs14">
                {agendaCount > 0 && <span>{agendaCount} {t('agendas')}</span>}
                {tspendCount > 0 && <span>{tspendCount} {t('treasury spends')}</span>}
              </div>
            </div>
          )}
        </div>

        {!stakeStatus.vsp && !stakeStatus.isRPC && (
          <div className="flex-center py-1 px-2 fs14 text-warning">
            {t('Please select a VSP to purchase tickets.')}
          </div>
        )}

        {/* Purchase Tickets + Tickets buttons */}
        {(stakeStatus.vsp || stakeStatus.isRPC) && (
          <div className="w-100 d-flex align-items-stretch justify-content-stretch border-top p-2">
            <input
              type="number"
              className="form-control form-control-sm me-2"
              style={{ width: 60 }}
              value={purchaseN}
              onChange={e => {
                const v = parseInt(e.target.value)
                setPurchaseN(v >= 1 ? String(v) : '1')
              }}
              min="1"
            />
            <button className="feature flex-grow-1 me-2" onClick={purchaseTickets} disabled={purchasing}>
              <span className="ico-ticket me-1"></span>
              {purchasing ? '...' : t('Purchase Tickets')}
            </button>
          </div>
        )}
        {purchaseError && <div className="text-center p-2 text-danger">{purchaseError}</div>}
        {purchaseSuccess && <div className="text-center p-2 text-success">{purchaseSuccess}</div>}
      </div>

      {/* Right sidebar: Ticket Price + Vote Reward */}
      <div className="flex-stretch-column border-start">
        <div className="flex-grow-1 flex-center flex-column p-3 border-bottom">
          <span className="fs14 demi lh1 pb-1">{t('Ticket Price')}</span>
          <span className="d-flex align-items-end">
            <span className="fs18">{formatFourSigFigs(stakeStatus.ticketPrice / conv)} DCR</span>
          </span>
        </div>
        <div className="flex-grow-1 flex-center flex-column p-3">
          <span className="fs14 demi lh1 pb-1">{t('Vote Reward')}</span>
          <span className="d-flex align-items-end">
            <span className="fs18">{formatFourSigFigs(stakeStatus.votingSubsidy / conv)} DCR</span>
          </span>
        </div>
      </div>

      {error && <div className="text-danger p-2 border-top">{error}</div>}
    </section>
  )
}
