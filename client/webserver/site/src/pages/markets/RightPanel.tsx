import { useState, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FormOverlay } from '../../components/common/FormOverlay'
import { TokenApprovalForm } from '../../components/common/TokenApprovalForm'
import { useAuthStore } from '../../stores/useAuthStore'
import {
  formatCoinAtomToLotSizeBaseCurrency, formatCoinAtomToLotSizeQuoteCurrency,
  RateEncodingFactor, shortSymbol
} from '../../hooks/useFormatters'
import {
  hasActiveMatches, strongTier, tradingLimits
} from '../../components/AccountUtils'
import type { Order, RecentMatch, SupportedAsset } from '../../stores/types'
import {
  ApprovalStatus,
  ConnectionStatus
} from '../../stores/types'
import { useMarketPageContext } from './MarketPageContext'
import { deriveWarmupState } from './helpers'
import { StatusPanels } from './StatusPanels'
import type { StatusPanelData } from './StatusPanels'
import { TierSection } from './TierSection'
import type { TierData } from './TierSection'
import { OrdersSection } from './OrdersSection'
import { tradePairWalletMsg } from '../../hooks/useWalletMsg'

// ---------------------------------------------------------------------------
// RightPanel -- orchestrator for the rightmost section. Owns the heavy
// `useMemo` computations and the token-approval modal state; delegates
// status panels, tier/reputation, and orders/matches to sub-components.
// Reads selected / currentMkt / bui / qui from MarketPageContext.
// ---------------------------------------------------------------------------

export interface RightPanelProps {
  activeOrders: Order[]
  recentMatches: RecentMatch[]
  cancelOrder: (id: string) => void
  isRegistered: boolean
  midGap: number
  spotRate: number
  externalPriceConv: number
}

