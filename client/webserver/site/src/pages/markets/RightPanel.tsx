import { useState, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FormOverlay } from '../../components/common/FormOverlay'
import { TokenApprovalForm } from '../../components/common/TokenApprovalForm'
import { useAuthStore } from '../../stores/useAuthStore'
import {
  formatBestWeCan, RateEncodingFactor
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
import { StatusPanels } from './StatusPanels'
import type { StatusPanelData } from './StatusPanels'
import { TierSection } from './TierSection'
import type { TierData } from './TierSection'
import { OrdersSection } from './OrdersSection'

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
  const currentXc = exchanges[selected.host]
  const baseAsset = assets[selected.baseID] ?? null
  const quoteAsset = assets[selected.quoteID] ?? null
  const baseSymbol = baseAsset?.symbol?.toUpperCase() ?? ''
  const quoteSymbol = quoteAsset?.symbol?.toUpperCase() ?? ''

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
      // Note: vanilla passes `base.unitInfo.conventional.unit` here too -- parity bug preserved.
      return t('VERSION_NOT_SUPPORTED', {
        asset: bui.conventional.unit,
        version: String(quoteXcAsset.version)
      })
    }
    return ''
  }, [currentXc, baseAsset, quoteAsset, bui, selected, t])

  // MP-33: noWalletMsg
  const noWalletMsg = useMemo<string>(() => {
    if (!baseAsset || !quoteAsset) return ''
    const baseWallet = baseAsset.wallet
    const quoteWallet = quoteAsset.wallet
    if (!baseWallet && !quoteWallet) {
      return t('NO_WALLET_MSG', { asset1: baseSymbol, asset2: quoteSymbol })
    }
    if (!baseWallet) return t('CREATE_ASSET_WALLET_MSG', { asset: baseSymbol })
    if (!quoteWallet) return t('CREATE_ASSET_WALLET_MSG', { asset: quoteSymbol })
    if (baseWallet.disabled || !baseWallet.running) {
      return t('ENABLE_ASSET_WALLET_MSG', { asset: baseSymbol })
    }
    if (quoteWallet.disabled || !quoteWallet.running) {
      return t('ENABLE_ASSET_WALLET_MSG', { asset: quoteSymbol })
    }
    return ''
  }, [baseAsset, quoteAsset, baseSymbol, quoteSymbol, t])

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
  }, [currentXc, t])

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
      baseSymbolUpper: baseAsset.symbol.toUpperCase(),
      quoteSymbolUpper: quoteAsset.symbol.toUpperCase(),
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
    const buiConvFactor = bui.conventional.conversionFactor
    const quiConvFactor = qui.conventional.conversionFactor

    let conversionRate = 0
    const atomicRate = midGap || spotRate
    if (atomicRate > 0) {
      conversionRate = atomicRate * buiConvFactor / (RateEncodingFactor * quiConvFactor)
    } else if (externalPriceConv > 0) {
      conversionRate = externalPriceConv
    }

    let parcelSizeQuoteStr: string | null = null
    if (conversionRate > 0) {
      const qty = lotsize * conversionRate
      parcelSizeQuoteStr = formatBestWeCan(parcelsize * qty / quiConvFactor)
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
      parcelSizeBaseStr: formatBestWeCan(parcelsize * lotsize / buiConvFactor),
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
                <span className="p-3 flex-center fs17 grey">{t('approval_required_buy')}</span>
              )}
              {tokenApprovalStatus.noticeKey === 'approval_required_sell' && (
                <span className="p-3 flex-center fs17 grey">{t('approval_required_sell')}</span>
              )}
              {tokenApprovalStatus.noticeKey === 'approval_required_both' && (
                <span className="p-3 flex-center fs17 grey">{t('approval_required_both')}</span>
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
                  <span className="px-1">{tokenApprovalStatus.baseSymbolUpper}</span> {t('approval_change_pending')}
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
                  <span className="px-1">{tokenApprovalStatus.quoteSymbolUpper}</span> {t('approval_change_pending')}
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
      <FormOverlay show={approveAssetID !== null} onClose={() => setApproveAssetID(null)}>
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
