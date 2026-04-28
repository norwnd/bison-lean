// QuickAllocation — auto-estimated balance-allocation preview for an
// mmsettings bot. Ported from vanilla
// `mmsettings/components/QuickAllocation.tsx`.
//
// Also exports the two helpers `ManualAllocation` imports
// (`AllocationPanelHeader` — title + quick/manual toggle;
// `AllocationModeNote` — contextual copy). Vanilla's batches 6 & 7
// landed in a single commit here so both imports resolve in the same
// changeset without a stub step.
//
// Per-call `app()` / `Doc.X` / `State.isDark()` lookups become typed
// store/hook reads: `useAuthStore(s => s.assets)`, `logoPath` +
// `formatCoinValueAtom` from `hooks/useFormatters`, and
// `useUIStore(s => s.darkMode)`. `prep(ID_MM_X)` becomes `t('MM_X')`.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useBotConfigState, useBotConfigDispatch } from './utils/BotConfig'
import Tooltip from '../common/Tooltip'
import { requiredDexAssets, type AllocationDetail } from './utils/AllocationUtil'
import { PanelHeader, NumberInput } from './FormComponents'
import { CEXDisplayInfos } from './cexDisplayInfo'
import { logoPath, formatCoinAtom } from '../../hooks/useFormatters'
import { useAuthStore } from '../../stores/useAuthStore'
import { useUIStore } from '../../stores/useUIStore'

interface QuickConfigInputProps {
  label: string
  tooltip: string
  suffix?: string
  min: number
  max: number
  precision: number
  value: number
  onChange: (value: number) => void
}

const QuickConfigInput: React.FC<QuickConfigInputProps> = ({
  label,
  tooltip,
  suffix,
  min,
  max,
  precision,
  value,
  onChange
}) => (
  <div className="d-flex align-items-center pt-2 mt-2 pb-2 mm-mixer-row">
    <div className="fs16 me-3" style={{ flex: '0 0 140px' }}>
      {label}
      <Tooltip content={tooltip}>
        <span className="ico-info fs13 ms-1"></span>
      </Tooltip>
    </div>

    <NumberInput
      sliderPosition="inline"
      className="p-1 text-center fs14"
      min={min}
      max={max}
      precision={precision}
      value={value}
      onChange={onChange}
      withSlider={true}
      suffix={suffix}
    />
  </div>
)

interface CalculationBreakdownRowProps {
  text: string
  value: number
  assetID: number
  level: 1 | 2
  isPercentage?: boolean
  displayZero?: boolean
}

const CalculationBreakdownRow: React.FC<CalculationBreakdownRowProps> = ({
  text,
  value,
  assetID,
  level,
  isPercentage = false,
  displayZero = false
}) => {
  const assets = useAuthStore(s => s.assets)
  const isDark = useUIStore(s => s.darkMode)

  if (!displayZero && value === 0) {
    return null
  }

  const formatValue = (value: number, assetID: number) => {
    const asset = assets[assetID]
    if (isPercentage) {
      return `${(value * 100).toFixed(2)}%`
    }
    return value ? formatCoinAtom(value, asset.unitInfo) : '0'
  }

  const textSizeClass = level === 1 ? 'fs14' : 'fs11'
  const textColorClass = isDark ? 'text-white' : 'text-dark'

  return (
    <div className="d-flex justify-content-between align-items-center py-1">
      <span className={`${textSizeClass} ${textColorClass}`}>{text}</span>
      <span className={`${textSizeClass} ${isDark ? 'text-light' : 'text-muted'}`}>
        {formatValue(value, assetID)}
      </span>
    </div>
  )
}

interface AllocationBreakdownProps {
  allocationDetail: AllocationDetail | undefined
  assetID: number
}

interface DetailRow {
  text: string
  value: number
  isPercentage?: boolean
  displayZero?: boolean
}

interface BreakdownRow {
  key: string
  label: string
  unitNote: string
  subtotal: number
  expandable: boolean
  details: DetailRow[]
}

