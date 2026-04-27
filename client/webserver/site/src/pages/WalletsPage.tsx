import {
  useState, useEffect, useCallback, useMemo, useRef
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse, Errors } from '../services/api'
import { fetchLocal, storeLocal, lastVariantByTickerLK, selectedAssetLK } from '../services/state'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { FormOverlay } from '../components/common/FormOverlay'
import { DepositAddress } from '../components/common/DepositAddress'
import { CopyButton } from '../components/common/CopyButton'
import { NewWalletForm } from '../components/common/NewWalletForm'
import { WalletConfigForm } from '../components/common/WalletConfigForm'
import type { WalletConfigFormHandle } from '../components/common/WalletConfigForm'
import { AssetSymbol } from '../components/common/AssetSymbol'
import {
  formatCoinAtom, formatBestWeCan, formatFiat, atomToConventional,
  formatRateToRateStep, formatCoinAtomToLotSizeBaseCurrency, conventionalRate,
  shortSymbol, logoPath
} from '../hooks/useFormatters'
import { explorerURL } from '../components/CoinExplorers'
import { filled, haveActiveOrders } from '../components/AccountUtils'
import BridgingPopup from '../components/bridging/BridgingPopup'
import { allBridgePaths } from '../components/bridging/bridgeApi'
import { ROUTES } from '../router/routes'
import { walletConnecting } from '../hooks/useWalletMsg'
import type {
  SupportedAsset, WalletState, WalletDefinition,
  WalletTransaction, TxHistoryResult, Order, UnitInfo,
  CoreNote, TicketStakingStatus, VotingServiceProvider,
  Exchange, Spot,
  WalletPeer, WalletRestoration,
  ProposalsMeta, Ticket
} from '../stores/types'
import { PeerSource, ApprovalStatus, DCRAssetID } from '../stores/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Wallet trait flags (mirrors vanilla `wallets.ts` L66-77). Used to
// gate "other actions" UI on wallets that actually implement each
// optional capability.
const traitRescanner = 1
const traitLogFiler = 1 << 2
const traitRecoverer = 1 << 5
const traitRestorer = 1 << 8
const traitTxFeeEstimator = 1 << 9
const traitPeerManager = 1 << 10
const traitTokenApprover = 1 << 13
const traitTicketBuyer = 1 << 15
const traitFundsMixer = 1 << 17
// Aggregated mask used to decide whether to render the "Other Actions"
// section at all (skipped entirely when no extra-actions trait is set).
// Mirrors vanilla `traitsExtraOpts` L77 plus `traitPeerManager` since
// the React UI hosts Manage Peers in this same section (vanilla puts
// it in a separate "network actions" modal we don't have).
const traitsExtraOpts =
  traitLogFiler | traitRecoverer | traitRestorer | traitRescanner | traitPeerManager | traitTokenApprover

// PendingForce is the stashed request shape for the shared
// confirmForce flow. The two callers (recover + rescan) post the same
// {assetID} body, with `force: true` added on retry. Vanilla stores
// `forceUrl` + `forceReq` as `string` + arbitrary object, but in
// practice both endpoints share this shape.
interface PendingForce {
  url: string
  req: { assetID: number; force?: boolean }
}

// T18#6: previously declared `DCR_ASSET_ID = 42` locally here,
// duplicating the shared `DCRAssetID` constant from stores/types.
// Now imported from there -- single source of truth for the DCR
// BIP-44 coin type.
const TX_HISTORY_PAGE_SIZE = 10

// Sidebar (asset list column) width in px. Single source of truth so
// the holdings "Total: $X" block in the global header stays exactly
// aligned with the column edges below it.
const SIDEBAR_WIDTH = 240

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

// WP-13: ticket-status i18n keys, indexed by the numeric ticket
// status returned in `Ticket.status`. Mirrors vanilla `wallets.ts`
// `ticketStatusTranslationKeys` array (L89-99). All 9 keys exist in
// `en-US.json` L918-926.
const TICKET_STATUS_KEYS = [
  'TICKET_STATUS_UNKNOWN',
  'TICKET_STATUS_UNMINED',
  'TICKET_STATUS_IMMATURE',
  'TICKET_STATUS_LIVE',
  'TICKET_STATUS_VOTED',
  'TICKET_STATUS_MISSED',
  'TICKET_STATUS_EXPIRED',
  'TICKET_STATUS_UNSPENT',
  'TICKET_STATUS_REVOKED'
]