export function RightPanel ({
  activeOrders,
  recentMatches,
  cancelOrder,
  isRegistered,
  midGap,
  spotRate,
  externalPriceConv
}: RightPanelProps) {
  const { t } = useTranslation()
  const { selected, currentMkt, bui, qui } = useMarketPageContext()

  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const authFailed = useAuthStore(s => s.authFailed)
  const currentXc = exchanges[selected.host]
  const baseAsset = assets[selected.baseID] ?? null
  const quoteAsset = assets[selected.quoteID] ?? null
  const baseSymbol = baseAsset ? shortSymbol(baseAsset.symbol) : ''
  const quoteSymbol = quoteAsset ? shortSymbol(quoteAsset.symbol) : ''

  // MP-27/MP-59: ID of the asset currently being approved. null = modal hidden.
  const [approveAssetID, setApproveAssetID] = useState<number | null>(null)

  // MP-37: Ref to the rightmost-panel scroll container.
  const orderScrollerRef = useRef<HTMLDivElement | null>(null)

  // -------------------------------------------------------------------------
  // Computed memos (only consumed here or passed to children)
  // -------------------------------------------------------------------------

  // MP-28: loaderMsgText
  const loaderMsgText = useMemo<string>(() => {
    if (!currentXc || !baseAsset || !quoteAsset) return ''
    const baseXcAsset = currentXc.assets[selected.baseID]
    const quoteXcAsset = currentXc.assets[selected.quoteID]
    if (!baseXcAsset || !quoteXcAsset) return ''
    const versions = (a: SupportedAsset): number[] =>
      (a.token ? a.token.supportedAssetVersions : a.info?.versions) ?? []
    const baseSupported = versions(baseAsset).includes(baseXcAsset.version)
    const quoteSupported = versions(quoteAsset).includes(quoteXcAsset.version)
    if (!baseSupported) {
      return t('VERSION_NOT_SUPPORTED', {
        asset: bui.conventional.unit,
        version: String(baseXcAsset.version)
      })
    }
    if (!quoteSupported) {
      return t('VERSION_NOT_SUPPORTED', {
        asset: qui.conventional.unit,
        version: String(quoteXcAsset.version)
      })
    }
    return ''
  }, [currentXc, baseAsset, quoteAsset, bui, qui, selected, t])

  // UI-AUTH: derive the login-warmup triple via the shared helper so
  // MarketsPage and this panel stay in lockstep. `authingDex` gates
  // the no-wallet cascade below and doubles as the discriminator for
  // the statusPanel `kind: 'authing'` branch; `warmupMsg` is the
  // already-picked sub-state label ("Connecting..." vs
  // "Authenticating...") fed into that descriptor.
  const { authFailedMsg, authingDex, warmupMsg } = deriveWarmupState(currentXc, authFailed, t)

  // MP-33: noWalletMsg
  // UI-AUTH: during the login-warmup window (connected but not yet
  // authed, and no terminal auth failure), `wallet.running` is `false`
  // on every wallet until each per-wallet `Connect` lands. Surfacing
  // any wallet-status message in that window is misleading -- the
  // wallets are already enabled; they just haven't finished
  // connecting. Suppress the whole cascade; the "Connecting to DEX
  // server..." spinner covers the warmup state. After auth completes
  // (or fails), the real wallet-status cascade takes over -- including
  // the transient per-wallet `CONNECTING_WALLET` branch for the
  // post-warmup window where a subset of wallets is still coming up.
  // Genuinely-missing wallets (`wallet === undefined`) also get
  // suppressed here -- on success they surface immediately; on failure
  // the auth error is the more urgent signal anyway.
  const noWalletMsg = useMemo<string>(() => {
    if (authingDex || authFailedMsg) return ''
    if (!baseAsset || !quoteAsset) return ''
    return tradePairWalletMsg(t, baseAsset.wallet, quoteAsset.wallet, baseSymbol, quoteSymbol)
  }, [authingDex, authFailedMsg, baseAsset, quoteAsset, baseSymbol, quoteSymbol, t])

  // MP-34: hasUnreadyOrders
  const hasUnreadyOrders = useMemo<boolean>(() => {
    for (const ord of activeOrders) {
      if (!ord.readyToTick && hasActiveMatches(ord)) return true
    }
    return false
  }, [activeOrders])

  // MP-29..MP-32: statusPanel
  const statusPanel = useMemo<StatusPanelData>(() => {
    if (!currentXc) return { kind: 'none' }

    // UI-AUTH: show auth-failed first -- it's a terminal state that
    // supersedes the "still connecting" / registration cascade.
    if (authFailedMsg) return { kind: 'authFailed', failedMsg: authFailedMsg }

    // UI-AUTH: login-warmup window. Covers both pre-WS-connect
    // ("Connecting...") and post-connect/pre-auth ("Authenticating...")
    // -- the helper already picked the right sub-state label. Gate
    // above the registration cascade because `auth.effectiveTier` is
    // 0 during this window and would otherwise trip the "Create an
    // account" branch below.
    if (authingDex) return { kind: 'authing', authingMsg: warmupMsg }

    if (currentXc.connectionStatus !== ConnectionStatus.Connected) return { kind: 'none' }
    const auth = currentXc.auth
    if (!auth) return { kind: 'none' }

    const effectiveTier = auth.effectiveTier ?? 0
    if (effectiveTier >= 1) return { kind: 'none' }
    if (currentXc.viewOnly) return { kind: 'notRegistered' }

    const targetTier = auth.targetTier ?? 0
    const penalties = auth.rep?.penalties ?? 0
    const penaltyComps = auth.penaltyComps ?? 0

    if (targetTier > 0 && penalties > penaltyComps) {
      return { kind: 'penaltyCompsRequired', penalties, penaltyComps }
    }

    const pendingBonds = auth.pendingBonds ?? []
    if (pendingBonds.length > 0) {
      const confStatuses = pendingBonds.map((pending) => {
        const required = currentXc.bondAssets?.[pending.symbol]?.confs ?? 0
        return `${pending.confs} / ${required}`
      })
      return {
        kind: 'registrationStatus',
        regStatusTitle: t('WAITING_FOR_CONFS'),
        regStatusConfs: confStatuses.join(', '),
      }
    }

    if (targetTier > 0) return { kind: 'bondCreationPending' }
    return { kind: 'bondRequired', effectiveTier }
  }, [currentXc, authFailedMsg, authingDex, warmupMsg, t])

  // MP-27: tokenApprovalStatus
  const tokenApprovalStatus = useMemo<{
    visible: boolean
    baseStatus: ApprovalStatus
    quoteStatus: ApprovalStatus
    baseSymbolUpper: string
    quoteSymbolUpper: string
    noticeKey: 'approval_required_buy' | 'approval_required_sell' | 'approval_required_both' | null
  }>(() => {
    const empty = {
      visible: false,
      baseStatus: ApprovalStatus.Approved,
      quoteStatus: ApprovalStatus.Approved,
      baseSymbolUpper: '',
      quoteSymbolUpper: '',
      noticeKey: null,
    }
    if (!currentXc || !baseAsset || !quoteAsset) return empty

    let baseStatus = ApprovalStatus.Approved
    let quoteStatus = ApprovalStatus.Approved

    if (baseAsset.token && baseAsset.wallet?.approved) {
      const baseXcAsset = currentXc.assets[selected.baseID]
      const baseVersion = baseXcAsset?.version
      if (baseVersion !== undefined && baseAsset.wallet.approved[baseVersion] !== undefined) {
        baseStatus = baseAsset.wallet.approved[baseVersion]
      }
    }
    if (quoteAsset.token && quoteAsset.wallet?.approved) {
      const quoteXcAsset = currentXc.assets[selected.quoteID]
      const quoteVersion = quoteXcAsset?.version
      if (quoteVersion !== undefined && quoteAsset.wallet.approved[quoteVersion] !== undefined) {
        quoteStatus = quoteAsset.wallet.approved[quoteVersion]
      }
    }

    if (baseStatus === ApprovalStatus.Approved && quoteStatus === ApprovalStatus.Approved) return empty

    let noticeKey: 'approval_required_buy' | 'approval_required_sell' | 'approval_required_both' | null = null
    if (baseStatus !== ApprovalStatus.Approved && quoteStatus === ApprovalStatus.Approved) {
      noticeKey = 'approval_required_sell'
    } else if (baseStatus === ApprovalStatus.Approved && quoteStatus !== ApprovalStatus.Approved) {
      noticeKey = 'approval_required_buy'
    } else {
      noticeKey = 'approval_required_both'
    }

    return {
      visible: true,
      baseStatus,
      quoteStatus,
      baseSymbolUpper: shortSymbol(baseAsset.symbol),
      quoteSymbolUpper: shortSymbol(quoteAsset.symbol),
      noticeKey,
    }
  }, [currentXc, baseAsset, quoteAsset, selected])

  // Trading tier / reputation data
  const tierData = useMemo<TierData | null>(() => {
    if (!currentXc) return null
    const auth = currentXc.auth
    const { effectiveTier, pendingStrength } = auth
    const visible = effectiveTier > 0 || pendingStrength > 0

    const tier = strongTier(auth)
    const [usedParcels, parcelLimit] = tradingLimits(exchanges, selected.host)

    const parcelsize = currentMkt.parcelsize
    const lotsize = currentMkt.lotsize
    const ratestep = currentMkt.ratestep
    const buiConvFactor = bui.conventional.conversionFactor
    const quiConvFactor = qui.conventional.conversionFactor

    // quoteAtomsPerBaseAtom expresses the market rate as "how many quote
    // atoms per one base atom" — the unit that lets us compute a parcel's
    // quote-atom total as `parcelsize * lotsize * quoteAtomsPerBaseAtom`.
    // Atomic branch: encRate encodes this ratio scaled by RateEncodingFactor.
    // External branch: externalPriceConv is conv_quote / conv_base, so we
    // rescale by quiConvFactor / buiConvFactor.
    let quoteAtomsPerBaseAtom = 0
    const atomicRate = midGap || spotRate
    if (atomicRate > 0) {
      quoteAtomsPerBaseAtom = atomicRate / RateEncodingFactor
    } else if (externalPriceConv > 0) {
      quoteAtomsPerBaseAtom = externalPriceConv * quiConvFactor / buiConvFactor
    }

    let parcelSizeQuoteStr: string | null = null
    if (quoteAtomsPerBaseAtom > 0) {
      const parcelQuoteAtoms = parcelsize * lotsize * quoteAtomsPerBaseAtom
      parcelSizeQuoteStr = formatCoinAtomToLotSizeQuoteCurrency(parcelQuoteAtoms, bui, qui, lotsize, ratestep)
    }

    const tradingLimitStr = (parcelLimit * parcelsize).toFixed(2)
    const limitUsageStr = parcelLimit > 0
      ? (usedParcels / parcelLimit * 100).toFixed(1)
      : '0'

    return {
      visible,
      effectiveTier,
      pendingStrength,
      tier,
      usedParcels,
      parcelLimit,
      parcelSize: parcelsize,
      parcelSizeBaseStr: formatCoinAtomToLotSizeBaseCurrency(parcelsize * lotsize, bui, lotsize),
      parcelSizeQuoteStr,
      baseUnit: bui.conventional.unit,
      quoteUnit: qui.conventional.unit,
      tradingLimitStr,
      limitUsageStr
    }
  }, [currentXc, currentMkt, bui, qui, exchanges, selected, midGap, spotRate, externalPriceConv])

  return (
    <>
      <section className="rightmost-panel pb-3 position-relative">
        {/* MP-37: Scroll container ref -- `UserOrderRow`'s floater
            menu listens for scrolls here to keep itself anchored to
            its owning row. Matches vanilla's `page.orderScroller`. */}
        <div className="flex-stretch-column" ref={orderScrollerRef}>

          {/* MP-27: Token approval panel. Mirrors vanilla `#tokenApproval`
              markup and the 5-way `setTokenApprovalVisibility` branching.
              Appears ABOVE `loaderMsg` to match vanilla template order.
              Buttons open the `approveTokenForm` modal via FormOverlay. */}
          {tokenApprovalStatus.visible && (
            <div className="fs15 pt-1 pb-3 text-center border-bottom">
              {tokenApprovalStatus.noticeKey === 'approval_required_buy' && (
                <span className="p-3 flex-center fs17 grey">{t('APPROVAL_REQUIRED_BUY')}</span>
              )}
              {tokenApprovalStatus.noticeKey === 'approval_required_sell' && (
                <span className="p-3 flex-center fs17 grey">{t('APPROVAL_REQUIRED_SELL')}</span>
              )}
              {tokenApprovalStatus.noticeKey === 'approval_required_both' && (
                <span className="p-3 flex-center fs17 grey">{t('APPROVAL_REQUIRED_BOTH')}</span>
              )}
              {tokenApprovalStatus.baseStatus === ApprovalStatus.NotApproved && (
                <button
                  type="button"
                  className="go"
                  onClick={() => setApproveAssetID(selected.baseID)}
                >
                  {t('Approve')} <span>{tokenApprovalStatus.baseSymbolUpper}</span>
                </button>
              )}
              {tokenApprovalStatus.baseStatus === ApprovalStatus.Pending && (
                <div className="flex-center position-relative py-2">
                  <span className="px-1">{tokenApprovalStatus.baseSymbolUpper}</span> {t('APPROVAL_CHANGE_PENDING')}
                  <div className="px-2 ico-spinner spinner fs15"></div>
                </div>
              )}
              {tokenApprovalStatus.quoteStatus === ApprovalStatus.NotApproved && (
                <button
                  type="button"
                  className="go"
                  onClick={() => setApproveAssetID(selected.quoteID)}
                >
                  {t('Approve')} <span>{tokenApprovalStatus.quoteSymbolUpper}</span>
                </button>
              )}
              {tokenApprovalStatus.quoteStatus === ApprovalStatus.Pending && (
                <div className="flex-center position-relative py-2">
                  <span className="px-1">{tokenApprovalStatus.quoteSymbolUpper}</span> {t('APPROVAL_CHANGE_PENDING')}
                  <div className="px-2 ico-spinner spinner fs15"></div>
                </div>
              )}
            </div>
          )}

          <StatusPanels
            statusPanel={statusPanel}
            loaderMsgText={loaderMsgText}
            noWalletMsg={noWalletMsg}
          />

          {/* Reputation & Trading Tier (collapsible)
              MP-36: visible only when effectiveTier > 0 || pendingStrength > 0 */}
          {currentXc && (
            <TierSection tierData={tierData} isRegistered={isRegistered} />
          )}

          <OrdersSection
            activeOrders={activeOrders}
            recentMatches={recentMatches}
            cancelOrder={cancelOrder}
            hasUnreadyOrders={hasUnreadyOrders}
            baseSymbol={baseAsset?.symbol ?? ''}
            quoteSymbol={quoteAsset?.symbol ?? ''}
            scrollRef={orderScrollerRef}
          />

        </div>
      </section>

      {/* MP-59: Approve token form modal. */}
      <FormOverlay bare show={approveAssetID !== null} onClose={() => setApproveAssetID(null)}>
        {approveAssetID !== null && (
          <div className="form-panel bg-dark-2 p-3 border position-relative" style={{ maxWidth: 500 }}>
            <button type="button" className="form-close-btn" onClick={() => setApproveAssetID(null)} aria-label="Close">
              <span className="ico-cross"></span>
            </button>
            <header className="fs20 mb-2">
              {t('Approve')}{' '}
              <span className="d-inline-block">
                {assets[approveAssetID]?.unitInfo.conventional.unit ?? ''}
              </span>
            </header>
            <TokenApprovalForm
              assetID={approveAssetID}
              host={selected.host}
              onSuccess={() => setApproveAssetID(null)}
            />
          </div>
        )}
      </FormOverlay>
    </>
  )
}