const AllocationBreakdown: React.FC<AllocationBreakdownProps> = ({
  allocationDetail,
  assetID
}) => {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const isDark = useUIStore(s => s.darkMode)
  const [expandedRow, setExpandedRow] = React.useState<string | null>(null)

  if (!allocationDetail) {
    return null
  }

  const calc = allocationDetail.calculation
  const asset = assets[assetID]
  const fmt = (value: number) => formatCoinAtom(value, asset.unitInfo)

  const sumFees = (fees: { swap: number; redeem: number; refund: number; funding: number }) =>
    fees.swap + fees.redeem + fees.refund + fees.funding

  const lotBufferedAmount = (lot: typeof calc.buyLot): number => {
    const principal = lot.tradedAmount * (1 + lot.slippageBuffer + lot.multiSplitBuffer)
    return lot.multiSplitBuffer === 0 ? Math.floor(principal) : Math.round(principal)
  }

  const lotEffectiveSwap = (lot: typeof calc.buyLot): number => {
    return lot.multiSplitBuffer === 0
      ? lot.fees.swap
      : Math.round(lot.fees.swap * (1 + lot.multiSplitBuffer))
  }

  const lotDetails = (lot: typeof calc.buyLot): DetailRow[] => {
    const hasBuffers = lot.slippageBuffer > 0 || lot.multiSplitBuffer > 0
    const details: DetailRow[] = [
      { text: t('MM_TRADED_AMOUNT'), value: lot.tradedAmount },
      { text: t('MM_SLIPPAGE_BUFFER'), value: lot.slippageBuffer, isPercentage: true },
      { text: t('MM_MULTI_SPLIT_BUFFER'), value: lot.multiSplitBuffer, isPercentage: true }
    ]
    if (hasBuffers) {
      details.push({ text: t('MM_BUFFERED_AMOUNT'), value: lotBufferedAmount(lot), displayZero: true })
    }
    details.push(
      { text: t('MM_SWAP_FEES'), value: lotEffectiveSwap(lot) },
      { text: t('MM_REDEEM_FEES'), value: lot.fees.redeem },
      { text: t('MM_REFUND_FEES'), value: lot.fees.refund },
      { text: t('MM_FUNDING_FEES'), value: lot.fees.funding }
    )
    return details
  }

  const rows: BreakdownRow[] = []

  if (calc.numBuyLots > 0 && calc.buyLot.totalAmount > 0) {
    const s = calc.numBuyLots === 1 ? '' : 's'
    rows.push({
      key: 'buyLots',
      label: `${calc.numBuyLots} Buy Lot${s}`,
      unitNote: `(~${fmt(calc.buyLot.totalAmount)} each)`,
      subtotal: calc.buyLot.totalAmount * calc.numBuyLots,
      expandable: true,
      details: lotDetails(calc.buyLot)
    })
  }

  if (calc.numSellLots > 0 && calc.sellLot.totalAmount > 0) {
    const s = calc.numSellLots === 1 ? '' : 's'
    rows.push({
      key: 'sellLots',
      label: `${calc.numSellLots} Sell Lot${s}`,
      unitNote: `(~${fmt(calc.sellLot.totalAmount)} each)`,
      subtotal: calc.sellLot.totalAmount * calc.numSellLots,
      expandable: true,
      details: lotDetails(calc.sellLot)
    })
  }

  const totalBuyFees = sumFees(calc.feeReserves.buyReserves)
  if (calc.numBuyFeeReserves > 0 && totalBuyFees > 0) {
    rows.push({
      key: 'buyFeeReserves',
      label: t('MM_BUY_FEE_RESERVES'),
      unitNote: `(~${fmt(totalBuyFees)} \u00d7 ${calc.numBuyFeeReserves} units)`,
      subtotal: totalBuyFees * calc.numBuyFeeReserves,
      expandable: true,
      details: [
        { text: t('MM_SWAP_FEES'), value: calc.feeReserves.buyReserves.swap },
        { text: t('MM_REDEEM_FEES'), value: calc.feeReserves.buyReserves.redeem },
        { text: t('MM_REFUND_FEES'), value: calc.feeReserves.buyReserves.refund },
        { text: t('MM_FUNDING_FEES'), value: calc.feeReserves.buyReserves.funding }
      ]
    })
  }

  const totalSellFees = sumFees(calc.feeReserves.sellReserves)
  if (calc.numSellFeeReserves > 0 && totalSellFees > 0) {
    rows.push({
      key: 'sellFeeReserves',
      label: t('MM_SELL_FEE_RESERVES'),
      unitNote: `(~${fmt(totalSellFees)} \u00d7 ${calc.numSellFeeReserves} units)`,
      subtotal: totalSellFees * calc.numSellFeeReserves,
      expandable: true,
      details: [
        { text: t('MM_SWAP_FEES'), value: calc.feeReserves.sellReserves.swap },
        { text: t('MM_REDEEM_FEES'), value: calc.feeReserves.sellReserves.redeem },
        { text: t('MM_REFUND_FEES'), value: calc.feeReserves.sellReserves.refund },
        { text: t('MM_FUNDING_FEES'), value: calc.feeReserves.sellReserves.funding }
      ]
    })
  }

  if (calc.initialBuyFundingFees > 0) {
    rows.push({
      key: 'initBuyFunding',
      label: t('MM_INITIAL_BUY_FUNDING_FEES'),
      unitNote: '',
      subtotal: calc.initialBuyFundingFees,
      expandable: false,
      details: []
    })
  }

  if (calc.initialSellFundingFees > 0) {
    rows.push({
      key: 'initSellFunding',
      label: t('MM_INITIAL_SELL_FUNDING_FEES'),
      unitNote: '',
      subtotal: calc.initialSellFundingFees,
      expandable: false,
      details: []
    })
  }

  const rebalancePerUnit = calc.bridgeFees + calc.sendFees
  if (calc.rebalanceFeeReserves > 0 && rebalancePerUnit > 0) {
    rows.push({
      key: 'rebalance',
      label: t('MM_BRIDGE_FEE_RESERVES'),
      unitNote: `(~${fmt(rebalancePerUnit)} \u00d7 ${calc.rebalanceFeeReserves} units)`,
      subtotal: calc.rebalanceFeeReserves * rebalancePerUnit,
      expandable: true,
      details: [
        { text: t('MM_BRIDGE_FEES'), value: calc.bridgeFees, displayZero: true },
        { text: t('MM_SEND_FEES'), value: calc.sendFees, displayZero: true }
      ]
    })
  }

  const isRunningBot = calc.runningBotTotal !== undefined
  const allocationLabel = isRunningBot ? t('MM_ALLOC_CHANGE') : t('MM_AMOUNT_ALLOCATED')

  const textColorClass = isDark ? 'text-white' : 'text-dark'
  const mutedClass = isDark ? 'text-light' : 'text-muted'

  const toggleRow = (key: string) => setExpandedRow(expandedRow === key ? null : key)

  return (
    <div className="border rounded-bottom p-3 mm-allocation-breakdown">
      {rows.map(row => (
        <div key={row.key}>
          <div
            className={`d-flex justify-content-between align-items-center py-1${row.expandable ? ' cursor-pointer' : ''}`}
            onClick={row.expandable ? () => toggleRow(row.key) : undefined}
          >
            <span className={`fs14 ${textColorClass}`}>
              {row.label}
              {row.unitNote && <span className={`ms-1 ${mutedClass} fs11`}>{row.unitNote}</span>}
            </span>
            <div className="d-flex align-items-center">
              <span className={`fs14 ${mutedClass}`}>{fmt(row.subtotal)}</span>
              {row.expandable && (
                <span
                  className="ico-arrowright fs11 ms-1"
                  style={{
                    transform: expandedRow === row.key ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease'
                  }}
                ></span>
              )}
            </div>
          </div>
          {row.expandable && expandedRow === row.key && (
            <div className="ms-3">
              {row.details.map(detail => (
                <CalculationBreakdownRow
                  key={detail.text}
                  text={detail.text}
                  value={detail.value}
                  assetID={assetID}
                  level={2}
                  isPercentage={detail.isPercentage}
                  displayZero={detail.displayZero}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      <hr className="my-3" />

      <div className="mb-3">
        <CalculationBreakdownRow
          text={t('MM_TOTAL_REQUIRED')}
          value={calc.totalRequired}
          assetID={assetID}
          level={1}
          displayZero={true}
        />

        <CalculationBreakdownRow
          text={t('MM_ALREADY_ALLOCATED')}
          value={calc.runningBotTotal ?? 0}
          assetID={assetID}
          level={1}
        />

        {allocationDetail.amount < 0 && <CalculationBreakdownRow
          text={t('MM_AVAILABLE_TO_UNALLOCATE')}
          value={calc.runningBotAvailable ?? 0}
          assetID={assetID}
          level={1}
        />}

        {allocationDetail.amount >= 0 && <CalculationBreakdownRow
          text={t('MM_TOTAL_AVAILABLE')}
          value={calc.available}
          assetID={assetID}
          level={1}
          displayZero={true}
        />}
      </div>

      <hr className="my-3" />

      <div>
        <CalculationBreakdownRow
          text={allocationLabel}
          value={allocationDetail.amount}
          assetID={assetID}
          level={1}
          displayZero={true}
        />
      </div>
    </div>
  )
}

interface BalanceItemProps {
  assetID: number
  amount: number
  status?: string
  allocationDetail?: AllocationDetail
  isExpanded: boolean
  onToggle: () => void
}

const BalanceItem: React.FC<BalanceItemProps> = ({
  assetID,
  amount,
  status,
  allocationDetail,
  isExpanded,
  onToggle
}) => {
  const assets = useAuthStore(s => s.assets)
  const asset = assets[assetID]

  const formattedAmount = amount ? formatCoinAtom(amount, asset.unitInfo) : '0'

  const getStatusClass = (status?: string) => {
    switch (status) {
      case 'sufficient': return 'text-buycolor'
      case 'insufficient': return 'text-danger'
      case 'sufficient-with-rebalance': return 'text-warning'
      default: return 'text-danger'
    }
  }

  return (
    <div className="mb-2">
      <div
        className="d-flex align-items-center justify-content-between p-2 border rounded cursor-pointer"
        onClick={onToggle}
      >
        <div className="d-flex align-items-center">
          <img className="mini-icon me-2" src={logoPath(asset.symbol)} alt={asset.symbol} />
          <span className="fs16">{asset.unitInfo.conventional.unit}</span>
        </div>
        <div className="d-flex align-items-center">
          <span className={`fs16 me-2 ${getStatusClass(status)}`}>
            {formattedAmount}
          </span>
          <span
            className='ico-arrowright fs14'
            style={{
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease'
            }}
          ></span>
        </div>
      </div>

      {isExpanded && (
        <AllocationBreakdown
          allocationDetail={allocationDetail}
          assetID={assetID}
        />
      )}
    </div>
  )
}

const AllocationTable: React.FC = () => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const { botConfig, allocationResult } = botConfigState
  const [expandedItem, setExpandedItem] = React.useState<string | null>(null)

  if (!allocationResult) return null

  const dexAssetIDs = requiredDexAssets(botConfigState)

  const toggleExpanded = (itemKey: string) => {
    setExpandedItem(expandedItem === itemKey ? null : itemKey)
  }

  const cexDisplayInfo = CEXDisplayInfos[botConfig.cexName]
  const cexLogoPath = cexDisplayInfo?.logo || ''
  const cexDisplayName = cexDisplayInfo?.name || botConfig.cexName || 'CEX'

  return (
    <div className="mb-4">
      <div className="row">
        <div className="col-24 col-xl-12 mb-3">
          <div className="d-flex align-items-center mb-3">
            <img className="logo-square mini-icon me-3" src={logoPath('DEX')} alt="DEX" />
            <span className="fs16 demi">Bison Wallet Balances</span>
          </div>

          <div className="d-flex flex-column">
            {dexAssetIDs.map(assetID => {
              const allocation = allocationResult.dex[assetID]
              const amount = allocation ? allocation.amount : 0
              const status = allocation?.status
              const itemKey = `dex-${assetID}`

              return (
                <BalanceItem
                  key={itemKey}
                  assetID={assetID}
                  amount={amount}
                  status={status}
                  allocationDetail={allocation}
                  isExpanded={expandedItem === itemKey}
                  onToggle={() => toggleExpanded(itemKey)}
                />
              )
            })}
          </div>
        </div>

        {botConfig.cexName && (
          <div className="col-24 col-xl-12 mb-3">
            <div className="d-flex align-items-center mb-3">
              <img className="mini-icon me-3" src={cexLogoPath} alt={cexDisplayName} />
              <span className="fs16 demi">{t('CEX_BALANCES', { cexName: cexDisplayName })}</span>
            </div>

            <div className="d-flex flex-column">
              {[botConfig.cexBaseID, botConfig.cexQuoteID].map(assetID => {
                const allocation = allocationResult.cex[assetID]
                const amount = allocation ? allocation.amount : 0
                const status = allocation?.status
                const itemKey = `cex-${assetID}`

                return (
                  <BalanceItem
                    key={itemKey}
                    assetID={assetID}
                    amount={amount}
                    status={status}
                    allocationDetail={allocation}
                    isExpanded={expandedItem === itemKey}
                    onToggle={() => toggleExpanded(itemKey)}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const StatusLabels: React.FC = () => {
  const { t } = useTranslation()
  const { botConfig } = useBotConfigState()
  const showRebalance = !!botConfig.autoRebalance && !botConfig.autoRebalance.internalOnly

  return (
    <div className="d-flex align-items-center justify-content-center mb-3 flex-wrap">
      <div className="flex-shrink-0 mx-2">
        <span className="text-buycolor" style={{ whiteSpace: 'nowrap' }}>
          <span className="me-1">{'\u25CF'}</span>{t('MM_FUNDED')}
        </span>
      </div>
      <div className="flex-shrink-0 mx-2">
        <span className="text-danger" style={{ whiteSpace: 'nowrap' }}>
          <span className="me-1">{'\u25CF'}</span>{t('MM_UNDERFUNDED')}
        </span>
      </div>
      {showRebalance && (
        <div className="flex-shrink-0 mx-2">
          <span className="text-warning" style={{ whiteSpace: 'nowrap' }}>
            <span className="me-1">{'\u25CF'}</span>{t('MM_FUNDED_WITH_REBALANCE')}
            <Tooltip content={t('MM_FUNDED_WITH_REBALANCE_TOOLTIP')}>
              <span className="ico-info fs13 ms-1"></span>
            </Tooltip>
          </span>
        </div>
      )}
    </div>
  )
}

interface AllocationPanelHeaderProps {
  description: string
}

interface AllocationModeNoteProps {
  isRunning: boolean
  mode: 'quick' | 'manual'
}

export const AllocationModeNote: React.FC<AllocationModeNoteProps> = ({
  isRunning,
  mode
}) => {
  const { t } = useTranslation()
  const baseClass = 'fs14 text-muted'

  if (mode === 'quick') {
    return (
      <div className="mb-3">
        {isRunning
          ? (
            <div className={baseClass}>
              {t('MM_ALLOC_RUNNING_QUICK')}
            </div>
            )
          : (
            <div className={baseClass}>
              {t('MM_ALLOC_NEW_QUICK')}
            </div>
            )}
      </div>
    )
  }

  return (
    <div className="mb-3">
      {isRunning
        ? (
          <>
            <div className={baseClass}>
              {t('MM_ALLOC_RUNNING_MANUAL')}
            </div>
            <div className={`${baseClass} mt-1`}>
              {t('MM_ALLOC_RUNNING_MANUAL_NOTE')}
            </div>
          </>
          )
        : (
          <div className={baseClass}>
            {t('MM_ALLOC_NEW_MANUAL')}
          </div>
          )}
    </div>
  )
}

export const AllocationPanelHeader: React.FC<AllocationPanelHeaderProps> = ({
  description
}) => {
  const { t } = useTranslation()
  const { botConfig } = useBotConfigState()
  const dispatch = useBotConfigDispatch()

  const isUsingQuickAllocation = !!botConfig.uiConfig.usingQuickBalance

  const title = isUsingQuickAllocation ? t('MM_QUICK_ALLOCATION') : t('MM_MANUAL_ALLOCATION')
  const buttonText = isUsingQuickAllocation ? t('MM_SWITCH_TO_MANUAL') : t('MM_USE_AUTO_ESTIMATE')

  const handleSwitch = () => {
    dispatch({ type: 'TOGGLE_QUICK_BALANCE', payload: !isUsingQuickAllocation })
  }

  return (
    <PanelHeader
      title={title}
      description={description}
      buttonText={buttonText}
      onClick={handleSwitch}
    />
  )
}

const QuickAllocationView: React.FC = () => {
  const { t } = useTranslation()
  const { botConfig, dexMarket, runStats } = useBotConfigState()
  const dispatch = useBotConfigDispatch()

  if (!botConfig.uiConfig.quickBalance) return null

  const quickBalance = botConfig.uiConfig.quickBalance

  const marketHasAToken = botConfig.baseID !== dexMarket.baseFeeAssetID || botConfig.quoteID !== dexMarket.quoteFeeAssetID
  const cexRebalance = !!botConfig.autoRebalance && !botConfig.autoRebalance.internalOnly
  const isRunning = !!runStats

  const handleQuickConfigChange = (field: keyof typeof quickBalance, value: number) => {
    dispatch({
      type: 'UPDATE_QUICK_BALANCE',
      payload: { field, value }
    })
  }

  const numPlacementLots = (sells: boolean): number => {
    if (botConfig.arbMarketMakingConfig) {
      const cfg = botConfig.arbMarketMakingConfig
      const placements = sells ? cfg.sellPlacements : cfg.buyPlacements
      return placements.reduce((prev, curr) => prev + curr.lots, 0)
    }

    if (botConfig.basicMarketMakingConfig) {
      const cfg = botConfig.basicMarketMakingConfig
      const placements = sells ? cfg.sellPlacements : cfg.buyPlacements
      return placements.reduce((prev, curr) => prev + curr.lots, 0)
    }

    return 1
  }

  return (
    <div>
      <AllocationPanelHeader description={t('MM_QUICK_ALLOC_DESC')} />
      <AllocationModeNote isRunning={isRunning} mode="quick" />

      <div className="row">
        <div className="col-24 col-xl-9 mb-3">
          <div className="border rounded p-3 h-100">
            <div className="fs18 demi mb-2">{t('MM_BUFFERS_AND_RESERVES')}</div>

            <QuickConfigInput
              label={t('MM_BUY_BUFFER')}
              tooltip={t('MM_EXTRA_BUY_LOTS_TOOLTIP')}
              min={0}
              max={3 * numPlacementLots(false)}
              precision={0}
              value={quickBalance.buysBuffer}
              onChange={(value) => handleQuickConfigChange('buysBuffer', value)}
            />

            <QuickConfigInput
              label={t('MM_SELL_BUFFER')}
              tooltip={t('MM_EXTRA_SELL_LOTS_TOOLTIP')}
              min={0}
              max={3 * numPlacementLots(true)}
              precision={0}
              value={quickBalance.sellsBuffer}
              onChange={(value) => handleQuickConfigChange('sellsBuffer', value)}
            />

            <QuickConfigInput
              label={t('MM_SLIPPAGE_BUFFER')}
              tooltip={t('MM_SLIPPAGE_BUFFER_TOOLTIP')}
              suffix="%"
              min={0}
              max={100}
              precision={2}
              value={quickBalance.slippageBuffer * 100}
              onChange={(value) => handleQuickConfigChange('slippageBuffer', value / 100)}
            />

            {marketHasAToken && <QuickConfigInput
              label={t('MM_BUY_FEE_RESERVE')}
              tooltip={t('MM_EXTRA_BUY_FEE_TOOLTIP')}
              min={0}
              max={1000}
              precision={0}
              value={quickBalance.buyFeeReserve}
              onChange={(value) => handleQuickConfigChange('buyFeeReserve', value)}
            />}

            {marketHasAToken && <QuickConfigInput
              label={t('MM_SELL_FEE_RESERVE')}
              tooltip={t('MM_EXTRA_SELL_FEE_TOOLTIP')}
              min={0}
              max={1000}
              precision={0}
              value={quickBalance.sellFeeReserve}
              onChange={(value) => handleQuickConfigChange('sellFeeReserve', value)}
            />}

            {cexRebalance && <QuickConfigInput
              label={t('MM_BRIDGE_FEE_RESERVE')}
              tooltip={t('MM_EXTRA_REBALANCE_FEE_TOOLTIP')}
              min={0}
              max={1000}
              precision={0}
              value={quickBalance.rebalanceFeeReserve}
              onChange={(value) => handleQuickConfigChange('rebalanceFeeReserve', value)}
            />}
          </div>
        </div>

        <div className="col-24 col-xl-15 mb-3">
          <div className="border rounded p-3 h-100">
            <div className="fs18 demi mb-2">{t('MM_ALLOCATION_PREVIEW')}</div>
            <StatusLabels />
            <AllocationTable />
          </div>
        </div>
      </div>
    </div>
  )
}

export default QuickAllocationView
