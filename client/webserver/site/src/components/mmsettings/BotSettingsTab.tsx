// BotSettingsTab - live-bot knobs (drift, order persistence), per-wallet
// multi-funding options, multi-hop arb settings, and the snapshots
// checkbox. Ported from vanilla `mmsettings/components/BotSettingsTab.tsx`.
//
// Vanilla's `prep(ID_MM_X)` becomes `t('MM_X')`; `Doc.logoPath` /
// `Doc.shortSymbol` come from the lean `hooks/useFormatters` helpers;
// `app().assets[id]` resolves via `useAuthStore(s => s.assets)`.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderOption } from '../../stores/types'
import { useBotConfigState, useBotConfigDispatch } from './utils/BotConfig'
import Tooltip from '../common/Tooltip'
import { PanelHeader, NumberInput } from './FormComponents'
import { logoPath, shortSymbol } from '../../hooks/useFormatters'
import { useAuthStore } from '../../stores/useAuthStore'

export const SettingsPanelHeader: React.FC = () => {
  const { t } = useTranslation()
  return (
    <PanelHeader
      title={t('MM_SETTINGS')}
      description={t('MM_SETTINGS_DESC')}
    />
  )
}

const MultiHopSettings: React.FC = () => {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const botConfigState = useBotConfigState()
  const dispatch = useBotConfigDispatch()

  const { intermediateAssets, intermediateAsset, botConfig } = botConfigState
  const isRunning = !!botConfigState.runStats
  const multiHopConfig = botConfig.arbMarketMakingConfig?.multiHop
  const currentIntermediateAsset = multiHopConfig
    ? (multiHopConfig.baseAssetMarket[0] === botConfig.cexBaseID
        ? multiHopConfig.baseAssetMarket[1]
        : multiHopConfig.baseAssetMarket[0])
    : intermediateAsset
  const displayIntermediateAssets = intermediateAssets ? [...intermediateAssets] : []
  if (currentIntermediateAsset != null && !displayIntermediateAssets.includes(currentIntermediateAsset)) {
    displayIntermediateAssets.push(currentIntermediateAsset)
  }
  if (displayIntermediateAssets.length === 0) {
    return null
  }

  const marketOrders = multiHopConfig?.marketOrders ?? false
  const limitOrdersBuffer = multiHopConfig?.limitOrdersBuffer ?? 0.01

  const handleIntermediateAssetChange = (assetID: number) => {
    if (isRunning) return
    dispatch({ type: 'UPDATE_INTERMEDIATE_ASSET', payload: assetID })
  }

  const handleOrderTypeChange = (isMarketOrder: boolean) => {
    if (isRunning) return
    dispatch({ type: 'UPDATE_MULTI_HOP_MARKET_COMPLETION', payload: isMarketOrder })
  }

  const handleLimitBufferChange = (value: number) => {
    if (isRunning) return
    dispatch({ type: 'UPDATE_MULTI_HOP_LIMIT_BUFFER', payload: value / 100 })
  }

  return (
    <>
      {isRunning && (
        <div className="fs14 text-muted mb-2">
          {t('MM_MULTI_HOP_LOCKED')}
        </div>
      )}

      {/* Intermediate Asset */}
      <div className="d-flex align-items-center justify-content-between mb-2">
        <div className="d-flex align-items-center">
          <span className="fs16">{t('MM_INTERMEDIATE_ASSET')}</span>
          <Tooltip content={t('MM_INTERMEDIATE_ASSET_TOOLTIP')}>
            <span className="ico-info fs12 ms-1"></span>
          </Tooltip>
        </div>
        <select
          className={`form-select ${isRunning ? 'mm-readonly-select' : ''}`}
          style={{ width: 'auto' }}
          value={currentIntermediateAsset ?? ''}
          disabled={isRunning}
          onChange={(e) => handleIntermediateAssetChange(parseInt(e.target.value))}
        >
          {displayIntermediateAssets.map(assetID => (
            <option key={assetID} value={assetID}>
              {assets[assetID]?.symbol ? shortSymbol(assets[assetID].symbol) : `Asset ${assetID}`}
            </option>
          ))}
        </select>
      </div>

      {/* Completion Order Type */}
      <div className="d-flex align-items-center justify-content-between mb-2">
        <div className="d-flex align-items-center">
          <span className="fs16">{t('MM_COMPLETION_ORDER_TYPE')}</span>
          <Tooltip content={t('MM_COMPLETION_ORDER_TYPE_TOOLTIP')}>
            <span className="ico-info fs12 ms-1"></span>
          </Tooltip>
        </div>
        <div className={`d-flex gap-3 ${isRunning ? 'mm-readonly-radio-group' : ''}`}>
          <div className="form-check pe-2">
            <input
              className="form-check-input"
              type="radio"
              name="orderType"
              id="marketOrder"
              checked={marketOrders}
              disabled={isRunning}
              onChange={() => handleOrderTypeChange(true)}
            />
            <label className="form-check-label" htmlFor="marketOrder">
              {t('MM_MARKET_ORDER_CAPITALIZE')}
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="radio"
              name="orderType"
              id="limitOrder"
              checked={!marketOrders}
              disabled={isRunning}
              onChange={() => handleOrderTypeChange(false)}
            />
            <label className="form-check-label" htmlFor="limitOrder">
              {t('MM_LIMIT_ORDER_CAPITALIZE')}
            </label>
          </div>
        </div>
      </div>

      {/* Market order warning */}
      {marketOrders && (
        <div className="fs14 text-danger mb-2">
          {t('MM_MARKET_ORDER_WARNING')}
        </div>
      )}

      {/* Limit Orders Buffer Slider - Only show when limit orders are selected */}
      {!marketOrders && (
        <div className="d-flex align-items-center">
          <div className="fs16 me-3 flex-shrink-0">
            {t('MM_LIMIT_BUFFER')}
            <Tooltip content={t('MM_LIMIT_BUFFER_TOOLTIP')}>
              <span className="ico-info fs12 ms-1"></span>
            </Tooltip>
          </div>
          <NumberInput
            sliderPosition="inline"
            className={isRunning ? 'p-1 text-center fs14 mm-readonly-input' : 'p-1 text-center fs14'}
            min={0.1}
            max={2.0}
            precision={2}
            value={limitOrdersBuffer * 100}
            onChange={handleLimitBufferChange}
            withSlider={true}
            disabled={isRunning}
            suffix="%"
          />
        </div>
      )}
    </>
  )
}

