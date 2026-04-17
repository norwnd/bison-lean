// ManualAllocation — per-asset balance-entry sliders for an mmsettings
// bot when the user opts out of the auto-estimated quick allocation.
// Ported from vanilla `mmsettings/components/ManualAllocation.tsx`.
//
// `AllocationPanelHeader` + `AllocationModeNote` are shared helpers
// living in `./QuickAllocation` (ported in the same batch). Vanilla's
// `app().assets` / `Doc.logoPath` / `prep(ID_X)` map to
// `useAuthStore(s => s.assets)` / `logoPath` / `t('X')`.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useBotConfigState, useBotConfigDispatch, editableAmounts } from './utils/BotConfig'
import { requiredDexAssets } from './utils/AllocationUtil'
import { CEXDisplayInfos } from './cexDisplayInfo'
import { AllocationModeNote, AllocationPanelHeader } from './QuickAllocation'
import { NumberInput } from './FormComponents'
import { logoPath } from '../../hooks/useFormatters'
import { useAuthStore } from '../../stores/useAuthStore'

interface ManualBalanceEntryProps {
  assetID: number
  location: 'dex' | 'cex'
}

const ManualBalanceEntry: React.FC<ManualBalanceEntryProps> = ({
  assetID,
  location
}) => {
  const assets = useAuthStore(s => s.assets)
  const botConfigState = useBotConfigState()
  const {
    runStats, availableCEXBalances, availableDEXBalances
  } = botConfigState
  const editableBalanceAmounts = editableAmounts(botConfigState)
  const dispatch = useBotConfigDispatch()

  const asset = assets[assetID]
  const availableBalance = location === 'dex'
    ? (availableDEXBalances[assetID] || 0)
    : (availableCEXBalances?.[assetID] || 0)
  let runningBotAvailable = 0
  if (runStats) {
    runningBotAvailable = location === 'dex'
      ? (runStats.dexBalances[assetID]?.available || 0)
      : (runStats.cexBalances[assetID]?.available || 0)
  }
  const currentValue = editableBalanceAmounts[location][assetID] || 0

  return (
    <div className="d-flex align-items-center mb-2 mm-mixer-row">
      <div className="d-flex align-items-center flex-shrink-0 mm-mixer-label">
        <img
          className="micro-icon me-1"
          src={logoPath(asset.symbol)}
          alt={asset.symbol}
        />
        <span className="fs14">{asset.unitInfo.conventional.unit}</span>
      </div>
      <div className="flex-grow-1">
        <NumberInput
          sliderPosition="inline"
          className="p-1 text-center fs14"
          withSlider={true}
          min={-runningBotAvailable / asset.unitInfo.conventional.conversionFactor}
          max={availableBalance / asset.unitInfo.conventional.conversionFactor}
          precision={Math.round(Math.log10(asset.unitInfo.conventional.conversionFactor))}
          value={currentValue / asset.unitInfo.conventional.conversionFactor}
          onChange={(amount: number) => dispatch({
            type: 'UPDATE_MANUAL_ALLOCATION',
            payload: { assetID, amount: amount * asset.unitInfo.conventional.conversionFactor, source: location }
          })}
        />
      </div>
    </div>
  )
}

const ManualAllocationView: React.FC = () => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const { botConfig, runStats } = botConfigState

  const dexAssetIDs = requiredDexAssets(botConfigState)

  return (
    <div>
      <AllocationPanelHeader description={t('MM_MANUAL_ALLOC_DESC')} />
      <AllocationModeNote isRunning={!!runStats} mode="manual" />

      <div className="row">
        <div className={`col-24 mb-3 ${botConfig.cexName ? 'col-md-12 pe-md-2' : ''}`}>
          <div className="border rounded p-3 h-100">
            <div className="d-flex align-items-center mb-3">
              <img className="logo-square mini-icon me-3" src={logoPath('DEX')} alt="DEX" />
              <span className="fs16 demi">Bison Wallet Balances</span>
            </div>
            {dexAssetIDs.map(assetID => (
              <ManualBalanceEntry key={assetID} assetID={assetID} location='dex' />
            ))}
          </div>
        </div>

        {botConfig.cexName && CEXDisplayInfos[botConfig.cexName] && (
          <div className="col-24 col-md-12 ps-md-2 mb-3">
            <div className="border rounded p-3 h-100">
              <div className="d-flex align-items-center mb-3">
                <img className="mini-icon me-3" src={CEXDisplayInfos[botConfig.cexName].logo} alt="CEX" />
                <span className="fs16 demi">{t('CEX_BALANCES', { cexName: CEXDisplayInfos[botConfig.cexName].name })}</span>
              </div>
              {[botConfig.cexBaseID, botConfig.cexQuoteID].map(assetID => (
                <ManualBalanceEntry key={assetID} assetID={assetID} location='cex' />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ManualAllocationView
