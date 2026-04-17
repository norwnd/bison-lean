// RebalanceSettingsTab — CEX ↔ DEX rebalance method picker, per-asset
// min-transfer sliders, and (when cross-chain) bridge route + fees
// selectors. Ported from vanilla
// `mmsettings/components/RebalanceSettingsTab.tsx`.
//
// `prep(ID_MM_X)` → `t('MM_X')` (with `{{ asset }}` interpolation for
// `MM_BRIDGE_CONFIGURATION`); `Doc.logoPath` / `Doc.formatCoinValueAtom`
// live in `hooks/useFormatters`; `app().assets[id]` resolves via
// `useAuthStore(s => s.assets)`; `app().unitInfo(id)` becomes
// `assets[id].unitInfo`; `app().prettyPrintAssetID` is inlined as
// `prettyPrintAssetID` below since this is the only consumer.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { SupportedAsset } from '../../stores/types'
import {
  useBotConfigState,
  useBotConfigDispatch,
  fetchRoundTripFeesAndLimits,
  projectedAllocations
} from './utils/BotConfig'
import Tooltip from './Tooltip'
import { PanelHeader, NumberInput } from './FormComponents'
import { useMMSettingsSetError, useMMSettingsSetLoading } from './MMSettings'
import { formatCoinAtom, logoPath } from '../../hooks/useFormatters'
import { useAuthStore } from '../../stores/useAuthStore'

function prettyPrintAssetID (assetID: number, assets: Record<number, SupportedAsset>): string {
  const asset = assets[assetID]
  if (!asset) return `Unknown Asset ${assetID}`
  if (asset.token) {
    const parentAsset = assets[asset.token.parentID]
    return `${asset.name} on ${parentAsset.name}`
  }
  return asset.name
}

interface MinTransferControlProps {
  asset: 'base' | 'quote'
}

const MinTransferControl: React.FC<MinTransferControlProps> = ({
  asset
}) => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const dispatch = useBotConfigDispatch()

  const { botConfig, dexMarket } = botConfigState

  const assetInfo = asset === 'base' ? dexMarket.baseAsset : dexMarket.quoteAsset
  let assetSymbol = assetInfo?.symbol || (asset === 'base' ? 'Base' : 'Quote')
  assetSymbol = assetSymbol.split('.')[0].toUpperCase()
  const tooltip = t('MM_MIN_TRANSFER_TOOLTIP')
  const value = asset === 'base'
    ? botConfig.autoRebalance?.minBaseTransfer || 0
    : botConfig.autoRebalance?.minQuoteTransfer || 0

  const min = asset === 'base' ? botConfigState.baseMinWithdraw : botConfigState.quoteMinWithdraw

  const assetID = asset === 'base' ? dexMarket.baseID : dexMarket.quoteID
  const conversionFactor = assetInfo.unitInfo.conventional.conversionFactor
  const precision = Math.round(Math.log10(conversionFactor))

  const cexAssetID = asset === 'base' ? botConfig.cexBaseID : botConfig.cexQuoteID
  const projectedAlloc = projectedAllocations(botConfigState)
  const dexAmount = projectedAlloc.dex[assetID] || 0
  const cexAmount = projectedAlloc.cex[cexAssetID] || 0
  const max = Math.max(dexAmount + cexAmount, min)

  const onChange = (value: number) => {
    const actionType = asset === 'base' ? 'BASE_MIN_TRANSFER' : 'QUOTE_MIN_TRANSFER'
    dispatch({
      type: 'UPDATE_REBALANCE_SETTINGS',
      payload: { type: actionType, payload: value }
    })
  }

  return (
    <div className="d-flex align-items-center mb-3">
      <div className="d-flex align-items-center fs16 me-3 flex-shrink-0">
        <img className="mini-icon me-1" src={logoPath(assetInfo.symbol)} alt={assetSymbol} />
        <span className="me-1">{assetSymbol}</span>
        <Tooltip content={tooltip}>
          <span className="ico-info fs12 ms-1"></span>
        </Tooltip>
      </div>
      <NumberInput
        sliderPosition="inline"
        className="p-1 text-center fs14"
        min={min / conversionFactor}
        max={max / conversionFactor}
        precision={precision}
        value={value / conversionFactor}
        onChange={(value) => onChange(Math.floor(value * conversionFactor))}
        withSlider={true}
      />
    </div>
  )
}

const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

interface BridgeFeesTableProps {
  withdrawalFees: Record<string, number>
  depositFees: Record<string, number>
}