interface IndividualWalletSettingsProps {
  asset: 'base' | 'quote'
  options: OrderOption[] | null
  optionsState: Record<string, string> | null
  onSettingChange: (asset: 'base' | 'quote', key: string, value: string) => void
}

const IndividualWalletSettings: React.FC<IndividualWalletSettingsProps> = ({
  asset,
  options,
  optionsState,
  onSettingChange
}) => {
  const { t } = useTranslation()

  if (!options || options.length === 0) {
    return (
      <span className="fs14 fst-italic grey">{t('MM_NO_CONFIG_OPTIONS')}</span>
    )
  }

  return (
    <div className="d-flex flex-column gap-2">
      {options.map((opt: OrderOption) => {
        if (opt.quoteAssetOnly && asset === 'base') return null

        if (opt.dependsOn && ((optionsState?.[opt.dependsOn] || 'false') !== 'true')) return null

        const currentValue = optionsState?.[opt.key] || opt.default?.toString() || ''

        if (opt.isboolean) {
          return (
            <div key={opt.key} className="d-flex align-items-center">
              <div className="form-check">
                <input
                  className="form-check-input me-2"
                  type="checkbox"
                  id={`${asset}-${opt.key}`}
                  checked={currentValue === 'true'}
                  onChange={(e) => onSettingChange(asset, opt.key, e.target.checked ? 'true' : 'false')}
                />
                <label className="form-check-label" htmlFor={`${asset}-${opt.key}`}>
                  {opt.displayname}
                </label>
                {opt.description && (
                  <Tooltip content={opt.description}>
                    <span className="ico-info fs12 ms-1"></span>
                  </Tooltip>
                )}
              </div>
            </div>
          )
        }

        if (opt.xyRange) {
          const { start, end, xUnit } = opt.xyRange
          const numericValue = parseFloat(currentValue) || start.x

          return (
            <div key={opt.key} className="d-flex align-items-center">
              <div className="fs16 me-3 flex-shrink-0">
                {opt.displayname}
                {opt.description && (
                  <Tooltip content={opt.description}>
                    <span className="ico-info fs12 ms-1"></span>
                  </Tooltip>
                )}
              </div>
              <NumberInput
                sliderPosition="inline"
                className="p-1 text-center fs14"
                min={start.x}
                max={end.x}
                precision={0}
                value={numericValue}
                onChange={(value) => onSettingChange(asset, opt.key, value.toString())}
                withSlider={true}
                suffix={xUnit}
              />
            </div>
          )
        }

        return null
      })}
    </div>
  )
}