// WP-13: ticket pagination constants (vanilla `wallets.ts` L183-184).
// `scanStartMempool` is the sentinel block height for "scan from
// mempool" passed to `/api/ticketpage` on the first call.
const TICKET_PAGE_SIZE = 10
const SCAN_START_MEMPOOL = -1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Returns null when no asset has a usable fiat rate (so the caller can
// render a placeholder like "—" instead of misleading "$0"). Zero is
// still a legitimate total when rates are known.
function totalFiatBalance (
  assets: Record<number, SupportedAsset>,
  fiatRatesMap: Record<number, number>
): number | null {
  let total = 0
  let anyRate = false
  for (const asset of Object.values(assets)) {
    if (!asset.wallet) continue
    const bal = asset.wallet.balance
    const rate = fiatRatesMap[asset.id]
    if (!rate) continue
    anyRate = true
    const conv = asset.unitInfo.conventional.conversionFactor
    total += ((bal.available + bal.locked + bal.immature) / conv) * rate
  }
  return anyRate ? total : null
}

/** Group assets by normalized ticker for the sidebar. */
interface TickerGroup {
  ticker: string
  symbol: string
  name: string
  // assetIDs is sorted by asset.symbol ascending so the per-chain
  // breakdown order is stable across renders / refreshes (the upstream
  // `Object.values(assets)` order is by ascending numeric BIP id, which
  // is also stable but arbitrary — sorting by symbol matches what users
  // see in the UI). The picked default variant is computed at click
  // time via pickVariantForGroup, not stored on the group.
  assetIDs: number[]
  hasWallet: boolean
  // totalNative is the sum of per-asset wallet balances converted from
  // atoms to whole units (e.g. BTC, ETH). Shown in the sidebar so the
  // displayed value doesn't depend on fiat rate availability.
  totalNative: number
  // totalFiat is kept for sort ordering — we want wallet rows with the
  // largest USD value near the top; falling back to totalNative would
  // mix unrelated units (e.g. ETH vs USDC).
  totalFiat: number
  // ID of the first variant whose wallet is mid-connect (enabled but
  // its `Running` flag is false), or undefined if none is. Drives the
  // tiny spinner next to the ticker — post-login this surfaces the
  // transient boot window between `walletstate` notes.
  connectingAssetID: number | undefined
}

// tickerOf normalizes an asset's symbol to the ticker used for sidebar
// grouping. WETH is grouped under ETH so wrapped-Ether balances roll
// up into the parent ticker the user thinks in.
function tickerOf (symbol: string): string {
  const baseSym = shortSymbol(symbol)
  return baseSym === 'WETH' ? 'ETH' : baseSym
}

function buildTickerGroups (
  assets: Record<number, SupportedAsset>,
  fiatRatesMap: Record<number, number>
): TickerGroup[] {
  const groups: Record<string, TickerGroup> = {}
  for (const asset of Object.values(assets)) {
    const ticker = tickerOf(asset.symbol)
    if (!groups[ticker]) {
      groups[ticker] = {
        ticker,
        symbol: asset.symbol,
        name: asset.name,
        assetIDs: [],
        hasWallet: false,
        totalNative: 0,
        totalFiat: 0,
        connectingAssetID: undefined
      }
    }
    const g = groups[ticker]
    g.assetIDs.push(asset.id)
    if (asset.wallet) {
      g.hasWallet = true
      const bal = asset.wallet.balance
      const rate = fiatRatesMap[asset.id] ?? 0
      const conv = asset.unitInfo.conventional.conversionFactor
      const native = (bal.available + bal.locked + bal.immature) / conv
      g.totalNative += native
      g.totalFiat += native * rate
    }
  }
  // Within each group, sort variants by symbol ascending (stable +
  // alphabetical) so the per-chain rows render in the same order every
  // time. Cross-group ordering uses hasWallet first, then totalFiat
  // descending so the most valuable wallet-bearing rows surface at
  // the top of the sidebar.
  const ordered = Object.values(groups)
  for (const g of ordered) {
    g.assetIDs.sort((a, b) => assets[a].symbol.localeCompare(assets[b].symbol))
    // connectingAssetID picks the first variant (in sorted order)
    // whose wallet is mid-connect. Computed after the sort so the
    // chosen asset is deterministic across renders.
    g.connectingAssetID = g.assetIDs.find(id => walletConnecting(assets[id]?.wallet))
  }
  return ordered.sort((a, b) => {
    if (a.hasWallet !== b.hasWallet) {
      return a.hasWallet
        ? -1
        : 1
    }
    return b.totalFiat - a.totalFiat
  })
}

// visibleVariantsOf filters a group's assetIDs down to the variants
// the sidebar should actually display in its expansion: parent assets
// (non-tokens) always show, and a token variant only shows when its
// parent has a wallet — without the parent, the token can't be
// created or held, so listing it is just noise. To start using the
// hidden variant, the user creates the parent first (clicking the
// parent's own coin-group row), and the variant becomes visible on
// the next render once the parent wallet appears in `assets`.
function visibleVariantsOf (
  g: TickerGroup,
  assets: Record<number, SupportedAsset>
): number[] {
  return g.assetIDs.filter(id => {
    const a = assets[id]
    if (!a) return false
    if (!a.token) return true
    return !!assets[a.token.parentID]?.wallet
  })
}

// pickVariantForGroup chooses which variant to land on when the user
// clicks a sidebar group. Tries, in order:
//   1. The user's last-viewed variant for this ticker (localStorage),
//      provided it's "useful" — wallet exists, or the parent has a
//      wallet (auto-create can fire on selection). Without the
//      usefulness check, a stale auto-pick (e.g. the alphabetic-first
//      `usdc.base` saved by an earlier mount when no wallet existed
//      anywhere yet) strands the user on a dead variant even when
//      other variants in the group are actionable.
//   2. The first variant with an existing wallet — the user can act
//      on it immediately.
//   3. The first variant whose parent already has a wallet — selecting
//      it triggers the auto-create-on-click effect and the "Creating…"
//      view. Without this fallback we'd default-land on a variant
//      whose parent doesn't exist yet, showing "Create parent first"
//      even when an actionable variant sits one row away.
//   4. The first variant in the group's sorted assetIDs. Falls through
//      to NoWalletView's "Create parent first" hint (no parent in any
//      variant of the group).
// The persisted ID is validated against current assetIDs first so a
// stale value (asset support dropped between releases) doesn't strand
// the user on a missing variant.
function pickVariantForGroup (
  g: TickerGroup,
  lastByTicker: Record<string, number>,
  assets: Record<number, SupportedAsset>
): number {
  const last = lastByTicker[g.ticker]
  if (last !== undefined && g.assetIDs.includes(last)) {
    const a = assets[last]
    if (a?.wallet) return last
    if (a?.token && assets[a.token.parentID]?.wallet) return last
    // Persisted but useless — fall through.
  }
  for (const id of g.assetIDs) {
    if (assets[id]?.wallet) return id
  }
  for (const id of g.assetIDs) {
    const a = assets[id]
    if (a?.token && assets[a.token.parentID]?.wallet) return id
  }
  return g.assetIDs[0]
}

// loadLastVariantByTicker reads the persisted last-variant map from
// localStorage. Best-effort coerces the values to numbers — drops any
// non-numeric entries rather than crashing the page on malformed
// state (external edits, older schemas, etc.).
function loadLastVariantByTicker (): Record<string, number> {
  const raw = fetchLocal(lastVariantByTickerLK)
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function saveLastVariantByTicker (m: Record<string, number>) {
  storeLocal(lastVariantByTickerLK, m)
}

/** Collect markets from all exchanges where the selected asset is base or quote. */
interface MarketRow {
  host: string
  name: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
  lotsize: number
  ratestep: number
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
        lotsize: mkt.lotsize,
        ratestep: mkt.ratestep,
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

  // selectedAssetID is the variant currently shown on the right side
  // (e.g. usdc.matic when the user is looking at USDC on Polygon).
  // Persisted to localStorage so navigating to /markets and back lands
  // the user on the same view they left. The first-mount auto-select
  // effect only fires when this is still null, so the restored value
  // takes precedence; if the persisted asset is no longer supported
  // (asset list changed between releases), the validity check in the
  // render path falls through to the auto-select on the next render.
  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(() => {
    const v = fetchLocal(selectedAssetLK)
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
  // WP-19: extended `activeForm` to host the four new action modals
  // (recoverWallet / exportWalletAuth / restoreWalletInfo / managePeers)
  // plus the shared confirmForce step. The string-tagged enum mirrors
  // vanilla's per-form `Doc.show()` switching in `forms.show(...)`.
  const [activeForm, setActiveForm] = useState<string | null>(null)
  // Shared force-confirm pending state. Vanilla stashes
  // `this.forceUrl` + `this.forceReq` on the page class, and the
  // confirmForce form re-submits with `force: true`. We use the same
  // pattern: when a request fails with `activeOrdersErr`, we keep the
  // URL + body around so the modal's confirm button can re-issue it.
  const [pendingForce, setPendingForce] = useState<PendingForce | null>(null)
  // Restoration cards returned from /api/restorewalletinfo. Set when
  // the password modal succeeds; cleared on close.
  const [restorationInfo, setRestorationInfo] = useState<WalletRestoration[] | null>(null)
  // WP-16: which approved token version the user clicked "Remove" on.
  // Set when transitioning from the token-versions-table modal to
  // the confirmation modal, cleared on close. Mirrors vanilla
  // `wallets.ts` `this.unapprovingTokenVersion`.
  const [unapprovingVersion, setUnapprovingVersion] = useState<number | null>(null)
  // WP-15: bridge topology, fetched once on mount via
  // /api/allbridgepaths. Used to (a) gate the Bridge button visibility
  // on whether any paths exist for the selected ticker's network
  // siblings, and (b) hand the topology to BridgingPopup so it doesn't
  // need its own fetch. `null` = not yet loaded; `{}` = loaded but
  // empty. Vanilla loads this on app start; we keep it page-local
  // since no other page needs it.
  const [bridgePaths, setBridgePaths] = useState<Record<number, Record<number, string[]>> | null>(null)

  // Sticky last-viewed variant per ticker group. Initialized from
  // localStorage and written on every selectedAssetID change so revisits
  // to the same group land on the user's most recent pick (e.g. USDC.POL
  // when the user last clicked Polygon). Falls back to the first variant
  // in the group's sorted assetIDs (alphabetically lowest by symbol)
  // when no entry is recorded yet — see pickVariantForGroup.
  const [lastVariantByTicker, setLastVariantByTicker] = useState<Record<string, number>>(loadLastVariantByTicker)

  // In-flight token-wallet creates triggered by clicking a token group
  // whose parent has a wallet but the token doesn't. Per-asset Set so
  // multiple variants of the same group (e.g. USDC.ETH + USDC.POL) can
  // run in parallel. Cleared per-asset when the API response resolves.
  const [creatingTokenIDs, setCreatingTokenIDs] = useState<Set<number>>(new Set())
  // Per-asset error messages from the auto-create flow. Cleared on
  // selectedAssetID change so the user's "navigate away and back to
  // retry" gesture works without a Retry button.
  const [tokenCreateErrors, setTokenCreateErrors] = useState<Map<number, string>>(new Map())

  // Force re-render on note arrival so balances refresh.
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick(n => n + 1), [])

  // WP-15: lazy-load bridge paths on mount. Failure is non-fatal --
  // the Bridge button just stays hidden. Avoid blocking the page
  // render on this.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await allBridgePaths()
      if (cancelled) return
      if (res.ok) setBridgePaths(res.paths)
      else setBridgePaths({})
    })()
    return () => { cancelled = true }
  }, [])

  // -----------------------------------------------------------------------
  // WS subscriptions
  // -----------------------------------------------------------------------

  // CL-ASSETS-STALE-MEMO: `balance`, `walletstate`, `walletconfig`,
  // `walletsync`, `fiatrateupdate`, `createwallet` are dispatched
  // globally by `AppLayout.tsx` to `useMarketStore`, which rebuilds
  // the affected slices of `useAuthStore` with new top-level refs
  // (see the comment block at the top of `useMarketStore.ts` for the
  // rationale). The `useAuthStore(s => s.assets)` / `s.fiatRatesMap`
  // selectors below fire on those setState calls, so every
  // `useMemo([...])` in this component re-runs with the fresh refs
  // and the view stays in sync with no per-page receiver needed. Only
  // the notes that don't have a `useMarketStore` equivalent are
  // listed here.
  const noteReceivers = useMemo(() => ({
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
    // WP-03 / WP-15: `bridge` notification handler. As of B-L16,
    // BridgingPopup also subscribes to this channel directly via its
    // own useNotifications hook, so this parent-level handler only
    // exists to bump the page render tick -- bridge txs move balance
    // between same-ticker network siblings, and the wallet detail
    // view should reflect that even when the popup is closed.
    bridge: (_note: CoreNote) => {
      bump()
    },
  }), [bump])

  useNotifications(noteReceivers)

  // -----------------------------------------------------------------------
  // Sidebar
  // -----------------------------------------------------------------------

  const tickerGroups = useMemo(
    () => buildTickerGroups(assets, fiatRatesMap),
    [assets, fiatRatesMap]
  )

  // Hide non-wallet groups by default — the sidebar only shows assets
  // the user actually holds. Clicking the "Show all" footer flips this
  // on (one-way; resets on remount, no localStorage persistence).
  const [showAllAssets, setShowAllAssets] = useState(false)
  const visibleGroups = useMemo(
    () => showAllAssets ? tickerGroups : tickerGroups.filter(g => g.hasWallet),
    [tickerGroups, showAllAssets]
  )
  const hiddenGroupCount = tickerGroups.length - visibleGroups.length

  // Null signals "fiat rates haven't loaded yet" — render "—" instead
  // of a misleading "$0" in the Holdings total. See totalFiatBalance.
  const holdingsFiat = useMemo(
    () => totalFiatBalance(assets, fiatRatesMap),
    [assets, fiatRatesMap]
  )

  // Portal target: the holdings "Total: $X" block renders into the
  // global app header's left slot via createPortal (mirrors the
  // pattern MarketsPage uses for market stats). Auto-unmounts when
  // /wallets navigates away — no per-page gating needed.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderSlot(document.getElementById('headerSlot'))
    return () => setHeaderSlot(null)
  }, [])

  // Auto-select the first wallet-bearing asset on mount, restoring the
  // user's last-viewed variant within that group when persisted. Also
  // self-corrects if a previously-persisted selectedAssetID points to
  // an asset that no longer exists (asset list changed between
  // releases) — drop it and fall through to the auto-select.
  useEffect(() => {
    if (selectedAssetID !== null && assets[selectedAssetID]) return
    if (selectedAssetID !== null && !assets[selectedAssetID]) {
      setSelectedAssetID(null)
      return
    }
    const first = tickerGroups.find(g => g.hasWallet)
    if (first) setSelectedAssetID(pickVariantForGroup(first, lastVariantByTicker, assets))
  }, [tickerGroups, selectedAssetID, lastVariantByTicker, assets])

  // Clear selection if its group falls out of visibleGroups while
  // showAllAssets is false (e.g. the asset's last wallet was removed
  // and the group is now hidden). Without this, the right-column
  // detail keeps rendering the orphaned asset while the sidebar can't
  // highlight it — a confusing "ghost selection". The auto-select
  // effect above then picks a wallet-bearing replacement.
  useEffect(() => {
    if (selectedAssetID === null) return
    if (showAllAssets) return
    const inVisible = visibleGroups.some(g => g.assetIDs.includes(selectedAssetID))
    if (!inVisible) setSelectedAssetID(null)
  }, [selectedAssetID, visibleGroups, showAllAssets])

  // Persist the current selection so /wallets restores the same view
  // after the user navigates to /markets, /settings, etc. and back.
  useEffect(() => {
    if (selectedAssetID === null) return
    storeLocal(selectedAssetLK, selectedAssetID)
  }, [selectedAssetID])

  // Persist the last-viewed variant per ticker. Catches both code paths
  // (sidebar click via pickVariantForGroup and per-chain row click)
  // without separate handlers. Idempotent — no write if the value
  // hasn't changed.
  useEffect(() => {
    if (selectedAssetID === null) return
    const asset = assets[selectedAssetID]
    if (!asset) return
    const ticker = tickerOf(asset.symbol)
    setLastVariantByTicker(prev => {
      if (prev[ticker] === selectedAssetID) return prev
      const next = { ...prev, [ticker]: selectedAssetID }
      saveLastVariantByTicker(next)
      return next
    })
  }, [selectedAssetID, assets])

  // Clear per-asset error messages on navigation so the user can
  // retry by leaving the group and coming back. The previous group's
  // errors aren't useful elsewhere; in-flight creates (creatingTokenIDs)
  // stay so the result still updates state when it resolves.
  const lastSelectedID = useRef<number | null>(null)
  useEffect(() => {
    if (lastSelectedID.current !== selectedAssetID) {
      lastSelectedID.current = selectedAssetID
      setTokenCreateErrors(prev => prev.size === 0 ? prev : new Map())
    }
  }, [selectedAssetID])

  // Auto-create-on-click for token wallets whose parent already exists.
  // For the currently-selected group, fire /api/newwallet for every
  // variant where (a) it's a token, (b) it has no wallet yet, (c) its
  // parent has a wallet, (d) we're not already creating it, (e) the
  // last attempt didn't error (per-navigation; clears above). The
  // server-side parent-creation hook also auto-creates tokens after
  // the parent in apiNewWallet, so this fires for the "user already
  // has a parent on a different chain" / "previous create-attempt
  // failed" / "asset support added in a later release" cases.
  useEffect(() => {
    if (selectedAssetID === null) return
    const group = tickerGroups.find(g => g.assetIDs.includes(selectedAssetID))
    if (!group) return
    const candidates: SupportedAsset[] = []
    for (const id of group.assetIDs) {
      const a = assets[id]
      if (!a || !a.token || a.wallet) continue
      const parent = assets[a.token.parentID]
      if (!parent?.wallet) continue
      if (creatingTokenIDs.has(id)) continue
      if (tokenCreateErrors.has(id)) continue
      candidates.push(a)
    }
    if (candidates.length === 0) return
    setCreatingTokenIDs(prev => {
      const next = new Set(prev)
      for (const a of candidates) next.add(a.id)
      return next
    })
    for (const asset of candidates) {
      const tokenDef = asset.token!.definition
      const config: Record<string, string> = {}
      for (const opt of tokenDef.configopts ?? []) {
        if (opt.default === undefined || opt.default === null) continue
        if (opt.isboolean) config[opt.key] = opt.default ? '1' : '0'
        else config[opt.key] = String(opt.default)
      }
      ;(async () => {
        const res = await postJSON('/api/newwallet', {
          assetID: asset.id,
          walletType: tokenDef.type,
          config,
        })
        setCreatingTokenIDs(prev => {
          if (!prev.has(asset.id)) return prev
          const next = new Set(prev)
          next.delete(asset.id)
          return next
        })
        if (!checkResponse(res)) {
          setTokenCreateErrors(prev => {
            const next = new Map(prev)
            next.set(asset.id, res.msg || 'Failed to create wallet')
            return next
          })
          return
        }
        await fetchUser()
      })()
    }
  }, [selectedAssetID, assets, tickerGroups, creatingTokenIDs, tokenCreateErrors, fetchUser])

  const selectedAsset = selectedAssetID !== null
    ? assets[selectedAssetID]
    : null
  const selectedWallet = selectedAsset?.wallet ?? null
  const net = user?.net ?? 0

  // WP-15: derive the same-ticker network sibling asset IDs for the
  // currently-selected asset. Used by both the Bridge button
  // visibility check and the BridgingPopup `networkAssetIDs` prop.
  const selectedTickerNetworkIDs = useMemo<number[]>(() => {
    if (!selectedAssetID) return []
    const group = tickerGroups.find(g => g.assetIDs.includes(selectedAssetID))
    return group ? group.assetIDs : []
  }, [selectedAssetID, tickerGroups])

  // WP-15: bridge button visibility check. Mirrors vanilla
  // `wallets.ts` `hasBridgingSupport()` (L2835): the asset must have
  // a wallet, paths must exist for it, and at least one destination
  // must also have a wallet.
  const hasBridge = useMemo<boolean>(() => {
    if (!bridgePaths) return false
    for (const id of selectedTickerNetworkIDs) {
      if (!assets[id]?.wallet) continue
      const dests = bridgePaths[id]
      if (!dests) continue
      for (const destIDStr of Object.keys(dests)) {
        const destID = Number(destIDStr)
        if (assets[destID]?.wallet) return true
      }
    }
    return false
  }, [bridgePaths, selectedTickerNetworkIDs, assets])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="d-flex fill-abs">
      {/* Holdings "Total: $X" block — portalled into the global
          header's headerSlot. Single string (left-aligned), no
          right-side alignment of the $ value with the column below.
          Static — purely informational. */}
      {headerSlot && createPortal(
        <div
          className="d-flex align-items-center px-2 h-100"
          style={{ width: SIDEBAR_WIDTH, flex: `0 0 ${SIDEBAR_WIDTH}px` }}
        >
          <span className="fs18 fw-bold lh1">
            {t('TOTAL')}: {holdingsFiat === null ? '—' : `$${formatBestWeCan(holdingsFiat)}`}
          </span>
        </div>,
        headerSlot
      )}

      {/* ---- Left Sidebar: Asset List ---- */}
      <section
        className="w-auto d-flex flex-column align-items-stretch overflow-y-auto hidden-overflow"
        style={{ minWidth: SIDEBAR_WIDTH }}
      >
        {/* Ticker balance rows */}
        <div className="flex-stretch-column">
          {visibleGroups.map((g) => {
            const selected = g.assetIDs.includes(selectedAssetID ?? -1)
            // Expansion is gated to the selected group only — non-
            // selected groups stay collapsed regardless of balance,
            // keeping the sidebar quiet until the user drills in.
            // Only the visible variants (those whose parent has a
            // wallet) count; suppressed entirely when fewer than 2
            // are visible — at 1 visible variant the aggregate row
            // already conveys the same info and the tree would be a
            // single dangling branch with nothing to navigate between.
            const visibleCount = visibleVariantsOf(g, assets).length
            const showNetworks = visibleCount >= 2 && selected
            return (
              <div key={g.ticker}>
                <div
                  className={`d-flex justify-content-between align-items-center ${selected ? '' : 'hoverbg'} pointer`}
                  onClick={() => setSelectedAssetID(pickVariantForGroup(g, lastVariantByTicker, assets))}
                  style={{
                    // L-bracket frame for the selected group: 3px
                    // left + 2px bottom in --text-color. Non-selected
                    // rows reserve the same 3px left border
                    // (transparent) so selecting / deselecting
                    // doesn't shift content horizontally; their 2px
                    // bottom border stays visible as the regular row
                    // separator.
                    //
                    // Padding is asymmetric (top 10, bottom 8) on
                    // purpose: top = bottom + border-bottom so the
                    // 20px-tall content (logo height) lands at the
                    // row's geometric center. Without this
                    // compensation the content sits ~1px above
                    // center because the 2px bottom border weighs
                    // the row down.
                    paddingTop: 10,
                    paddingBottom: 8,
                    paddingLeft: 8,
                    paddingRight: 8,
                    borderLeft: `3px solid ${selected ? 'var(--text-color)' : 'transparent'}`,
                    borderBottom: `2px solid ${selected ? 'var(--text-color)' : 'var(--border-color)'}`,
                    ...(selected
                      ? {
                          backgroundColor: 'var(--tertiary-bg)',
                          color: 'var(--text-color)',
                        }
                      : {}),
                  }}
                >
                  <div className="flex-center me-4 lh1">
                    <img src={logoPath(g.symbol)} alt={g.ticker} className="mini-icon me-1" />
                    <span className="ms-1 fs18 fw-bold">{g.ticker}</span>
                    {g.connectingAssetID !== undefined && (
                      <span
                        className="ico-spinner spinner fs11 ms-2"
                        title={t('CONNECTING_WALLET', { asset: shortSymbol(assets[g.connectingAssetID].symbol) })}
                      />
                    )}
                  </div>
                  <div className="d-flex flex-column align-items-end">
                    {g.hasWallet
                      ? <span className="fs18 fw-bold lh1">{formatBestWeCan(g.totalNative, 8)}</span>
                      : <span className="grey me-1">—</span>}
                  </div>
                </div>
                {/* Per-chain expansion under the selected multi-variant
                    group — pushes the rows below it down. Tree-style
                    indentation links each variant visually back to the
                    parent group. Click any variant to switch to it. */}
                {showNetworks && (
                  <SidebarNetworksExpansion
                    group={g}
                    assets={assets}
                    selectedAssetID={selectedAssetID ?? -1}
                    creatingTokenIDs={creatingTokenIDs}
                    tokenCreateErrors={tokenCreateErrors}
                    onSelect={setSelectedAssetID}
                  />
                )}
              </div>
            )
          })}
          {/* "Show all" footer — reveals the non-wallet groups that
              were filtered out by default. One-way: clicking expands
              the list and the button disappears (state resets only on
              page remount). Hidden when there's nothing to reveal.
              Mirrors the regular row structure (pt-2 pb-1 + mt-2
              spacer + same border pattern) so the footer reads as
              part of the list rather than a detached button. */}
          {!showAllAssets && hiddenGroupCount > 0 && (
            <div
              className="d-flex justify-content-center align-items-center hoverbg pointer"
              style={{
                // Same flat row structure as coin-group rows above:
                // top padding compensates for the bottom border
                // (10 = 8 + 2) so the centered content lands at the
                // row's geometric center. Symmetric 3px transparent
                // left+right borders keep the centered text at true
                // center (regular rows reserve only the left).
                paddingTop: 10,
                paddingBottom: 8,
                paddingLeft: 8,
                paddingRight: 8,
                borderLeft: '3px solid transparent',
                borderRight: '3px solid transparent',
                borderBottom: '2px solid var(--border-color)',
              }}
              onClick={() => setShowAllAssets(true)}
            >
              {/* line-height: 20 forces the span's line box to the
                  same height as the logo-driven content height in
                  coin-group rows above — keeps row heights
                  consistent across the list. */}
              <span className="grey fs14" style={{ lineHeight: '20px' }}>
                {t('SHOW_ALL_ASSETS', { count: hiddenGroupCount })}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ---- Two-Column Main Area ---- */}
      <div className="flex-grow-1 position-relative">
        <div className="fill-abs d-flex flex-wrap align-items-stretch stylish-overflow">
          {!selectedAsset && (
            <div className="text-center grey py-5 p-3 col-24">
              {t('SELECT_AN_ASSET_FROM_THE_SIDEBAR')}
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
                      hasBridge={hasBridge}
                    />
                  )}
                  {!selectedWallet && creatingTokenIDs.has(selectedAsset.id) && (
                    <CreatingTokenView asset={selectedAsset} />
                  )}
                  {!selectedWallet && !creatingTokenIDs.has(selectedAsset.id) &&
                   tokenCreateErrors.has(selectedAsset.id) && (
                    <TokenCreateErrorView
                      asset={selectedAsset}
                      msg={tokenCreateErrors.get(selectedAsset.id) ?? ''}
                    />
                  )}
                  {!selectedWallet && !creatingTokenIDs.has(selectedAsset.id) &&
                   !tokenCreateErrors.has(selectedAsset.id) && (
                    <NoWalletView
                      asset={selectedAsset}
                      parentAsset={selectedAsset.token ? assets[selectedAsset.token.parentID] ?? null : null}
                      onCreate={() => setActiveForm('newWallet')}
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
      <FormOverlay bare show={activeForm === 'receive'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 340 }}>
          <div className="fs18 mb-3">{t('Receive')}</div>
          {selectedAssetID !== null && (
            <DepositAddress assetID={selectedAssetID} />
          )}
        </div>
      </FormOverlay>

      <FormOverlay bare show={activeForm === 'send'} onClose={() => setActiveForm(null)}>
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

      <FormOverlay bare show={activeForm === 'txHistory'} onClose={() => setActiveForm(null)}>
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

      <FormOverlay bare show={activeForm === 'config'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380 }}>
          {selectedAsset && selectedWallet && (
            <WalletConfigView
              asset={selectedAsset}
              wallet={selectedWallet}
              onClose={() => setActiveForm(null)}
              setActiveForm={setActiveForm}
              setPendingForce={setPendingForce}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-06: recover wallet confirmation. Vanilla
          `wallets.tmpl` `recoverWalletConfirm` form (L882-895) +
          `wallets.ts` `showRecoverWallet()` (L2250) + `recoverWallet()`
          (L2669). On `activeOrdersErr`, transitions to confirmForce. */}
      <FormOverlay bare show={activeForm === 'recoverWallet'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380, maxWidth: 480 }}>
          {selectedAsset && (
            <RecoverWalletConfirm
              assetID={selectedAsset.id}
              onClose={() => setActiveForm(null)}
              onForceNeeded={(url, req) => {
                setPendingForce({ url, req })
                setActiveForm('confirmForce')
              }}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-07: export wallet password prompt. Vanilla
          `wallets.tmpl` `exportWalletAuth` form (L897-918) +
          `wallets.ts` `displayExportWalletAuth()` (L2624) +
          `exportWalletAuthSubmit()` (L2634). On success, transitions to
          restoreWalletInfo with the returned restoration cards. */}
      <FormOverlay bare show={activeForm === 'exportWalletAuth'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 400, maxWidth: 520 }}>
          {selectedAsset && (
            <ExportWalletAuth
              assetID={selectedAsset.id}
              onClose={() => setActiveForm(null)}
              onSuccess={(info) => {
                setRestorationInfo(info)
                setActiveForm('restoreWalletInfo')
              }}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-07 (cont.): restore wallet info display. Vanilla
          `wallets.tmpl` `restoreWalletInfo` form (L919-947) +
          `wallets.ts` `displayRestoreWalletInfo()` (L2655). */}
      <FormOverlay bare show={activeForm === 'restoreWalletInfo'} onClose={() => { setActiveForm(null); setRestorationInfo(null) }}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 400, maxWidth: 560, maxHeight: '80vh', overflowY: 'auto' }}>
          {restorationInfo && (
            <RestoreWalletInfo
              info={restorationInfo}
              onClose={() => { setActiveForm(null); setRestorationInfo(null) }}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-09: manage peers. Vanilla `wallets.tmpl` `managePeersForm`
          (L779-815) + `wallets.ts` `showManagePeersForm()` (L834) +
          `updateWalletPeersTable()` (L756) + `submitAddPeer()` (L843).
          The Add Peer / Remove Peer flows poll the wallet for an
          updated peer list (vanilla's `spinUntilPeersUpdate`); we
          re-fetch on every successful mutation. */}
      <FormOverlay bare show={activeForm === 'managePeers'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 480, maxWidth: 640, maxHeight: '80vh', overflowY: 'auto' }}>
          {selectedAsset && (
            <ManagePeers
              assetID={selectedAsset.id}
              onClose={() => setActiveForm(null)}
            />
          )}
        </div>
      </FormOverlay>

      {/* Shared confirm-force modal. Used by recover (WP-06) and rescan
          when the wallet is actively managing orders. Vanilla
          `wallets.tmpl` `confirmForce` form (L865-880) + `wallets.ts`
          `confirmForceSubmit()` (L2700). The pendingForce state holds
          the URL + body to retry with `force: true`. */}
      <FormOverlay bare show={activeForm === 'confirmForce'} onClose={() => { setActiveForm(null); setPendingForce(null) }}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 380, maxWidth: 520 }}>
          {pendingForce && (
            <ConfirmForce
              pending={pendingForce}
              onClose={() => { setActiveForm(null); setPendingForce(null) }}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-15: bridging popup. Mounts when the user clicks the
          Bridge button. The popup itself owns the BridgeState reducer
          + WS subscriptions (via its own useNotifications hook), so
          the parent only manages visibility. Mounting also triggers
          the lazy /api/pendingbridges + /api/bridgehistory loads. */}
      <FormOverlay bare show={activeForm === 'bridge'} onClose={() => setActiveForm(null)}>
        {bridgePaths && hasBridge && (
          <BridgingPopup
            networkAssetIDs={selectedTickerNetworkIDs}
            bridgePaths={bridgePaths}
            onClose={() => setActiveForm(null)}
          />
        )}
      </FormOverlay>

      {/* WP-16: token approval table. Vanilla `wallets.tmpl`
          `unapproveTokenTableForm` (L815-842) + `wallets.ts`
          `showUnapproveTokenAllowanceTableForm()` (L718). Lists every
          approved swap-contract version for the selected token
          wallet, with a Remove icon per row that transitions to the
          single-version confirmation modal. */}
      <FormOverlay bare show={activeForm === 'unapproveTokenTable'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 480, maxWidth: 640 }}>
          {selectedAsset && selectedWallet && (
            <UnapproveTokenTable
              asset={selectedAsset}
              wallet={selectedWallet}
              exchanges={exchanges}
              onClose={() => setActiveForm(null)}
              onPickVersion={(version) => {
                setUnapprovingVersion(version)
                setActiveForm('unapproveTokenConfirm')
              }}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-16: token approval removal confirmation. Vanilla
          `wallets.tmpl` `unapproveTokenForm` (L845-864) + `wallets.ts`
          `showUnapproveTokenAllowanceForm()` (L680) +
          `submitUnapproveTokenAllowance()` (L654). Fetches the tx
          fee estimate via /api/approvetokenfee on mount and displays
          it; Submit posts to /api/unapprovetoken, then shows the tx
          ID with an explorer link (mirroring vanilla's behavior of
          staying on the success-state pane instead of auto-closing). */}
      <FormOverlay
        bare
        show={activeForm === 'unapproveTokenConfirm'}
        onClose={() => { setActiveForm(null); setUnapprovingVersion(null) }}
      >
        <div className="bg-body border rounded p-4" style={{ minWidth: 480, maxWidth: 560 }}>
          {selectedAsset && unapprovingVersion !== null && (
            <UnapproveTokenConfirm
              asset={selectedAsset}
              assets={assets}
              fiatRatesMap={fiatRatesMap}
              version={unapprovingVersion}
              net={net}
              onClose={() => { setActiveForm(null); setUnapprovingVersion(null) }}
              onSuccess={() => fetchUser()}
            />
          )}
        </div>
      </FormOverlay>

      {/* WP-17: new wallet wizard. Mirrors vanilla `wallets.ts`
          `showNewWallet()` (L930) which just hands off to the shared
          NewWalletForm component. The form handles its own wallet-type
          tabs, config-option rendering (via WalletConfigForm), defaults
          loading from /api/defaultwalletcfg, and password prompt (when
          the wallet definition requires one). `onSuccess` refreshes
          the user state so the newly-created wallet appears in the
          sidebar + detail view immediately. */}
      <FormOverlay bare show={activeForm === 'newWallet'} onClose={() => setActiveForm(null)}>
        <div className="bg-body border rounded p-4" style={{ minWidth: 440, maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }}>
          {selectedAsset && (
            <NewWalletForm
              assetID={selectedAsset.id}
              onSuccess={async () => {
                await fetchUser()
                setActiveForm(null)
              }}
              onBack={() => setActiveForm(null)}
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

// WP-17: shows the "no wallet configured" placeholder with a button
// that opens the full NewWalletForm modal (previously a stub that
// posted to /api/newwallet with an empty body -- never actually
// worked for assets with required config). Mirrors vanilla
// `wallets.ts` `showNewWallet()` (L930) which also just hands off
// to the shared NewWalletForm component.
//
// Token wallets aren't shown a Create button: they are auto-created
// alongside their parent wallet (server-side in apiNewWallet). If a
// token row ends up here, it means the parent wallet doesn't exist
// yet, so prompt the user to create the parent instead.
function NoWalletView ({ asset, parentAsset, onCreate }: {
  asset: SupportedAsset
  parentAsset: SupportedAsset | null
  onCreate: () => void
}) {
  const { t } = useTranslation()
  const isToken = !!asset.token

  return (
    <div className="text-center py-4">
      <img src={logoPath(asset.symbol)} alt={asset.symbol} width={48} height={48} className="mb-3" />
      <div className="fs18 mb-2">{asset.name}</div>
      <p className="text-secondary fs14 mb-3">{t('NO_WALLET_CONFIGURED_FOR_THIS_ASSET')}</p>
      {!isToken && (
        <button
          className="btn btn-primary"
          onClick={onCreate}
        >
          {t('CREATE_WALLET')}
        </button>
      )}
      {isToken && parentAsset && (
        <p className="text-secondary fs14">
          {t('CREATE_PARENT_WALLET_FIRST', { parent: parentAsset.name })}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CreatingTokenView — shown in place of NoWalletView while a token
// wallet is being auto-created (effect in WalletsPage). The auto-create
// is best-effort and resolves either by populating the wallet (which
// flips us into WalletDetail) or by surfacing an error here via
// TokenCreateErrorView.
// ---------------------------------------------------------------------------

function CreatingTokenView ({ asset }: { asset: SupportedAsset }) {
  const { t } = useTranslation()
  return (
    <div className="text-center py-4">
      <img src={logoPath(asset.symbol)} alt={asset.symbol} width={48} height={48} className="mb-3" />
      <div className="fs18 mb-2">{asset.name}</div>
      <div className="d-flex justify-content-center align-items-center">
        <span className="ico-spinner spinner fs18 grey me-2" />
        <span className="fs15 text-secondary">{t('CREATING_TOKEN_WALLET')}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TokenCreateErrorView — shown when an auto-create attempt failed for
// the currently-selected token. Cleared per-asset on navigation, so the
// user retries by leaving the group and coming back (no Retry button).
// ---------------------------------------------------------------------------

function TokenCreateErrorView ({ asset, msg }: { asset: SupportedAsset; msg: string }) {
  const { t } = useTranslation()
  return (
    <div className="text-center py-4">
      <img src={logoPath(asset.symbol)} alt={asset.symbol} width={48} height={48} className="mb-3" />
      <div className="fs18 mb-2">{asset.name}</div>
      <p className="text-danger fs14 mb-1">{t('TOKEN_WALLET_CREATE_FAILED')}</p>
      <p className="text-secondary fs13 text-break">{msg}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SidebarNetworksExpansion — per-chain row list rendered inside the
// sidebar directly below the selected multi-variant token group's row.
// Pushes other groups below it down (in-flow expansion). Each variant
// row is indented with a tree-style ASCII connector linking it back to
// the parent group, mimicking the visual cue you'd expect from a
// drill-down list.
//
// Variant order matches group.assetIDs (sorted by symbol ascending in
// buildTickerGroups). Each row is clickable — switches selectedAssetID
// and the auto-create effect fires for any newly-eligible candidate.
//
// The selected variant takes a `--tertiary-bg` fill plus a darker
// text colour, so the active chain stands out clearly against its
// siblings.
// ---------------------------------------------------------------------------

function SidebarNetworksExpansion ({
  group, assets, selectedAssetID, creatingTokenIDs, tokenCreateErrors, onSelect,
}: {
  group: TickerGroup
  assets: Record<number, SupportedAsset>
  selectedAssetID: number
  creatingTokenIDs: Set<number>
  tokenCreateErrors: Map<number, string>
  onSelect: (id: number) => void
}) {
  const { t } = useTranslation()
  // Tree-glyph geometry. Centerline + stub-end pulled inward — the
  // tree still visually originates from the parent group row's
  // coin-symbol area but takes less horizontal space. ~30% closer
  // to the row's left edge and ~35% shorter L-stub vs the previous
  // values (18 → 13, stub 20 → 13).
  const treeStartX = 13 // centerline, px from row's left edge
  const treeStubEnd = 26 // px from row's left edge to where stub meets the variant logo
  // The bold "selection branch" runs from the parent token row down
  // through every variant up to and including the selected one. So
  // for each variant at index i:
  //   • i < selectedIndex   → top-half bold (path arriving) AND
  //                           bottom-half bold (path passing through),
  //                           stub thin (this row isn't the destination).
  //   • i === selectedIndex → top-half bold + stub bold (the L pointing
  //                           at the selected row); bottom-half stays
  //                           thin since the selection ends here.
  //   • i > selectedIndex   → all thin (path doesn't reach this row).
  // selectedIndex < 0 means no variant in this group is selected (the
  // group is open because hasAnyBalance, but the user is currently
  // looking at a different group) — render every line thin.
  // Filter to the variants that are actually visible (parent wallet
  // exists) before computing the tree geometry, so the bold-path
  // index calculations operate on the same row set the user sees.
  const visibleIDs = visibleVariantsOf(group, assets)
  const selectedIndex = visibleIDs.indexOf(selectedAssetID)
  // Sum the conventional balance across every variant in the group so
  // each row can show its share as a % of the group total instead of
  // the raw amount. Conventional units are already normalised (e.g.
  // USDC = 1 USDC regardless of chain), so summing across variants is
  // valid. Total is 0 when no variant has a wallet — every row falls
  // back to "—".
  const groupTotalConventional = visibleIDs.reduce((sum, id) => {
    const a = assets[id]
    if (!a?.wallet) return sum
    const total = a.wallet.balance.available + a.wallet.balance.locked + a.wallet.balance.immature
    return sum + atomToConventional(total, a.unitInfo)
  }, 0)
  return (
    <div className="flex-stretch-column">
      {visibleIDs.map((id, i) => {
        const a = assets[id]
        if (!a) return null
        const ui = a.unitInfo
        const isSelected = id === selectedAssetID
        const parentAsset = a.token ? assets[a.token.parentID] : null
        const totalAtoms = a.wallet
          ? a.wallet.balance.available + a.wallet.balance.locked + a.wallet.balance.immature
          : 0
        // Show this variant's share of the group total as a percentage.
        // Falls back to the creating/error/em-dash sentinels when the
        // wallet doesn't exist (or the group total is zero).
        const variantConventional = a.wallet ? atomToConventional(totalAtoms, ui) : 0
        const balanceText = a.wallet && groupTotalConventional > 0
          ? `${Math.round((variantConventional / groupTotalConventional) * 100)}%`
          : creatingTokenIDs.has(id)
            ? t('CREATING')
            : tokenCreateErrors.has(id)
              ? t('CREATE_FAILED')
              : '—'
        const isLast = i === visibleIDs.length - 1
        const networkLabel = parentAsset?.name ?? a.name
        // Per-segment boldness: top-half is part of the bold branch
        // for any row at-or-before the selected one; bottom-half is
        // bold only for rows STRICTLY before the selected one (the
        // selection ends at the L-corner, so its run-down stays thin);
        // the horizontal stub is bold only for the single selected
        // row (it's the visual "you are here" pointer).
        const topHalfBold = selectedIndex >= 0 && i <= selectedIndex
        const bottomHalfBold = selectedIndex >= 0 && i < selectedIndex
        const stubBold = i === selectedIndex
        const boldColor = 'var(--text-color)'
        const thinColor = 'var(--border-color)'
        // Bold lines are 2px (down from 3) — still clearly heavier
        // than the 1px thin lines but less eye-catching against the
        // sidebar bg.
        const topHalfThickness = topHalfBold ? 2 : 1
        const bottomHalfThickness = bottomHalfBold ? 2 : 1
        const stubThickness = stubBold ? 2 : 1
        // Stub left edge is anchored to the top-half's left edge so
        // the L-corner fills cleanly when both are bold. When the
        // stub is thin and the top-half is bold, the thin stub's
        // overlap with the top-half is hidden by the top-half's
        // higher z-index (see below) — only the part of the stub
        // outside the top-half column is visible, which is what we
        // want for "this row exists but isn't selected".
        const stubLeft = treeStartX - topHalfThickness / 2
        return (
          <div
            key={id}
            className={`d-flex align-items-center py-1 ${isSelected ? '' : 'hoverbg'} pointer position-relative`}
            style={{
              paddingLeft: `${treeStubEnd + 4}px`,
              paddingRight: '0.5rem',
              ...(isSelected
                ? {
                    backgroundColor: 'var(--tertiary-bg)',
                    color: 'var(--text-color)',
                  }
                : {}),
            }}
            onClick={() => onSelect(id)}
            title={networkLabel}
          >
            {/* All line positions snap to integer pixels via
                Math.floor so a 1px line never lands on a half-pixel
                (where the browser would smear it across two pixels
                via anti-aliasing — the visible result was thin lines
                appearing ~2px wide and fuzzier than their selected
                2px siblings). Slight off-center vs the geometric
                centerline is cheaper than the blur it replaces. */}
            <div
              style={{
                position: 'absolute',
                left: `${Math.floor(treeStartX - topHalfThickness / 2)}px`,
                top: 0,
                height: '50%',
                width: topHalfThickness,
                backgroundColor: topHalfBold ? boldColor : thinColor,
                zIndex: topHalfBold ? 2 : 1,
              }}
            />
            {!isLast && (
              <div
                style={{
                  position: 'absolute',
                  left: `${Math.floor(treeStartX - bottomHalfThickness / 2)}px`,
                  top: '50%',
                  bottom: 0,
                  width: bottomHalfThickness,
                  backgroundColor: bottomHalfBold ? boldColor : thinColor,
                  zIndex: bottomHalfBold ? 2 : 1,
                }}
              />
            )}
            <div
              style={{
                position: 'absolute',
                left: `${Math.floor(stubLeft)}px`,
                top: `calc(50% - ${Math.floor(stubThickness / 2)}px)`,
                width: `${treeStubEnd - Math.floor(stubLeft)}px`,
                height: stubThickness,
                backgroundColor: stubBold ? boldColor : thinColor,
                zIndex: stubBold ? 2 : 1,
              }}
            />
            {/* Row reads as: tree → chain logo → chain-link glyph →
                share-of-group-balance. The chain-link glyph is a
                generic "this is a blockchain/network" indicator
                (visual rhyme with the word "chain"); the specific
                network is identified by the logo to its left, and
                the full chain name still surfaces on hover via the
                row's `title` attr above. */}
            <img
              src={logoPath((parentAsset ?? a).symbol)}
              alt={networkLabel}
              width={18}
              height={18}
              className="me-1"
            />
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              className="grey"
              aria-hidden="true"
            >
              {/* Three connected blocks — a literal "blockchain"
                  glyph. Two short connector lines link adjacent
                  blocks so the trio reads as "linked blocks", not
                  "three independent boxes". */}
              <rect x="2" y="9" width="6" height="6" rx="1" />
              <rect x="9" y="9" width="6" height="6" rx="1" />
              <rect x="16" y="9" width="6" height="6" rx="1" />
              <line x1="8" y1="12" x2="9" y2="12" />
              <line x1="15" y1="12" x2="16" y2="12" />
            </svg>
            <span className="flex-grow-1" />
            {creatingTokenIDs.has(id) && (
              <span className="ico-spinner spinner fs12 me-1 grey" />
            )}
            <span className="fs18">{balanceText}</span>
          </div>
        )
      })}
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
  // WP-15: whether to render the Bridge button. Computed by the
  // parent from the global bridge topology + the selected ticker's
  // network siblings.
  hasBridge: boolean
}

function WalletDetail ({
  asset, wallet, assets, fiatRatesMap,
  setActiveForm, hasBridge
}: WalletDetailProps) {
  const { t } = useTranslation()
  const bal = wallet.balance
  const ui = asset.unitInfo
  const fiatRate = fiatRatesMap[asset.id] ?? 0
  const parentAsset = asset.token
    ? assets[asset.token.parentID]
    : null

  const isTicketBuyer = (wallet.traits & traitTicketBuyer) !== 0 && asset.id === DCRAssetID
  const isMixer = (wallet.traits & traitFundsMixer) !== 0

  const totalBal = bal.available + bal.locked + bal.immature

  return (
    <div>
      {/* ---- Header: Logo + asset name + total balance ---- */}
      <section>
        <div className="d-flex justify-content-between align-items-start p-3">
          <div className="flex-center">
            <img src={logoPath(asset.symbol)} alt={asset.symbol} className="large-icon" />
            <div className="ms-2 d-flex flex-column">
              <div className="fs24 demi lh1">{asset.name}</div>
              {/* For token wallets, surface the parent network so the
                  user knows whether they're looking at e.g. USDC.ETH
                  vs USDC.POL — the sidebar tree-glyphs only show the
                  network icon, so this is the canonical "what am I
                  looking at" indicator on the right-side view. */}
              {parentAsset && (
                <div className="d-flex align-items-center fs14 grey lh1 mt-1">
                  <span className="me-1">{t('ON_NETWORK', { network: parentAsset.name })}</span>
                  <img
                    src={logoPath(parentAsset.symbol)}
                    alt={parentAsset.name}
                    width={14}
                    height={14}
                  />
                </div>
              )}
            </div>
            {/* LI-ASYNC Batch 9: transient indicator while the selected
                wallet is mid-connect (`!disabled && !running`). The
                `wallet` prop flips because `useMarketStore.handleWalletStateNote`
                publishes a new `assets[id]` ref on every `walletstate`
                note (see CL-ASSETS-STALE-MEMO), so the parent re-renders
                with the fresh `running` bool. */}
            {walletConnecting(wallet) && (
              <span
                className="ico-spinner spinner fs14 ms-2"
                title={t('CONNECTING_WALLET', { asset: shortSymbol(asset.symbol) })}
              />
            )}
          </div>
          <div className="d-flex flex-column justify-content-end">
            <div className="d-flex align-items-end lh1">
              <span className="fs28 me-1">{formatCoinAtom(totalBal, ui)}</span>
              <span className="fs20 grey">{ui.conventional.unit}</span>
            </div>
            {fiatRate > 0 && (
              <div className="mt-1 lh1 grey fs15 d-flex justify-content-end align-items-center">
                ~${formatFiat(atomToConventional(totalBal, ui) * fiatRate)}
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
                <td>{formatCoinAtom(bal.available, ui)}</td>
                <td>{formatCoinAtom(bal.locked, ui)}</td>
                <td>{formatCoinAtom(bal.immature, ui)}</td>
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
              <span>{t('Orders')}: {formatCoinAtom(bal.orderlocked, ui)}</span>
            )}
            {bal.bondlocked > 0 && (
              <span>{t('Bonds')}: {formatCoinAtom(bal.bondlocked, ui)}</span>
            )}
            {bal.contractlocked > 0 && (
              <span>{t('Contracts')}: {formatCoinAtom(bal.contractlocked, ui)}</span>
            )}
          </div>
        )}

        {bal.reservesDeficit > 0 && (
          <div className="px-2 py-1 fs14 text-warning">
            {t('RESERVES_DEFICIT')}: {formatCoinAtom(bal.reservesDeficit, ui)}
          </div>
        )}

        {/* Parent asset balance for tokens */}
        {parentAsset && parentAsset.wallet && (
          <div className="px-2 py-1 border-top">
            <div className="d-flex align-items-center gap-2 fs14 grey pt-1">
              <img src={logoPath(parentAsset.symbol)} alt={parentAsset.symbol} className="micro-icon" />
              <span>
                {parentAsset.unitInfo.conventional.unit}{' '}
                {t('FEE_BALANCE')}: {formatCoinAtom(parentAsset.wallet.balance.available, parentAsset.unitInfo)}
              </span>
            </div>
          </div>
        )}

        {/* Other/custom balances */}
        {bal.other && Object.keys(bal.other).length > 0 && (
          <div className="px-2 py-1 border-top">
            {Object.entries(bal.other).map(([label, cb]) => (
              <div key={label} className="fs14 grey pt-1">
                {label}: {formatCoinAtom(cb.amt, ui)}
                {cb.locked
                  ? ` (${t('LOCKED')})`
                  : ''}
              </div>
            ))}
          </div>
        )}

        {/* ---- Receive / Send / Bridge buttons ---- */}
        <div className="d-flex align-items-stretch border-top">
          <div
            className="flex-grow-1 flex-center p-2 pointer hoverbg border-end"
            onClick={() => setActiveForm('receive')}
          >
            <span className="ico-qrcode fs15 me-1"></span>
            <span className="fs20">{t('Receive')}</span>
          </div>
          <button
            className={`flex-grow-1 flex-center p-2 noborder${hasBridge ? ' border-end' : ''}`}
            onClick={() => setActiveForm('send')}
            disabled={!wallet.open}
          >
            <span className="ico-send me-1"></span>
            <span className="fs20">{t('Send')}</span>
          </button>
          {/* WP-15: bridge button. Vanilla `wallets.tmpl` renders
              this next to Send/Receive inside the same flex row, gated
              on `hasBridgingSupport()`. */}
          {hasBridge && (
            <button
              className="flex-grow-1 flex-center p-2 noborder"
              onClick={() => setActiveForm('bridge')}
              disabled={!wallet.open}
            >
              <span className="ico-exchange me-1"></span>
              <span className="fs20">{t('BRIDGE')}</span>
            </button>
          )}
        </div>
      </section>

      {/* ---- Exchange Rate ---- */}
      {fiatRate > 0 && (
        <section className="flex-stretch-column">
          <div className="flex-center py-2 fs15 demi">{t('EXCHANGE_RATE')}</div>
          <div className="mx-2 border-bottom"></div>
          <div className="flex-grow-1 flex-center py-2">
            {/* Single span keeps the $ and digits on the same baseline
                / font size — splitting them caused a visible
                misalignment in flex centering. */}
            <span className="fs22 demi lh1">${formatFiat(fiatRate)}</span>
          </div>
        </section>
      )}

      {/* ---- Transaction Fees ---- */}
      {wallet.feeState && (
        <section className="flex-stretch-column">
          <div className="flex-center py-2 fs18 demi">{t('TRANSACTION_FEES')}</div>
          <div className="mx-2 border-bottom"></div>
          <div className="d-flex">
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Send')}</span>
              <span className="fs20 lh1">
                {fiatRate > 0 ? `$${formatFiat(atomToConventional(wallet.feeState.send, ui) * fiatRate)}` : '—'}
              </span>
              <div className="fs14 grey">{formatCoinAtom(wallet.feeState.send, ui)}</div>
            </div>
            <div className="my-2 border-end"></div>
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Sell')}</span>
              <span className="fs20 lh1">
                {fiatRate > 0 ? `$${formatFiat(atomToConventional(wallet.feeState.swap, ui) * fiatRate)}` : '—'}
              </span>
              <div className="fs14 grey">{formatCoinAtom(wallet.feeState.swap, ui)}</div>
            </div>
            <div className="my-2 border-end"></div>
            <div className="flex-grow-1 d-flex flex-column align-items-center p-2">
              <span className="fs16 demi">{t('Buy')}</span>
              <span className="fs20 lh1">
                {fiatRate > 0 ? `$${formatFiat(atomToConventional(wallet.feeState.redeem, ui) * fiatRate)}` : '—'}
              </span>
              <div className="fs14 grey">{formatCoinAtom(wallet.feeState.redeem, ui)}</div>
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
          assetID={DCRAssetID}
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
        <span className="fs18">{t('TRANSACTION_HISTORY')}</span>
      </div>

      {/* Sync status */}
      {!wallet.synced && wallet.syncStatus && (
        <div className="p-2 fs14 grey border-top">
          {t('SYNC_PROGRESS')}: {(wallet.syncProgress * 100).toFixed(1)}%
          {' '}({wallet.syncStatus.blocks}/{wallet.syncStatus.targetHeight} {t('BLOCKS')})
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
          ? <span>{t('NO_PENDING_TRANSACTIONS')}</span>
          : <span>
              <span>{txs.length}</span>{' '}
              <span>{t('PENDING_TRANSACTIONS')}</span>{' '}
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
                        : `${sign}${formatCoinAtom(tx.amount, ui)}`}
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
        <div className="flex-center p-2 mb-3 mx-3 fs18 border">{t('NO_MARKETS')}</div>
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
                const bui = baseAsset?.unitInfo
                const qui = quoteAsset?.unitInfo
                const spotPriceConv = row.spot
                  ? conventionalRate(row.baseID, row.quoteID, row.spot.rate, assets)
                  : 0
                const vol24Atoms = row.spot?.vol24 ?? 0
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
                        {shortSymbol(row.baseSymbol)}-{shortSymbol(row.quoteSymbol)}
                      </span>
                    </td>
                    <td className="d-none d-md-table-cell d-lg-none d-xxl-table-cell">
                      <div className="short-host text-nowrap overflow-hidden">{row.host}</div>
                    </td>
                    <td>
                      {spotPriceConv > 0 && bui && qui
                        ? <>
                            <span>{formatRateToRateStep(spotPriceConv, bui, qui, row.ratestep)}</span>
                            <span className="fs13 grey">
                              <sup>{qui.conventional.unit}</sup>/<sub>{bui.conventional.unit}</sub>
                            </span>
                          </>
                        : '-'}
                    </td>
                    <td className="text-end">
                      {vol24Atoms > 0 && bui
                        ? <>
                            <span>{formatCoinAtomToLotSizeBaseCurrency(vol24Atoms, bui, row.lotsize)}</span>
                            <span className="fs15 grey ms-1">{bui.conventional.unit}</span>
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
            <span>{t('LOADING_PRIVACY_STATUS')}</span>
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
                <span>{t('PRIVACY_ACTIVE')}</span>
              </div>
            : <div className="flex-center fs20">
                <span className="on-indicator off me-2" style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: 'var(--text-grey)', display: 'inline-block' }}></span>
                <span>{t('PRIVACY_OFF')}</span>
              </div>}
        </div>
        {/* WP-18: privacy info button. Click opens a modal explaining
            CoinShuffle++ / StakeShuffle. Mirrors vanilla
            `privacyInfoBttn` (`wallets.tmpl` L392). */}
        <button
          type="button"
          className="btn flex-center p-3 border-0 border-start rounded-0 fs24 ico-info hoverbg"
          onClick={() => setShowInfo(true)}
          aria-label={t('PRIVACY_INFO')}
          title={t('PRIVACY_INFO')}
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
      <FormOverlay bare show={showInfo} onClose={() => setShowInfo(false)}>
        <div className="bg-body border rounded p-4" style={{ maxWidth: 425 }}>
          <ul className="ps-3 mb-0">
            <li className="mb-2">{t('PRIVACY_INTRO')}</li>
            <li className="mb-2">{t('CSPP_HOW')}</li>
            <li className="mb-2">{t('DECRED_PRIVACY')}</li>
            <li className="mb-2">{t('PRIVACY_OPTIONAL')}</li>
            <li>{t('PRIVACY_UNLOCKED')}</li>
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
      setError(t('PLEASE_ENTER_AN_ADDRESS'))
      return
    }
    const value = Math.round(parseFloat(amtStr || '0') * conv)
    if (value <= 0) {
      setError(t('PLEASE_ENTER_A_VALID_AMOUNT'))
      return
    }

    // Validate address first
    const valRes = await postJSON('/api/validateaddress', { addr, assetID: asset.id })
    if (!checkResponse(valRes)) {
      setError(t('INVALID_ADDRESS'))
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
        setFeeErr(feeRes.msg || t('FEE_ESTIMATION_FAILED'))
        // Still proceed to confirm without fee estimate
      } else if (!feeRes.validaddress) {
        setError(t('INVALID_ADDRESS'))
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
      setError(t('PASSWORD_IS_REQUIRED'))
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
      setError(res.msg || t('SEND_FAILED'))
      return
    }
    onSuccess()
  }, [addr, amtStr, asset.id, conv, onSuccess, password, subtract, t])

  const valueAtoms = Math.round(parseFloat(amtStr || '0') * conv)

  if (step === 'confirm') {
    return (
      <div>
        <div className="fs18 mb-3">{t('CONFIRM_SEND')}</div>
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
          {formatCoinAtom(valueAtoms, ui)}
          {rate > 0 && (
            <span className="text-secondary"> (${formatFiat(atomToConventional(valueAtoms, ui) * rate)})</span>
          )}
        </div>
        {txFee > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('ESTIMATED_FEE')}:</span>{' '}
            {formatCoinAtom(txFee, feeUI)}
            {feeRate > 0 && (
              <span className="text-secondary"> (${formatFiat(atomToConventional(txFee, feeUI) * feeRate)})</span>
            )}
          </div>
        )}
        {feeErr && (
          <div className="fs12 text-warning mb-2">{t('FEE_ESTIMATE_UNAVAILABLE')}: {feeErr}</div>
        )}
        <div className="mb-2 fs14">
          <span className="text-secondary">{t('BALANCE_AFTER_SEND')}:</span>{' '}
          {formatCoinAtom(
            Math.max(0, wallet.balance.available - valueAtoms - (token ? 0 : txFee)),
            ui
          )}
        </div>

        <div className="mb-3">
          <label className="form-label fs14">{t('APP_PASSWORD')}</label>
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
          placeholder={t('RECIPIENT_ADDRESS')}
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
            ~${formatBestWeCan(parseFloat(amtStr || '0') * rate, 2)}
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
          {t('Max')}: {formatCoinAtom(wallet.balance.available, ui)}
        </span>
      </div>

      <label className="d-block fs12 mb-3">
        <input
          type="checkbox"
          className="me-1"
          checked={subtract}
          onChange={e => setSubtract(e.target.checked)}
        />
        {t('SUBTRACT_FEE_FROM_AMOUNT')}
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
          <span className="fs18">{t('TRANSACTION_DETAILS')}</span>
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
            {formatCoinAtom(detailTx.amount, ui)}
          </div>
        )}
        {detailTx.fees > 0 && (
          <div className="mb-2 fs14">
            <span className="text-secondary">{t('Fees')}:</span>{' '}
            {formatCoinAtom(detailTx.fees, ui)}
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
              <span className="text-secondary">{t('BOND_ID')}:</span>{' '}
              <code className="text-break fs12">{detailTx.bondInfo.bondID}</code>
            </div>
            <div className="mb-2 fs14">
              <span className="text-secondary">{t('LOCK_TIME')}:</span>{' '}
              {new Date(detailTx.bondInfo.lockTime * 1000).toLocaleString()}
            </div>
          </>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-outline-primary mt-2">
            {t('VIEW_IN_EXPLORER')}
          </a>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="fs18 mb-3">{t('TRANSACTION_HISTORY')}</div>

      {loading && txs.length === 0 && (
        <div className="text-center py-3">
          <span className="spinner-border spinner-border-sm" />
        </div>
      )}

      {!loading && txs.length === 0 && (
        <div className="text-center py-3 text-secondary fs14">{t('NO_TRANSACTIONS')}</div>
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
                      : `${sign}${formatCoinAtom(tx.amount, ui)}`}
                  </td>
                  <td>{tx.fees > 0
                    ? formatCoinAtom(tx.fees, ui)
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
          {t('VIEW_ALL')}
        </Link>
      </div>

      {loading && (
        <div className="text-center py-3">
          <span className="ico-spinner spinner me-2"></span>
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="flex-center p-2 mb-3 mx-3 fs18 border">{t('NO_RECENT_ACTIVITY')}</div>
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
                ? formatCoinAtom(ord.qty, baseUI)
                : String(ord.qty)
              return (
                <tr key={ord.id || ord.stamp}>
                  <td className="text-nowrap">
                    {ord.sell
                      ? <>
                          <span>{qtyStr}</span>
                          <img src={logoPath(ord.baseSymbol)} alt={ord.baseSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{shortSymbol(ord.baseSymbol)}</span>
                          <span>&rarr;</span>
                          <img src={logoPath(ord.quoteSymbol)} alt={ord.quoteSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{shortSymbol(ord.quoteSymbol)}</span>
                        </>
                      : <>
                          <img src={logoPath(ord.quoteSymbol)} alt={ord.quoteSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{shortSymbol(ord.quoteSymbol)}</span>
                          <span>&rarr;</span>
                          <span>{qtyStr}</span>
                          <img src={logoPath(ord.baseSymbol)} alt={ord.baseSymbol} className="micro-icon mx-1" />
                          <span className="d-none d-md-inline">{shortSymbol(ord.baseSymbol)}</span>
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
                      aria-label={t('VIEW_ORDER')}
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

function WalletConfigView ({ asset, wallet, onClose, setActiveForm, setPendingForce }: {
  asset: SupportedAsset
  wallet: WalletState
  onClose: () => void
  // WP-19: form-stack navigation for the "Other Actions" buttons. The
  // config view closes itself and opens a sibling modal so each action
  // is its own focused form, mirroring vanilla's `forms.show()` pattern.
  setActiveForm: (f: string | null) => void
  // Used by the WP-06/rescan force-confirm flow: when the underlying
  // request fails with `activeOrdersErr` we stash the URL + body here
  // so the shared ConfirmForce modal can re-issue with `force: true`.
  setPendingForce: (p: PendingForce | null) => void
}) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const exchanges = useAuthStore(s => s.user?.exchanges)
  const subformRef = useRef<WalletConfigFormHandle>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // pendingConfig holds the fetched settings until the WalletConfigForm
  // is mounted (it lives inside the `!loading` gate, so the ref is null
  // during the fetch). A separate effect (below) flushes it via the
  // imperative handle once the form has rendered.
  const [pendingConfig, setPendingConfig] = useState<Record<string, string> | null>(null)

  // Resolve the wallet definition matching the wallet's current type.
  // Tokens have a single `definition`; non-token assets pick from
  // `info.availablewallets`. The reconfig modal does not support
  // switching wallet types, so this is computed once per (asset, type).
  const walletDef = useMemo<WalletDefinition | undefined>(() => {
    if (asset.token) return asset.token.definition
    return asset.info?.availablewallets.find(d => d.type === wallet.type)
  }, [asset.info, asset.token, wallet.type])
  const configOpts = walletDef?.configopts ?? []
  // disablewhenactive options must be locked while orders are in flight,
  // matching legacy `app.ts:haveActiveOrders` semantics.
  const activeOrders = useMemo(
    () => haveActiveOrders(exchanges, asset.id),
    [exchanges, asset.id]
  )

  // WP-19: trait-gated visibility for the "Other Actions" section.
  // Mirrors vanilla `wallets.ts` `showReconfig()` L2298-2305. The
  // section header is shown only when at least one button below would
  // be rendered (`traitsExtraOpts` mask covers all traits).
  const isRescanner = (wallet.traits & traitRescanner) !== 0
  const isLogFiler = (wallet.traits & traitLogFiler) !== 0
  const isRecoverer = (wallet.traits & traitRecoverer) !== 0
  const isRestorer = (wallet.traits & traitRestorer) !== 0
  const isPeerManager = (wallet.traits & traitPeerManager) !== 0
  // WP-16: token approver. Only show the "Disallow Token" button
  // when the wallet implements the trait AND isn't disabled (vanilla
  // L2303: `traitTokenApprover && !wallet.disabled`).
  const isTokenApprover = (wallet.traits & traitTokenApprover) !== 0 && !wallet.disabled
  const hasExtraOpts = (wallet.traits & traitsExtraOpts) !== 0

  // Fetch the wallet's saved settings. The actual handoff to
  // WalletConfigForm happens in the post-mount effect below — calling
  // setLoadedConfig inline here would no-op because the form (and its
  // ref) only mount after `loading` flips false.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const res = await postJSON('/api/walletsettings', { assetID: asset.id })
      if (cancelled) return
      if (!checkResponse(res)) {
        setLoading(false)
        setError(res.msg || 'Failed to load settings')
        return
      }
      setPendingConfig(res.map ?? {})
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [asset.id])

  // Flush fetched settings into WalletConfigForm via its imperative
  // handle. Effects run after commit, so by the time this fires the
  // form (rendered on the same commit that flipped `loading` to false)
  // is mounted and the ref is populated. The schema-driven form
  // ignores any keys not declared in configOpts — including stray
  // special_* flags — so internal plumbing can't surface here.
  useEffect(() => {
    if (!pendingConfig || !subformRef.current) return
    subformRef.current.setLoadedConfig(pendingConfig)
    setPendingConfig(null)
  }, [pendingConfig])

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
      setSuccess(t('WALLET_LOCKED'))
    } else {
      const res = await postJSON('/api/openwallet', { assetID: asset.id })
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to unlock wallet')
        return
      }
      await fetchUser()
      setSuccess(t('WALLET_UNLOCKED_MSG'))
    }
  }, [asset.id, fetchUser, t, wallet.open])

  const handleRescan = useCallback(async () => {
    setError('')
    setSuccess('')
    const url = '/api/rescanwallet'
    const req = { assetID: asset.id }
    const res = await postJSON(url, req)
    // WP-19: vanilla `wallets.ts` `rescanWallet()` (L2222) routes
    // active-orders failures into the shared confirmForce form so the
    // user can re-submit with `force: true`. Match that here.
    if (res.code === Errors.activeOrdersErr) {
      setPendingForce({ url, req })
      onClose()
      setActiveForm('confirmForce')
      return
    }
    if (!checkResponse(res)) {
      setError(res.msg || 'Rescan failed')
      return
    }
    setSuccess(t('RESCAN_STARTED_MSG'))
  }, [asset.id, onClose, setActiveForm, setPendingForce, t])

  // WP-08: download wallet log file. Vanilla `downloadLogs()` (L2609)
  // builds a `/wallets/logfile?assetid=N` URL and opens it in a new tab
  // (or replaces self when running inside the desktop wrapper).
  const handleDownloadLogs = useCallback(() => {
    const url = new URL(window.location.href)
    url.search = `?assetid=${asset.id}`
    url.pathname = '/wallets/logfile'
    const w = window as { electron?: unknown; isWebview?: unknown }
    if (w.electron !== undefined || w.isWebview !== undefined) {
      window.open(url.toString(), '_self')
    } else {
      window.open(url.toString())
    }
  }, [asset.id])

  const handleSave = useCallback(async () => {
    setError('')
    setSuccess('')
    setSaving(true)
    const config = subformRef.current?.getConfigMap(asset.id) ?? {}
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
    setSuccess(t('SETTINGS_SAVED'))
  }, [asset.id, fetchUser, t, wallet.type])

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
            <span className="text-secondary">{t('WALLET_TYPE')}:</span> {wallet.type || 'Default'}
          </div>

          {/* Schema-driven config form. Renders only options declared in
              the wallet's WalletDefinition.configopts, so internally-injected
              "special_*" flags (or any other server-side bookkeeping) cannot
              appear as user-editable fields. */}
          <WalletConfigForm
            ref={subformRef}
            assetID={asset.id}
            configOpts={configOpts}
            activeOrders={activeOrders}
            showFileSelector={!walletDef?.seeded && !asset.token}
          />

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
            <button
              className="btn btn-secondary btn-sm ms-auto"
              onClick={onClose}
            >
              {t('Close')}
            </button>
          </div>

          {/* WP-19: "Other Actions" section. Mirrors vanilla
              `wallets.tmpl` L761-771 + `wallets.ts` `showReconfig()`
              L2298-2305 trait-gated visibility. The header is hidden
              when no extra-action trait is set. Manage Peers is also
              shown here (vanilla puts it in a separate "network
              actions" modal, but the React UI has only the gear icon
              entry point so we host it next to the other per-wallet
              actions for parity coverage). */}
          {hasExtraOpts && (
            <>
              <div className="fs15 mt-3 pt-2 border-top text-secondary">
                {t('OTHER_ACTIONS')}
              </div>
              <div className="d-flex flex-wrap gap-2 mt-2">
                {isLogFiler && (
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={handleDownloadLogs}
                  >
                    {t('WALLET_LOGS')}
                  </button>
                )}
                {/* WP-16: Disallow Token button — gated on
                    `traitTokenApprover && !wallet.disabled`. Opens
                    the token-versions-table modal listing every
                    approved swap-contract version with a Remove icon
                    per row. Mirrors vanilla `wallets.ts` L396 +
                    `showUnapproveTokenAllowanceTableForm()` (L718). */}
                {isTokenApprover && (
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => {
                      onClose()
                      setActiveForm('unapproveTokenTable')
                    }}
                  >
                    {t('DISALLOW_TOKEN')}
                  </button>
                )}
                {isRestorer && (
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => {
                      onClose()
                      setActiveForm('exportWalletAuth')
                    }}
                  >
                    {t('EXPORT_WALLET')}
                  </button>
                )}
                {isPeerManager && (
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => {
                      onClose()
                      setActiveForm('managePeers')
                    }}
                  >
                    {t('MANAGE_PEERS')}
                  </button>
                )}
                {isRescanner && (
                  <button
                    className="btn btn-outline-danger btn-sm"
                    onClick={handleRescan}
                  >
                    {t('Rescan')}
                  </button>
                )}
                {isRecoverer && (
                  <button
                    className="btn btn-outline-danger btn-sm"
                    onClick={() => {
                      onClose()
                      setActiveForm('recoverWallet')
                    }}
                  >
                    {t('RECOVER')}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-06: RecoverWalletConfirm
// ---------------------------------------------------------------------------

function RecoverWalletConfirm ({ assetID, onClose, onForceNeeded }: {
  assetID: number
  onClose: () => void
  // Called when the underlying request returns `activeOrdersErr`. The
  // parent stashes the URL + body into pendingForce and switches to the
  // confirmForce modal.
  onForceNeeded: (url: string, req: PendingForce['req']) => void
}) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = useCallback(async () => {
    setError('')
    setSubmitting(true)
    const url = '/api/recoverwallet'
    const req = { assetID }
    const res = await postJSON(url, req)
    setSubmitting(false)
    if (res.code === Errors.activeOrdersErr) {
      onForceNeeded(url, req)
      return
    }
    if (!checkResponse(res)) {
      setError(res.msg || 'Recover failed')
      return
    }
    onClose()
  }, [assetID, onClose, onForceNeeded])

  return (
    <div>
      <div className="fs18 mb-3">{t('RECOVER_WALLET')}</div>
      <div className="fs14 mb-3">{t('RECOVER_WARNING')}</div>
      {error && <div className="text-danger fs14 mb-2">{error}</div>}
      <div className="d-flex gap-2">
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting}
        >
          {submitting
            ? '...'
            : t('Submit')}
        </button>
        <button
          className="btn btn-secondary ms-auto"
          onClick={onClose}
          disabled={submitting}
        >
          {t('CANCEL')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-07: ExportWalletAuth (password prompt) → RestoreWalletInfo
// ---------------------------------------------------------------------------

function ExportWalletAuth ({ assetID, onClose, onSuccess }: {
  assetID: number
  onClose: () => void
  onSuccess: (info: WalletRestoration[]) => void
}) {
  const { t } = useTranslation()
  const [pw, setPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = useCallback(async () => {
    setError('')
    setSubmitting(true)
    const res = await postJSON('/api/restorewalletinfo', { assetID, pass: pw })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Restore info request failed')
      return
    }
    setPw('')
    onSuccess(res.restorationinfo as WalletRestoration[])
  }, [assetID, onSuccess, pw])

  return (
    <div>
      <div className="fs18 mb-3">{t('EXPORT_WALLET')}</div>
      <div className="fs14 mb-2">{t('PW_FOR_WALLET_SEED')}</div>
      {/* Vanilla `wallets.tmpl` L909 uses an HTML span with a
          warning class; we render the same translation string. The
          translation key is full sentence + class markup, but
          react-i18next doesn't interpolate HTML by default so we
          render the raw text. The danger color comes from the wrapper. */}
      <div className="fs14 text-warning mb-3">{t('EXPORT_WALLET_DISCLAIMER')}</div>
      <div className="mb-3">
        <label className="form-label fs14">{t('Password')}</label>
        <input
          type="password"
          className="form-control form-control-sm"
          value={pw}
          autoComplete="current-password"
          autoFocus
          onChange={e => setPw(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>
      {error && <div className="text-danger fs14 mb-2">{error}</div>}
      <div className="d-flex gap-2">
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting || !pw}
        >
          {submitting
            ? '...'
            : t('SHOW_ME')}
        </button>
        <button
          className="btn btn-secondary ms-auto"
          onClick={onClose}
          disabled={submitting}
        >
          {t('CANCEL')}
        </button>
      </div>
    </div>
  )
}

function RestoreWalletInfo ({ info, onClose }: {
  info: WalletRestoration[]
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <div>
      <div className="fs18 mb-3">{t('EXPORT_WALLET')}</div>
      <div className="fs14 mb-2">{t('EXPORT_WALLET_MSG')}</div>
      <div className="fs14 text-danger mb-3">
        <strong><u>{t('CLIPBOARD_WARNING')}</u></strong>
      </div>
      <div className="mt-3 border-top pt-3">
        {info.map((wr, idx) => (
          <div key={idx} className="mb-3 pb-3 border-bottom">
            <div className="fs20 demi text-decoration-underline">{wr.target}</div>
            <div className="fs14 mt-1">{wr.seedName}</div>
            <div className="d-flex align-items-start gap-2 mt-1">
              <span className="mono fs14 text-break flex-grow-1">{wr.seed}</span>
              <CopyButton text={wr.seed} />
            </div>
            <div className="fs14 mt-2">{t('INSTRUCTIONS')}</div>
            <div className="fs14 text-break" style={{ whiteSpace: 'pre-line' }}>{wr.instructions}</div>
          </div>
        ))}
      </div>
      <div className="d-flex">
        <button className="btn btn-secondary ms-auto" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-09: ManagePeers
// ---------------------------------------------------------------------------

function ManagePeers ({ assetID, onClose }: {
  assetID: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [peers, setPeers] = useState<WalletPeer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [addAddr, setAddAddr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // T18#8: set of peer addresses currently being removed. Gates
  // duplicate-click POSTs so the user can't fire N parallel
  // /api/removewalletpeer requests for the same row, each with its
  // own last-one-wins refresh(). Using a Set keeps the state
  // O(removing count) without an object-per-row allocation.
  const [removingAddrs, setRemovingAddrs] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setError('')
    setLoading(true)
    const res = await postJSON('/api/getwalletpeers', { assetID })
    setLoading(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to load peers')
      return
    }
    const list: WalletPeer[] = res.peers || []
    // Vanilla sorts by source ascending so default-discovered-added
    // groups stay together.
    list.sort((a, b) => a.source - b.source)
    setPeers(list)
  }, [assetID])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sourceLabel = useCallback((src: PeerSource): string => {
    switch (src) {
      case PeerSource.WalletDefault: return t('DEFAULT')
      case PeerSource.UserAdded: return t('ADDED')
      case PeerSource.Discovered: return t('DISCOVERED')
      default: return ''
    }
  }, [t])

  const addPeer = useCallback(async () => {
    if (!addAddr.trim()) return
    setError('')
    setSubmitting(true)
    const res = await postJSON('/api/addwalletpeer', { assetID, addr: addAddr.trim() })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to add peer')
      return
    }
    setAddAddr('')
    refresh()
  }, [addAddr, assetID, refresh])

  const removePeer = useCallback(async (addr: string) => {
    // T18#8: dedupe concurrent removal attempts on the same address.
    // If a previous POST for this addr is already in flight, bail
    // out. Using functional setState to avoid stale-closure reads
    // of removingAddrs if the user rapid-fire clicks different peers.
    let skip = false
    setRemovingAddrs(prev => {
      if (prev.has(addr)) {
        skip = true
        return prev
      }
      const next = new Set(prev)
      next.add(addr)
      return next
    })
    if (skip) return

    setError('')
    try {
      const res = await postJSON('/api/removewalletpeer', { assetID, addr })
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to remove peer')
        return
      }
      refresh()
    } finally {
      setRemovingAddrs(prev => {
        const next = new Set(prev)
        next.delete(addr)
        return next
      })
    }
  }, [assetID, refresh])

  return (
    <div className="d-flex flex-column">
      <div className="fs18 mb-3">{t('MANAGE_PEERS')}</div>

      {loading && (
        <div className="text-center py-3">
          <span className="ico-spinner spinner fs15"></span>
        </div>
      )}

      {!loading && (
        <table className="compact row-border">
          <thead className="unbold fs15">
            <tr>
              <th>{t('ADDRESS')}</th>
              <th>{t('SOURCE')}</th>
              <th>{t('CONNECTED')}</th>
              <th>{t('Remove')}</th>
            </tr>
          </thead>
          <tbody>
            {peers.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center grey py-2">—</td>
              </tr>
            )}
            {peers.map(p => (
              <tr key={`${p.source}-${p.addr}`}>
                <td className="text-break">{p.addr}</td>
                <td>{sourceLabel(p.source)}</td>
                <td>
                  {p.connected
                    ? <span className="ico-check text-success" title={t('CONNECTED')}></span>
                    : <span className="ico-cross text-danger" title={t('NOT_CONNECTED')}></span>}
                </td>
                <td>
                  {p.source === PeerSource.UserAdded && (
                    removingAddrs.has(p.addr)
                      ? <span className="ico-spinner spinner fs14"></span>
                      : <span
                          className="ico-cross pointer text-danger"
                          title={t('Remove')}
                          onClick={() => removePeer(p.addr)}
                        ></span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="d-flex gap-2 mt-3">
        <input
          type="text"
          className="form-control form-control-sm flex-grow-1"
          placeholder={t('ENTER_PEER_ADDRESS')}
          value={addAddr}
          onChange={e => setAddAddr(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') addPeer()
          }}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={addPeer}
          disabled={submitting || !addAddr.trim()}
        >
          {t('ADD_PEER')}
        </button>
      </div>

      {error && <div className="text-danger fs14 mt-2">{error}</div>}

      <div className="d-flex mt-3">
        <button className="btn btn-secondary btn-sm ms-auto" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared force-confirm modal (recover + rescan)
// ---------------------------------------------------------------------------

function ConfirmForce ({ pending, onClose }: {
  pending: PendingForce
  onClose: () => void
}) {
  const { t } = useTranslation()
  const fetchUser = useAuthStore(s => s.fetchUser)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = useCallback(async () => {
    setError('')
    setSubmitting(true)
    // Vanilla `wallets.ts` `confirmForceSubmit()` (L2700) re-issues the
    // stashed request with `force: true`.
    const res = await postJSON(pending.url, { ...pending.req, force: true })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setError(res.msg || 'Submit failed')
      return
    }
    await fetchUser()
    onClose()
  }, [fetchUser, onClose, pending])

  return (
    <div>
      <div className="fs20 mb-2 text-center">{t('WALLET_ACTIVELY_USED')}</div>
      <div className="fs14 mb-3">{t('CONFIRM_FORCE_MESSAGE')}</div>
      {error && <div className="text-danger fs14 mb-2">{error}</div>}
      <div className="d-flex gap-2 justify-content-end">
        <button
          className="btn btn-outline-danger btn-sm"
          onClick={onClose}
          disabled={submitting}
        >
          {t('CANCEL')}
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={submit}
          disabled={submitting}
        >
          {submitting
            ? '...'
            : t('CONFIRM')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-16: UnapproveTokenTable — list of approved swap-contract versions
// ---------------------------------------------------------------------------

// Mirrors vanilla `wallets.ts` `showUnapproveTokenAllowanceTableForm()`
// (L718) + `assetVersionUsedByDEXes()` (L632). Walks the wallet's
// `approved` map (version → ApprovalStatus) and lists every version
// with status `Approved`, annotated with the list of DEX hosts
// currently using that version.
function UnapproveTokenTable ({ asset, wallet, exchanges, onClose, onPickVersion }: {
  asset: SupportedAsset
  wallet: WalletState
  exchanges: Record<string, Exchange>
  onClose: () => void
  onPickVersion: (version: number) => void
}) {
  const { t } = useTranslation()

  // Build the version → DEX-hosts map. Same logic as vanilla: walk
  // each connected exchange and group by the version of THIS asset
  // that it uses.
  const versionToDEXes = useMemo<Record<number, string[]>>(() => {
    const out: Record<number, string[]> = {}
    for (const host in exchanges) {
      const xc = exchanges[host]
      const xcAsset = xc.assets?.[asset.id]
      if (!xcAsset) continue
      if (!out[xcAsset.version]) out[xcAsset.version] = []
      out[xcAsset.version].push(xc.host)
    }
    return out
  }, [exchanges, asset.id])

  // Collect the rows to display. Only versions with
  // ApprovalStatus.Approved (= 0) show up.
  const approvedVersions = useMemo<number[]>(() => {
    if (!wallet.approved) return []
    const out: number[] = []
    // Iterate 0..wallet.version inclusive like vanilla so versions
    // are displayed in stable ascending order.
    for (let i = 0; i <= wallet.version; i++) {
      if (wallet.approved[i] === ApprovalStatus.Approved) out.push(i)
    }
    return out
  }, [wallet.approved, wallet.version])

  const showTable = approvedVersions.length > 0

  return (
    <div>
      <div className="fs18 mb-3 text-center d-flex align-items-center justify-content-center gap-2">
        <img src={logoPath(asset.symbol)} alt={asset.symbol} width={20} height={20} />
        <span>{t('DISALLOW_TOKEN')}</span>
        <span className="fs14 text-muted"><AssetSymbol asset={asset} /></span>
      </div>

      {showTable && (
        <table className="row-border w-100">
          <thead>
            <tr>
              <th className="ps-3">{t('VERSION')}</th>
              <th>{t('USED_BY_DEX')}</th>
              <th className="pe-3 text-end">{t('Remove')}</th>
            </tr>
          </thead>
          <tbody>
            {approvedVersions.map(v => (
              <tr key={v}>
                <td className="ps-3">{v}</td>
                <td>{(versionToDEXes[v] ?? []).join(', ') || '—'}</td>
                <td className="pe-3 text-end">
                  <span
                    className="ico-cross text-danger pointer"
                    title={t('Remove')}
                    onClick={() => onPickVersion(v)}
                  ></span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!showTable && (
        <div className="text-center py-3 grey">{t('NO_TOKEN_ALLOWANCES')}</div>
      )}

      <div className="d-flex mt-3">
        <button className="btn btn-secondary btn-sm ms-auto" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-16: UnapproveTokenConfirm — single-version unapprove confirmation
// ---------------------------------------------------------------------------

// Mirrors vanilla `wallets.ts` `showUnapproveTokenAllowanceForm()`
// (L680) + `submitUnapproveTokenAllowance()` (L654). On mount, fetches
// the fee estimate via /api/approvetokenfee with `approval: false`
// and displays it. Submit POSTs to /api/unapprovetoken and, on
// success, swaps the form content for a tx-ID display (matching
// vanilla's behavior of staying on the success pane until the user
// closes it manually).
function UnapproveTokenConfirm ({ asset, assets, fiatRatesMap, version, net, onClose, onSuccess }: {
  asset: SupportedAsset
  assets: Record<number, SupportedAsset>
  fiatRatesMap: Record<number, number>
  version: number
  net: number
  onClose: () => void
  onSuccess: () => void
}) {
  const { t } = useTranslation()
  // Parent asset (eth for usdc-erc20, etc.) pays the fee for the
  // unapprove tx. Vanilla requires the selected asset to be a token
  // (L686-688); we defensively null-check here and render the error
  // state if somehow called with a non-token asset.
  const parentAsset = asset.token ? assets[asset.token.parentID] : null
  const parentRate = parentAsset ? fiatRatesMap[parentAsset.id] : 0

  const [feeEstimate, setFeeEstimate] = useState<number | null>(null)
  const [feeLoading, setFeeLoading] = useState(true)
  const [feeError, setFeeError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  // On success we stash the returned tx ID and swap the form content
  // (mirroring vanilla's `Doc.show(page.unapproveTokenTxMsg)` pattern).
  const [txID, setTxID] = useState<string | null>(null)

  // Load the fee estimate on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!parentAsset) {
        setFeeLoading(false)
        setFeeError(t('INVALID_SOURCE_ASSET'))
        return
      }
      const res = await postJSON('/api/approvetokenfee', {
        assetID: asset.id,
        version,
        approval: false
      })
      if (cancelled) return
      setFeeLoading(false)
      if (!checkResponse(res)) {
        setFeeError(res.msg || 'Failed to estimate fee')
        return
      }
      setFeeEstimate(res.txFee ?? 0)
    })()
    return () => { cancelled = true }
  }, [asset.id, parentAsset, t, version])

  const handleSubmit = useCallback(async () => {
    setSubmitError('')
    setSubmitting(true)
    const res = await postJSON('/api/unapprovetoken', { assetID: asset.id, version })
    setSubmitting(false)
    if (!checkResponse(res)) {
      setSubmitError(res.msg || 'Unapprove failed')
      return
    }
    setTxID(res.txID ?? '')
    // Keep the parent's wallet-state fresh so the approved-versions
    // table reflects the change if the user re-opens it.
    onSuccess()
  }, [asset.id, version, onSuccess])

  // Build the fee display string: "{atomicFormatted} {unit} (~$X)"
  // if a rate is available, otherwise just the atomic amount.
  const feeText = useMemo(() => {
    if (feeEstimate === null || !parentAsset) return ''
    const atomicStr = `${formatCoinAtom(feeEstimate, parentAsset.unitInfo)} ${parentAsset.unitInfo.conventional.unit}`
    if (parentRate > 0) {
      return `${atomicStr} (~$${formatFiat(atomToConventional(feeEstimate, parentAsset.unitInfo) * parentRate)})`
    }
    return atomicStr
  }, [feeEstimate, parentAsset, parentRate])

  // Explorer URL for the success tx ID, using the parent chain's
  // explorer since the unapprove tx is on the parent network.
  const txUrl = useMemo(() => {
    if (!txID || !parentAsset) return null
    return explorerURL(parentAsset.id, txID, net)
  }, [txID, parentAsset, net])

  return (
    <div>
      <div className="fs18 mb-3 text-center d-flex align-items-center justify-content-center gap-2">
        <img src={logoPath(asset.symbol)} alt={asset.symbol} width={20} height={20} />
        <span>{t('DISALLOW_TOKEN')}</span>
        <span className="fs14 text-muted"><AssetSymbol asset={asset} /></span>
        <span className="fs14 text-muted">— {t('VERSION')} {version}</span>
      </div>

      {/* Success state: show tx ID with explorer link. */}
      {txID !== null && (
        <>
          <div className="fs14 word-break-all mb-2">
            {t('TOKEN_UNAPPROVAL_TX_MSG')}
          </div>
          <div className="word-break-all mb-3">
            {txUrl
              ? (
                <a href={txUrl} target="_blank" rel="noopener noreferrer" className="subtlelink mono">
                  {txID}
                </a>
                )
              : (
                <span className="mono">{txID}</span>
                )}
          </div>
          <div className="d-flex">
            <button className="btn btn-secondary btn-sm ms-auto" onClick={onClose}>
              {t('Close')}
            </button>
          </div>
        </>
      )}

      {/* Pending state: show warning, fee estimate, submit button. */}
      {txID === null && (
        <>
          <div className="fs14 mb-3">
            {t('IF_YOU_REMOVE_THE_ALLOWANCE_FOR_THIS_VERSION_OF_THE_SWAP_CONTRACT_YOU_WILL_NO_LONGER_BE_ABLE_TO_TRADE_UNTIL_YOU_RE_ALLOW_IT')}
          </div>
          <div className="fs14 mb-3">
            <span className="text-muted me-1">{t('ESTIMATED_FEES')}:</span>
            {feeLoading && <span className="ico-spinner spinner fs14"></span>}
            {!feeLoading && feeError && <span className="text-danger">{feeError}</span>}
            {!feeLoading && !feeError && <strong>{feeText}</strong>}
          </div>

          {submitError && <div className="text-danger fs14 mb-2">{submitError}</div>}

          <div className="d-flex gap-2 justify-content-end">
            <button
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              disabled={submitting}
            >
              {t('CANCEL')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSubmit}
              disabled={submitting || feeLoading || !!feeError}
            >
              {submitting
                ? '...'
                : t('Submit')}
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

  const [stakeStatus, setStakeStatus] = useState<TicketStakingStatus | null>(null)
  // WP-12: proposalsMeta is included in the /api/stakestatus response
  // (vanilla `wallets.ts` L1361-1364). The voting modal renders the
  // in-progress proposals list from this state.
  const [proposalsMeta, setProposalsMeta] = useState<ProposalsMeta | null>(null)
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

  // WP-12 / WP-13: modal show state for the two new staking forms.
  // Both are scoped to StakingView since they only apply to DCR
  // ticket-buyer wallets and are read-mostly views over the existing
  // stakeStatus / proposalsMeta state already loaded here.
  const [showVoting, setShowVoting] = useState(false)
  const [showTicketHistory, setShowTicketHistory] = useState(false)

  // Load stake status
  const loadStakeStatus = useCallback(async () => {
    const res = await postJSON('/api/stakestatus', assetID)
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to load staking status')
      return
    }
    setStakeStatus(res.status as TicketStakingStatus)
    // WP-12: proposalsMeta ships in the same response. Vanilla reads
    // it as `res.proposalsMeta` (L1362).
    setProposalsMeta((res.proposalsMeta as ProposalsMeta) ?? null)
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
    setPurchaseSuccess(t('PURCHASED_N_TICKET_S', { n }))
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
          <span className="fs18">{t('SELECT_VSP')}</span>
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
    <>
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
              <div className="flex-center grey">{t('ACTIVE_TICKETS')}</div>
              <div className="flex-center demi">{stats.ticketCount - stats.votes - stats.revokes}</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('TICKETS_BOUGHT')}</div>
              {/* WP-13: clickable count opens the paginated ticket
                  history modal. Mirrors vanilla `wallets.ts` L404
                  `Doc.bind(page.ticketHistory, 'click', ...)` which
                  triggered `showTicketHistory()`. */}
              <div
                className="flex-center demi pointer hoverbg"
                onClick={() => setShowTicketHistory(true)}
                title={t('TICKET_HISTORY')}
              >
                <span className="ico-textfile me-1"></span>
                <span>{stats.ticketCount}</span>
              </div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('TOTAL_REWARDS')}</div>
              <div className="flex-center demi">{ui ? formatCoinAtom(stats.totalRewards, ui) : stats.totalRewards} DCR</div>
            </div>
            <div className="d-flex justify-content-between align-items-stretch">
              <div className="flex-center grey">{t('VOTES_CAST')}</div>
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

          {/* Set Votes sidebar — WP-12: now opens the voting modal.
              Mirrors vanilla `wallets.ts` L407 click handler that
              dispatched to `showSetVotesDialog()`. The previous React
              version had `pointer hoverbg` styling but no handler. */}
          {(agendaCount > 0 || tspendCount > 0 || tkeyCount > 0) && (
            <div
              className="flex-center p-3 flex-column border-start hoverbg pointer"
              onClick={() => setShowVoting(true)}
            >
              <div className="flex-center fs18">
                <span className="fs22 ico-check"></span>
                <span className="ms-2 fs18">{t('SET_VOTES')}</span>
              </div>
              <hr className="dashed my-1 w-75" />
              <div className="flex-center flex-column fs14">
                {agendaCount > 0 && <span>{agendaCount} {t('AGENDAS')}</span>}
                {tspendCount > 0 && <span>{tspendCount} {t('TREASURY_SPENDS')}</span>}
              </div>
            </div>
          )}
        </div>

        {!stakeStatus.vsp && !stakeStatus.isRPC && (
          <div className="flex-center py-1 px-2 fs14 text-warning">
            {t('PLEASE_SELECT_A_VSP_TO_PURCHASE_TICKETS')}
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
              {purchasing ? '...' : t('PURCHASE_TICKETS')}
            </button>
          </div>
        )}
        {purchaseError && <div className="text-center p-2 text-danger">{purchaseError}</div>}
        {purchaseSuccess && <div className="text-center p-2 text-success">{purchaseSuccess}</div>}
      </div>

      {/* Right sidebar: Ticket Price + Vote Reward */}
      <div className="flex-stretch-column border-start">
        <div className="flex-grow-1 flex-center flex-column p-3 border-bottom">
          <span className="fs14 demi lh1 pb-1">{t('TICKET_PRICE')}</span>
          <span className="d-flex align-items-end">
            <span className="fs18">{ui ? formatCoinAtom(stakeStatus.ticketPrice, ui) : stakeStatus.ticketPrice} DCR</span>
          </span>
        </div>
        <div className="flex-grow-1 flex-center flex-column p-3">
          <span className="fs14 demi lh1 pb-1">{t('VOTE_REWARD')}</span>
          <span className="d-flex align-items-end">
            <span className="fs18">{ui ? formatCoinAtom(stakeStatus.votingSubsidy, ui) : stakeStatus.votingSubsidy} DCR</span>
          </span>
        </div>
      </div>

      {error && <div className="text-danger p-2 border-top">{error}</div>}
    </section>

    {/* WP-13: ticket history modal. Vanilla `wallets.tmpl`
        `ticketHistoryForm` (L1028-1066) + `wallets.ts` `showTicketHistory()`
        (L1598). Pagination logic mirrors vanilla `pageOfTickets` /
        `ticketPageN` (L1518-1596): merges `stakeStatus.tickets`
        (live, returned by /api/stakestatus) with paged history
        accumulated from /api/ticketpage. */}
    <FormOverlay bare show={showTicketHistory} onClose={() => setShowTicketHistory(false)}>
      <div className="bg-body border rounded p-4" style={{ minWidth: 480, maxWidth: 640, maxHeight: '80vh', overflowY: 'auto' }}>
        {stakeStatus && (
          <TicketHistoryModal
            assetID={assetID}
            stakeStatus={stakeStatus}
            ui={ui}
            onClose={() => setShowTicketHistory(false)}
          />
        )}
      </div>
    </FormOverlay>

    {/* WP-12: voting preferences modal. Vanilla `wallets.tmpl`
        `votingForm` (L1068-1156) + `wallets.ts` `showSetVotesDialog()`
        (L1611). Renders agendas / treasury spends / treasury keys
        radios plus the in-progress proposals list. Each radio change
        POSTs /api/setvotes with one of {choices, tSpendPolicy,
        treasuryPolicy} and optimistically updates local stakeStatus. */}
    <FormOverlay bare show={showVoting} onClose={() => setShowVoting(false)}>
      <div className="bg-body border rounded p-4" style={{ minWidth: 520, maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
        {stakeStatus && (
          <SetVotesModal
            assetID={assetID}
            stakeStatus={stakeStatus}
            setStakeStatus={setStakeStatus}
            proposalsMeta={proposalsMeta}
            ui={ui}
            onClose={() => setShowVoting(false)}
          />
        )}
      </div>
    </FormOverlay>
    </>
  )
}

// ---------------------------------------------------------------------------
// WP-13: TicketHistoryModal
// ---------------------------------------------------------------------------

// Mirrors vanilla `wallets.ts` `pageOfTickets` (L1518-1535) +
// `ticketPageN` (L1559-1596). The window of tickets shown for a given
// page index is computed by walking two lists -- the live tickets
// returned in /api/stakestatus, then the historical tickets pulled
// from /api/ticketpage as the user paginates further back. Once the
// API has reported "no more tickets" we set `scanned` so the Next
// button is hidden at the boundary.
function TicketHistoryModal ({ assetID, stakeStatus, ui, onClose }: {
  assetID: number
  stakeStatus: TicketStakingStatus
  ui: UnitInfo
  onClose: () => void
}) {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const net = user?.net ?? 0

  const [pageNumber, setPageNumber] = useState(0)
  // Accumulated history tickets (paged in via /api/ticketpage). Kept
  // in a ref so paging through pages we already loaded doesn't burn a
  // network round-trip, matching vanilla's `this.ticketPage.history`
  // accumulator.
  const historyRef = useRef<Ticket[]>([])
  const scannedRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // The slice of tickets shown for the current page. Re-derived
  // whenever pageNumber changes (via loadPage below).
  const [pageTickets, setPageTickets] = useState<Ticket[]>([])

  // Compute the slice for a given page index, drawing from both the
  // live tickets and the historical accumulator. Returns whatever we
  // already have without making any network calls.
  const sliceForPage = useCallback((pgNum: number): Ticket[] => {
    const out: Ticket[] = []
    let startOffset = pgNum * TICKET_PAGE_SIZE
    if (startOffset < stakeStatus.tickets.length) {
      out.push(...stakeStatus.tickets.slice(startOffset, startOffset + TICKET_PAGE_SIZE))
      if (out.length < TICKET_PAGE_SIZE) {
        const need = TICKET_PAGE_SIZE - out.length
        out.push(...historyRef.current.slice(0, need))
      }
    } else {
      startOffset -= stakeStatus.tickets.length
      out.push(...historyRef.current.slice(startOffset, startOffset + TICKET_PAGE_SIZE))
    }
    return out
  }, [stakeStatus.tickets])

  // Load page pgNum, fetching more from /api/ticketpage if needed.
  // Mirrors vanilla `ticketPageN()`.
  const loadPage = useCallback(async (pgNum: number) => {
    setError('')
    let tickets = sliceForPage(pgNum)
    if (tickets.length < TICKET_PAGE_SIZE && !scannedRef.current) {
      const need = TICKET_PAGE_SIZE - tickets.length
      const lastList = historyRef.current.length > 0
        ? historyRef.current
        : stakeStatus.tickets
      const scanStart = lastList.length > 0
        ? lastList[lastList.length - 1].tx.blockHeight
        : SCAN_START_MEMPOOL
      // skipN is the count of tickets we already have in the
      // scanStart block, so the API doesn't return them again.
      const skipN = lastList.filter(tkt => tkt.tx.blockHeight === scanStart).length
      setLoading(true)
      const res = await postJSON('/api/ticketpage', { assetID, scanStart, n: need, skipN })
      setLoading(false)
      if (!checkResponse(res)) {
        setError(res.msg || 'Failed to load ticket page')
        return
      }
      const fetched = (res.tickets ?? []) as Ticket[]
      historyRef.current.push(...fetched)
      tickets = sliceForPage(pgNum)
      if (fetched.length < need) scannedRef.current = true
    }
    setPageTickets(tickets)
    setPageNumber(pgNum)
  }, [assetID, sliceForPage, stakeStatus.tickets])

  // Initial load. Intentionally fires only once per mount with empty
  // deps: the modal is freshly mounted each time the user opens it
  // from StakingView, so we always start at page 0. WS-driven
  // stakeStatus updates (which would re-derive `loadPage` via its
  // useCallback closure) shouldn't reset the user to page 0
  // mid-browse, so we deliberately don't include `loadPage` here.
  useEffect(() => {
    loadPage(0)
  }, [])

  const totalTix = stakeStatus.tickets.length + historyRef.current.length
  const atEnd = pageNumber * TICKET_PAGE_SIZE + pageTickets.length === totalTix
  const showPagination = totalTix >= TICKET_PAGE_SIZE
  const showTable = totalTix > 0
  const showNext = !atEnd || !scannedRef.current
  const showPrev = pageNumber > 0

  const ticketLink = useCallback((hash: string) => {
    return explorerURL(assetID, hash, net)
  }, [assetID, net])

  return (
    <div>
      <div className="d-flex align-items-center mb-3">
        <span className="ico-ticket fs22 me-2 grey"></span>
        <span className="fs18">{t('TICKET_HISTORY')}</span>
      </div>

      {showTable && (
        <table className="row-border w-100">
          <thead>
            <tr>
              <th>{t('Age')}</th>
              <th className="text-end">{t('Price')}</th>
              <th className="text-end">{t('Status')}</th>
              <th className="text-end">{t('Ticket')}</th>
            </tr>
          </thead>
          <tbody>
            {pageTickets.map(({ tx, status }) => {
              const url = ticketLink(tx.hash)
              const statusKey = TICKET_STATUS_KEYS[status] ?? 'TICKET_STATUS_UNKNOWN'
              return (
                <tr key={tx.hash}>
                  <td>{ageSince(tx.stamp * 1000)}</td>
                  <td className="text-end">{formatCoinAtom(tx.ticketPrice, ui)}</td>
                  <td className="text-end">{t(statusKey)}</td>
                  <td className="text-end">
                    <span className="mono">
                      {url
                        ? <a href={url} target="_blank" rel="noopener noreferrer" className="subtlelink">
                            {tx.hash.slice(0, 6)}…{tx.hash.slice(-6)}
                          </a>
                        : <span>{tx.hash.slice(0, 6)}…{tx.hash.slice(-6)}</span>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {!showTable && !loading && (
        <div className="text-center py-3 grey">{t('NO_TICKETS_TO_SHOW')}</div>
      )}

      {loading && (
        <div className="text-center py-2">
          <span className="ico-spinner spinner fs15"></span>
        </div>
      )}

      {error && <div className="text-danger fs14 mt-2">{error}</div>}

      {showPagination && (
        <div className="d-flex justify-content-end align-items-center mt-3 fs18">
          {showPrev && (
            <span
              className="ico-arrowleft me-1 p-1 hoverbg pointer"
              onClick={() => loadPage(pageNumber - 1)}
              title={t('Previous')}
            ></span>
          )}
          <span className="me-1">{pageNumber + 1}</span>
          {showNext && (
            <span
              className="ico-arrowright p-1 hoverbg pointer"
              onClick={() => loadPage(pageNumber + 1)}
              title={t('Next')}
            ></span>
          )}
        </div>
      )}

      <div className="d-flex mt-3">
        <button className="btn btn-secondary btn-sm ms-auto" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WP-12: SetVotesModal
// ---------------------------------------------------------------------------

// Mirrors vanilla `wallets.ts` `showSetVotesDialog()` (L1611-1721).
// Renders three groups of radios (agendas / treasury spends /
// treasury keys) plus the in-progress proposals list. Each radio
// change POSTs /api/setvotes with one shape from {choices,
// tSpendPolicy, treasuryPolicy} -- vanilla calls `setVotes` once per
// change rather than batching, so we do the same. We also
// optimistically update the local stakeStatus so the radios reflect
// the new selection without waiting for a refetch.
function SetVotesModal ({
  assetID, stakeStatus, setStakeStatus, proposalsMeta, ui, onClose
}: {
  assetID: number
  stakeStatus: TicketStakingStatus
  setStakeStatus: React.Dispatch<React.SetStateAction<TicketStakingStatus | null>>
  proposalsMeta: ProposalsMeta | null
  ui: UnitInfo
  onClose: () => void
}) {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const net = user?.net ?? 0
  const [error, setError] = useState('')

  const upperCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  // Shared helper for posting any of the three voting preference
  // shapes. Throws on error so callers can short-circuit their
  // optimistic state updates.
  const postVotes = useCallback(async (req: Record<string, unknown>) => {
    setError('')
    const res = await postJSON('/api/setvotes', { assetID, ...req })
    if (!checkResponse(res)) {
      setError(res.msg || 'Failed to set votes')
      throw new Error(res.msg || 'Failed to set votes')
    }
  }, [assetID])

  const setAgendaChoice = useCallback(async (agendaID: string, choiceID: string) => {
    try {
      await postVotes({ choices: { [agendaID]: choiceID } })
    } catch {
      return
    }
    setStakeStatus(prev => {
      if (!prev) return prev
      return {
        ...prev,
        stances: {
          ...prev.stances,
          agendas: prev.stances.agendas.map(a =>
            a.id === agendaID ? { ...a, currentChoice: choiceID } : a
          )
        }
      }
    })
  }, [postVotes, setStakeStatus])

  const setTspendPolicy = useCallback(async (txHash: string, policy: string) => {
    try {
      await postVotes({ tSpendPolicy: { [txHash]: policy } })
    } catch {
      return
    }
    setStakeStatus(prev => {
      if (!prev) return prev
      return {
        ...prev,
        stances: {
          ...prev.stances,
          tspends: prev.stances.tspends.map(s =>
            s.hash === txHash ? { ...s, currentPolicy: policy } : s
          )
        }
      }
    })
  }, [postVotes, setStakeStatus])

  const setTreasuryPolicy = useCallback(async (key: string, policy: string) => {
    try {
      await postVotes({ treasuryPolicy: { [key]: policy } })
    } catch {
      return
    }
    setStakeStatus(prev => {
      if (!prev) return prev
      return {
        ...prev,
        stances: {
          ...prev.stances,
          treasuryKeys: prev.stances.treasuryKeys.map(k =>
            k.key === key ? { ...k, policy } : k
          )
        }
      }
    })
  }, [postVotes, setStakeStatus])

  const proposals = proposalsMeta?.proposalsInProgress ?? []

  return (
    <div>
      {/* AGENDAS */}
      <div className="d-flex align-items-center mb-2">
        <span className="ico-check fs22 me-2 grey"></span>
        <span className="fs22">{t('Agendas')}</span>
      </div>
      <div className="flex-stretch-column">
        {stakeStatus.stances.agendas.map(agenda => (
          <div key={agenda.id} className="d-flex justify-content-between py-2 border-bottom">
            <div className="d-flex flex-grow-1 align-items-center pe-3">
              <div className="w-100 fs14">{agenda.description}</div>
            </div>
            <div className="d-flex align-items-stretch">
              {agenda.choices.map(choice => (
                <label
                  key={choice.id}
                  className="flex-center flex-column pe-2 pointer"
                  title={choice.description}
                >
                  <span className="fs14">{upperCase(choice.id)}</span>
                  <input
                    type="radio"
                    className="form-check-input"
                    name={agenda.id}
                    value={choice.id}
                    checked={agenda.currentChoice === choice.id}
                    onChange={() => setAgendaChoice(agenda.id, choice.id)}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* TREASURY SPENDS */}
      <div className="flex-center fs22 mt-3">{t('TREASURY_SPENDS')}</div>
      {stakeStatus.stances.tspends.length === 0 && (
        <div className="text-center py-2 grey">{t('NO_TREASURY_SPENDS_TO_SHOW')}</div>
      )}
      <div className="flex-stretch-column">
        {stakeStatus.stances.tspends.map(tspend => {
          const url = explorerURL(assetID, tspend.hash, net)
          return (
            <div key={tspend.hash} className="d-flex align-items-stretch py-3 border-bottom">
              <div className="d-flex flex-column flex-grow-1 pe-3">
                <div className="d-flex align-items-center justify-content-between">
                  {tspend.value > 0 && (
                    <div className="flex-center pe-2">
                      {ui ? formatCoinAtom(tspend.value, ui) : tspend.value} DCR
                    </div>
                  )}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 hoverbg pointer ico-open"
                      aria-label={`View transaction ${tspend.hash.slice(0, 8)}... in block explorer`}
                    ></a>
                  )}
                </div>
                <div className="word-break-all user-select-all fs14 p-1">{tspend.hash}</div>
              </div>
              <div className="d-flex align-items-stretch">
                <label className="flex-center flex-column pe-2 pointer">
                  <span>{t('No')}</span>
                  <input
                    type="radio"
                    className="form-check-input"
                    name={tspend.hash}
                    value="no"
                    checked={tspend.currentPolicy === 'no'}
                    onChange={() => setTspendPolicy(tspend.hash, 'no')}
                  />
                </label>
                <label className="flex-center flex-column pe-2 pointer">
                  <span>{t('Yes')}</span>
                  <input
                    type="radio"
                    className="form-check-input"
                    name={tspend.hash}
                    value="yes"
                    checked={tspend.currentPolicy === 'yes'}
                    onChange={() => setTspendPolicy(tspend.hash, 'yes')}
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>

      {/* TREASURY KEYS */}
      <div className="flex-center fs22 mt-3">{t('TREASURY_KEYS')}</div>
      <div className="flex-stretch-column">
        {(stakeStatus.stances.treasuryKeys ?? []).map(keyPolicy => (
          <div key={keyPolicy.key} className="d-flex justify-content-between align-items-stretch py-2 border-bottom">
            <div className="flex-center flex-grow-1 justify-content-start pe-3">
              <div className="word-break-all user-select-all fs14 p-1">{keyPolicy.key}</div>
            </div>
            <div className="d-flex align-items-stretch">
              <label className="flex-center flex-column pe-2 pointer">
                <span>{t('No')}</span>
                <input
                  type="radio"
                  className="form-check-input"
                  name={keyPolicy.key}
                  value="no"
                  checked={keyPolicy.policy === 'no'}
                  onChange={() => setTreasuryPolicy(keyPolicy.key, 'no')}
                />
              </label>
              <label className="flex-center flex-column pe-2 pointer">
                <span>{t('Yes')}</span>
                <input
                  type="radio"
                  className="form-check-input"
                  name={keyPolicy.key}
                  value="yes"
                  checked={keyPolicy.policy === 'yes'}
                  onChange={() => setTreasuryPolicy(keyPolicy.key, 'yes')}
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      {/* PROPOSALS IN-PROGRESS */}
      <div className="d-flex justify-content-between align-items-center mt-3">
        <div className="fs22">{t('PROPOSALS')}</div>
        <Link
          to={ROUTES.PROPOSALS}
          className="fs15 hoverbg pointer ico-open justify-content-end"
        >
          {' '}{t('VIEW_ALL')}
        </Link>
      </div>
      {proposals.length === 0 && (
        <div className="text-center py-2 grey">{t('NO_PROPOSALS_IN_PROGRESS')}</div>
      )}
      <div className="flex-stretch-column">
        {proposals.map(proposal => (
          <div key={proposal.token} className="py-3 border-bottom">
            <div className="d-flex justify-content-between align-items-center">
              <h6 className="pb-0 mb-0">{proposal.name}</h6>
              {/* Vanilla `loadProposal` (L2905) embeds the proposal
                  page inside the voting form; the React rewrite
                  navigates to the standalone proposal page instead
                  since we already have ProposalPage as a route.
                  Using <Link> (vs. <a onClick={navigate}>) for the
                  same reasons documented in B-L13-CLEANUP -- proper
                  link semantics, supports cmd-click / middle-click,
                  matches the existing convention in Header.tsx. */}
              <Link
                to={`/proposal/${proposal.token}?assetID=${assetID}`}
                className="fs15 pt-1 hoverbg pointer ico-open justify-content-end"
                onClick={onClose}
                aria-label={`View proposal: ${proposal.name}`}
              ></Link>
            </div>
            <div>
              <small className="text-muted">
                {proposal.username} - {t('VERSION')} {proposal.version} - {proposal.voteStatus.toLowerCase()}
              </small>
            </div>
          </div>
        ))}
      </div>

      {error && <div className="text-danger fs14 mt-2">{error}</div>}

      <div className="d-flex mt-3">
        <button className="btn btn-secondary btn-sm ms-auto" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </div>
  )
}