const BridgeFeesTable: React.FC<BridgeFeesTableProps> = ({ withdrawalFees, depositFees }) => {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const allAssetIDs = [...new Set([...Object.keys(withdrawalFees), ...Object.keys(depositFees)])]

  return (
    <table className="fs14 bridge-fees-table">
      <thead>
        <tr className="fs13">
          <th></th>
          <th className="text-primary fw-normal">{t('MM_WITHDRAWAL')}</th>
          <th className="text-success fw-normal">{t('MM_DEPOSIT')}</th>
        </tr>
      </thead>
      <tbody>
        {allAssetIDs.map(assetID => {
          const asset = assets[parseInt(assetID)]
          const wFee = withdrawalFees[assetID]
          const dFee = depositFees[assetID]
          return (
            <tr key={assetID}>
              <td className="d-flex align-items-center gap-1">
                {asset && <img className="mini-icon" src={logoPath(asset.symbol)} alt={asset.symbol} />}
                <span>{asset?.name}</span>
              </td>
              <td>{wFee != null ? formatCoinAtom(wFee, asset?.unitInfo) : '\u2014'}</td>
              <td>{dFee != null ? formatCoinAtom(dFee, asset?.unitInfo) : '\u2014'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

interface BridgeControlProps {
  asset: 'base' | 'quote'
}

const BridgeControl: React.FC<BridgeControlProps> = ({
  asset
}) => {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const botConfigState = useBotConfigState()
  const { dexMarket } = botConfigState
  const dispatch = useBotConfigDispatch()
  const setIsLoading = useMMSettingsSetLoading()
  const setError = useMMSettingsSetError()

  const { botConfig } = botConfigState
  const isRunning = !!botConfigState.runStats
  const bridges = asset === 'base' ? botConfigState.baseBridges : botConfigState.quoteBridges
  const currentFeesAndLimits = asset === 'base' ? botConfigState.baseBridgeFeesAndLimits : botConfigState.quoteBridgeFeesAndLimits
  const dexAssetID = asset === 'base' ? dexMarket.baseID : dexMarket.quoteID

  if (!botConfig.autoRebalance || botConfig.autoRebalance.internalOnly || !currentFeesAndLimits) return null

  const displayBridges = { ...(bridges || {}) }
  if (currentFeesAndLimits.cexAsset !== dexAssetID && currentFeesAndLimits.bridgeName) {
    const bridgeNames = displayBridges[currentFeesAndLimits.cexAsset] || []
    if (!bridgeNames.includes(currentFeesAndLimits.bridgeName)) {
      displayBridges[currentFeesAndLimits.cexAsset] = [...bridgeNames, currentFeesAndLimits.bridgeName]
    }
  }
  if (!Object.keys(displayBridges).length) return null

  const handleCexAssetChange = async (cexAssetID: number) => {
    if (isRunning) return
    if (!displayBridges[cexAssetID] || displayBridges[cexAssetID].length === 0) return

    const bridgeName = displayBridges[cexAssetID][0]
    try {
      setIsLoading(true)
      const feesAndLimits = await fetchRoundTripFeesAndLimits(dexAssetID, cexAssetID, bridgeName)
      dispatch({
        type: 'UPDATE_BRIDGE_SELECTION',
        payload: { asset, feesAndLimits }
      })
    } catch (error) {
      setError({
        message: t('MM_FAILED_FETCH_BRIDGE_FEES')
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleBridgeChange = async (bridgeName: string) => {
    if (isRunning) return
    try {
      setIsLoading(true)
      const feesAndLimits = await fetchRoundTripFeesAndLimits(dexAssetID, currentFeesAndLimits.cexAsset, bridgeName)
      dispatch({
        type: 'UPDATE_BRIDGE_SELECTION',
        payload: { asset, feesAndLimits }
      })
    } catch (error) {
      setError({
        message: t('MM_FAILED_FETCH_BRIDGE_FEES')
      })
    } finally {
      setIsLoading(false)
    }
  }

  const assetName = asset === 'base' ? 'Base' : 'Quote'
  const availableCexAssets = Object.keys(displayBridges).map(id => parseInt(id))
  const currentCexAsset = currentFeesAndLimits.cexAsset
  const availableBridges = displayBridges[currentCexAsset]
  const currentBridge = currentFeesAndLimits.bridgeName

  return (
    <>
      <span className="fs16 demi d-block mb-2">
        {t('MM_BRIDGE_CONFIGURATION', { asset: assetName })}
        <Tooltip content={t('MM_BRIDGE_CONFIG_TOOLTIP')}>
          <span className="ico-info fs12 ms-1"></span>
        </Tooltip>
      </span>

      {isRunning && (
        <div className="fs14 text-muted mb-2">
          {t('MM_BRIDGE_LOCKED')}
        </div>
      )}

      <div className="ps-2">
        <div className="d-flex align-items-center justify-content-between mb-2">
          <span className="fs16">{t('MM_BRIDGE_TO_ASSET')}</span>
          <select
            className={`form-select ${isRunning ? 'mm-readonly-select' : ''}`}
            style={{ width: 'auto' }}
            value={currentCexAsset || ''}
            disabled={isRunning}
            onChange={(e) => handleCexAssetChange(parseInt(e.target.value))}
          >
            <option value="">{t('MM_SELECT_CEX_ASSET')}</option>
            {availableCexAssets.map(cexAssetID => (
              <option key={cexAssetID} value={cexAssetID}>
                {prettyPrintAssetID(cexAssetID, assets)}
              </option>
            ))}
          </select>
        </div>

        {availableBridges && availableBridges.length > 0 && (
          <div className="d-flex align-items-center justify-content-between mb-2">
            <span className="fs16">{t('MM_BRIDGE')}</span>
            <select
              className={`form-select ${isRunning ? 'mm-readonly-select' : ''}`}
              style={{ width: 'auto' }}
              value={currentBridge || ''}
              disabled={isRunning}
              onChange={(e) => handleBridgeChange(e.target.value)}
            >
              <option value="">{t('MM_SELECT_BRIDGE')}</option>
              {availableBridges.map(bridgeName => (
                <option key={bridgeName} value={bridgeName}>
                  {capitalize(bridgeName)}
                </option>
              ))}
            </select>
          </div>
        )}

      </div>

      {/* Bridge Fees Display */}
      <span className="fs16 d-block mt-2 mb-1">{t('MM_BRIDGE_ROUND_TRIP_FEES')}</span>
      <div className="ps-2 p-2 section-bg rounded">
        <BridgeFeesTable
          withdrawalFees={currentFeesAndLimits.withdrawal.fees}
          depositFees={currentFeesAndLimits.deposit.fees}
        />
      </div>
    </>
  )
}

export const RebalanceSettingsPanelHeader: React.FC = () => {
  const { t } = useTranslation()
  return (
    <PanelHeader
      title={t('MM_REBALANCE_SETTINGS')}
      description={t('MM_REBALANCE_DESCRIPTION')}
    />
  )
}

const RebalanceSettingsTab: React.FC = () => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const { botConfig } = botConfigState
  const dispatch = useBotConfigDispatch()

  const hasBridges = botConfigState.baseBridges || botConfigState.baseBridgeFeesAndLimits ||
    botConfigState.quoteBridges || botConfigState.quoteBridgeFeesAndLimits
  const isCexRebalance = !!botConfig.autoRebalance && !botConfig.autoRebalance.internalOnly

  const handleRebalanceTypeChange = (cexRebalance: boolean) => {
    dispatch({
      type: 'UPDATE_REBALANCE_SETTINGS',
      payload: { type: 'CEX_REBALANCE', payload: cexRebalance }
    })
  }

  return (
    <div>
      <RebalanceSettingsPanelHeader />

      <div className="border rounded p-3 mm-mixer-row">
        {/* Rebalance Method */}
        <span className="fs16 demi d-block mb-2">{t('MM_HOW_REBALANCING_WORKS')}</span>
        <div className="ps-2">
          <div className="form-check mb-2">
            <input
              className="form-check-input"
              type="radio"
              name="rebalanceMethod"
              id="cexRebalance"
              checked={isCexRebalance}
              onChange={() => handleRebalanceTypeChange(true)}
            />
            <label className="form-check-label fs16" htmlFor="cexRebalance">
              {t('MM_CEX_REBALANCE')}
            </label>
          </div>
          <div className="fs14 text-muted mb-3 ms-3">
            {t('MM_CEX_REBALANCE_DESC')}
          </div>

          <div className="form-check">
            <input
              className="form-check-input"
              type="radio"
              name="rebalanceMethod"
              id="internalTransfers"
              checked={!!botConfig.autoRebalance && botConfig.autoRebalance.internalOnly}
              onChange={() => handleRebalanceTypeChange(false)}
            />
            <label className="form-check-label fs16" htmlFor="internalTransfers">
              {t('MM_INTERNAL_TRANSFERS_ONLY')}
            </label>
          </div>
          <div className="fs14 text-muted ms-3">
            {t('MM_INTERNAL_TRANSFERS_DESC')}
          </div>
        </div>

        {/* Min Transfers - Only show if CEX Rebalance */}
        {isCexRebalance && (
          <>
            <hr className="my-3" />
            <span className="fs16 demi d-block mb-2">{t('MM_MIN_EXTERNAL_TRANSFER')}</span>
            <div className="ps-2">
              <MinTransferControl asset="base" />
              <MinTransferControl asset="quote" />
            </div>
          </>
        )}

        {/* Bridge Configs - Only show if CEX Rebalance and bridges exist */}
        {isCexRebalance && hasBridges && (
          <>
            {(botConfigState.baseBridges || botConfigState.baseBridgeFeesAndLimits) && (
              <>
                <hr className="my-3" />
                <BridgeControl asset="base" />
              </>
            )}
            {(botConfigState.quoteBridges || botConfigState.quoteBridgeFeesAndLimits) && (
              <>
                <hr className="my-3" />
                <BridgeControl asset="quote" />
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default RebalanceSettingsTab