const BotSettingsTab: React.FC = () => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const { botConfig, dexMarket, baseMultiFundingOpts, quoteMultiFundingOpts, intermediateAssets } = botConfigState
  const dispatch = useBotConfigDispatch()

  const driftTolerance = botConfig.basicMarketMakingConfig?.driftTolerance ??
                         botConfig.arbMarketMakingConfig?.driftTolerance ?? 0.001
  const orderPersistence = botConfig.arbMarketMakingConfig?.orderPersistence ??
    botConfig.simpleArbConfig?.numEpochsLeaveOpen ?? 2

  const hasKnobs = !!(botConfig.arbMarketMakingConfig || botConfig.basicMarketMakingConfig || botConfig.simpleArbConfig)
  const hasMultiHop = (intermediateAssets && intermediateAssets.length > 0) || !!botConfig.arbMarketMakingConfig?.multiHop

  const baseAsset = dexMarket.baseAsset
  const quoteAsset = dexMarket.quoteAsset

  const handleWalletSettingChange = (asset: 'base' | 'quote', key: string, value: string) => {
    dispatch({
      type: 'UPDATE_WALLET_SETTING',
      payload: { asset, key, value }
    })
  }

  return (
    <div>
      <SettingsPanelHeader />

      <div className="border rounded p-3 mm-mixer-row">
        {/* Knobs Section */}
        {hasKnobs && (
          <>
            <span className="fs16 demi d-block mb-2">{t('MM_TRADING')}</span>
            <div className="d-flex flex-column gap-3 ps-2">
              {(botConfig.arbMarketMakingConfig || botConfig.basicMarketMakingConfig) && (
                <div className="d-flex align-items-center">
                  <div className="fs16 me-3 flex-shrink-0">
                    {t('MM_DRIFT_TOLERANCE')}
                    <Tooltip content={t('MM_DRIFT_TOLERANCE_TOOLTIP')}>
                      <span className="ico-info fs12 ms-1"></span>
                    </Tooltip>
                  </div>
                  <NumberInput
                    sliderPosition="inline"
                    className="p-1 text-center fs14"
                    min={0.01}
                    max={1}
                    precision={2}
                    value={driftTolerance * 100}
                    onChange={(value) => dispatch({
                      type: 'UPDATE_DRIFT_TOLERANCE',
                      payload: value / 100
                    })}
                    withSlider={true}
                    suffix="%"
                  />
                </div>
              )}

              {(botConfig.arbMarketMakingConfig || botConfig.simpleArbConfig) && (
                <div className="d-flex align-items-center">
                  <div className="fs16 me-3 flex-shrink-0">
                    {t('MM_ORDER_PERSISTENCE')}
                    <Tooltip content={t('MM_ORDER_PERSISTENCE_TOOLTIP')}>
                      <span className="ico-info fs12 ms-1"></span>
                    </Tooltip>
                  </div>
                  <NumberInput
                    sliderPosition="inline"
                    className="p-1 text-center fs14"
                    min={2}
                    max={40}
                    precision={0}
                    value={orderPersistence}
                    onChange={(value) => dispatch({
                      type: 'UPDATE_ORDER_PERSISTENCE',
                      payload: value
                    })}
                    withSlider={true}
                    suffix="epochs"
                  />
                </div>
              )}
            </div>
            <hr className="my-3" />
          </>
        )}

        {/* Wallet Settings Section */}
        <div className="mb-1">
          <div className="d-flex align-items-center mb-2">
            <img className="mini-icon me-1" src={logoPath(baseAsset.symbol)} alt={baseAsset.symbol} />
            <span className="fs16 demi">{baseAsset.unitInfo.conventional.unit} Wallet</span>
          </div>
          <IndividualWalletSettings
            asset="base"
            options={baseMultiFundingOpts}
            optionsState={botConfig.baseWalletOptions ?? null}
            onSettingChange={handleWalletSettingChange}
          />
        </div>

        <hr className="my-3" />

        <div className="mb-1">
          <div className="d-flex align-items-center mb-2">
            <img className="mini-icon me-1" src={logoPath(quoteAsset.symbol)} alt={quoteAsset.symbol} />
            <span className="fs16 demi">{quoteAsset.unitInfo.conventional.unit} Wallet</span>
          </div>
          <IndividualWalletSettings
            asset="quote"
            options={quoteMultiFundingOpts}
            optionsState={botConfig.quoteWalletOptions ?? null}
            onSettingChange={handleWalletSettingChange}
          />
        </div>

        {/* Multi-Hop Section */}
        {hasMultiHop && (
          <>
            <hr className="my-3" />
            <div>
              <span className="fs16 demi d-block mb-2">{t('MM_MULTI_HOP_ARB')}</span>
              <div className="ps-2">
                <MultiHopSettings />
              </div>
            </div>
          </>
        )}

        {/* Snapshots */}
        <hr className="my-3" />
        <div className="form-check">
          <input
            className="form-check-input me-2"
            type="checkbox"
            id="mmSnapshots"
            checked={botConfig.mmSnapshots ?? false}
            onChange={(e) => dispatch({ type: 'TOGGLE_MM_SNAPSHOTS', payload: e.target.checked })}
          />
          <label className="form-check-label" htmlFor="mmSnapshots">
            {t('MM_COLLECT_SNAPSHOTS')}
          </label>
          <Tooltip content={t('MM_COLLECT_SNAPSHOTS_TOOLTIP')}>
            <span className="ico-info fs12 ms-1"></span>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export default BotSettingsTab
