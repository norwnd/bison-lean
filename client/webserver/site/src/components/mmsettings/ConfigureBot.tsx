// ConfigureBot - main editor for a saved/in-progress market-maker bot
// configuration. Ported from vanilla
// `mmsettings/components/ConfigureBot.tsx`.
//
// Layout is responsive via `useBootstrapBreakpoints`: large viewports
// get a sidebar-style split (market/type/actions on the left, tab
// content on the right), medium uses a compact header + horizontal
// tabs, small stacks everything.
//
// Lean adapts:
//   * `app().loadPage('mm')` → `useNavigate()` + `navigate(ROUTES.MM)`
//     (triggered after save/start/delete/update to return to /mm)
//   * `app().fetchMMStatus()` → `useMMStore.getState().fetchMMStatus()`
//   * `app().checkResponse(res)` → `res.ok` (mmApi result objects
//     already carry a boolean `ok` plus optional `msg`)
//   * `MM.xxx` → direct `updateBotConfig` / `startBot` / etc. from
//     `services/mmApi`
//   * `renderSymbol(assetID, symbol)` → `<AssetSymbol asset={asset} />`
//     from `components/common/AssetSymbol` - the lean-wide token-aware
//     symbol renderer that the other mmsettings components already use
//   * `prep(ID_MM_X)` → `t('MM_X')` via `useTranslation()`

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { logoPath } from '../../hooks/useFormatters'
import { useBootstrapBreakpoints } from '../../hooks/usePageSizeBreakpoints'
import { useMMStore } from '../../stores/useMMStore'
import {
  updateBotConfig,
  startBot,
  removeBotConfig,
  updateRunningBot,
} from '../../services/mmApi'
import { ROUTES } from '../../router/routes'
import { AssetSymbol } from '../common/AssetSymbol'
import { useBotConfigState, buildRunningBotUpdatePayload } from './utils/BotConfig'
import { useMMSettingsSetError } from './MMSettings'
import BotPlacementsTab from './BotPlacementsTab'
import BotAllocationsTab from './BotAllocationsTab'
import BotSettingsTab from './BotSettingsTab'
import RebalanceSettingsTab from './RebalanceSettingsTab'
import Popup from './Popup'

type ActiveTab = 'placements' | 'allocations' | 'settings' | 'rebalanceSettings'

interface MarketButtonProps {
  onChangeMarket: () => void
}

const MarketButton: React.FC<MarketButtonProps> = ({ onChangeMarket }) => {
  const botConfigState = useBotConfigState()
  const mkt = botConfigState.dexMarket

  return (
    <div className="configure-bot-market-display mb-2 hoverbg pointer" onClick={onChangeMarket}>
      <div className="d-flex align-items-center fs20 lh1 pb-1">
        <img className="mini-icon" src={logoPath(mkt.baseAsset.symbol)} alt={mkt.baseAsset.symbol} />
        <img className="mx-1 mini-icon" src={logoPath(mkt.quoteAsset.symbol)} alt={mkt.quoteAsset.symbol} />
        <AssetSymbol asset={mkt.baseAsset} useLogo />&ndash;<AssetSymbol asset={mkt.quoteAsset} useLogo />
        <span className="ico-edit fs16 ms-2 grey"></span>
      </div>
      <div className="fs14 grey">
        <span className="me-1">@</span>
        <span>{mkt.host}</span>
      </div>
    </div>
  )
}

interface BotTypeButtonProps {
  onChangeBotType: () => void
}

const BotTypeButton: React.FC<BotTypeButtonProps> = ({ onChangeBotType }) => {
  const { t } = useTranslation()
  const botConfigState = useBotConfigState()
  const cfg = botConfigState.botConfig

  const botTypeLabel = (() => {
    if (cfg.basicMarketMakingConfig) return t('MM_BASIC_MARKET_MAKER')
    if (cfg.arbMarketMakingConfig) return t('MM_MM_PLUS_ARB')
    if (cfg.simpleArbConfig) return t('MM_BASIC_ARBITRAGE')
    return t('MM_UNKNOWN')
  })()

  return (
    <div className="configure-bot-bot-type-display mb-2 hoverbg pointer" onClick={onChangeBotType}>
      <div className="d-flex align-items-center lh1 pb-1">
        <div className="fs20">{botTypeLabel}</div>
        <span className="ico-edit fs16 ms-2 grey"></span>
      </div>
    </div>
  )
}

interface BotActionButtonsProps {
  layout?: 'column' | 'row'
}

const BotActionButtons: React.FC<BotActionButtonsProps> = ({ layout = 'column' }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fetchMMStatus = useMMStore(s => s.fetchMMStatus)
  const botConfigState = useBotConfigState()
  const setError = useMMSettingsSetError()
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false)

  const returnToMM = () => navigate(ROUTES.MM)

  const handleSaveSettings = async () => {
    const res = await updateBotConfig(botConfigState.botConfig)
    if (!res.ok) {
      setError({ message: t('MM_FAILED_SAVE_BOT_CONFIG') + (res.msg ?? '') })
      return
    }
    await fetchMMStatus()
    returnToMM()
  }

  const handleStart = async () => {
    const saveRes = await updateBotConfig(botConfigState.botConfig)
    if (!saveRes.ok) {
      setError({ message: t('MM_FAILED_SAVE_BOT_CONFIG') + (saveRes.msg ?? '') })
      return
    }
    const startRes = await startBot({
      baseID: botConfigState.dexMarket.baseID,
      quoteID: botConfigState.dexMarket.quoteID,
      host: botConfigState.dexMarket.host,
    })
    if (!startRes.ok) {
      setError({ message: t('MM_FAILED_START_BOT') + (startRes.msg ?? '') })
      return
    }
    await fetchMMStatus()
    returnToMM()
  }

  const handleDeleteBotClick = () => setShowDeleteConfirmation(true)
  const cancelDeleteBot = () => setShowDeleteConfirmation(false)

  const confirmDeleteBot = async () => {
    setShowDeleteConfirmation(false)
    const res = await removeBotConfig(
      botConfigState.botConfig.host,
      botConfigState.botConfig.baseID,
      botConfigState.botConfig.quoteID
    )
    if (!res.ok) {
      setError({ message: t('MM_FAILED_DELETE_BOT') + (res.msg ?? '') })
      return
    }
    await fetchMMStatus()
    returnToMM()
  }

  const handleUpdateRunningBot = async () => {
    try {
      const { cfg, diffs } = buildRunningBotUpdatePayload(botConfigState)
      const res = await updateRunningBot(cfg, diffs, cfg.autoRebalance)
      if (!res.ok) {
        setError({ message: t('MM_FAILED_UPDATE_RUNNING') + (res.msg ?? '') })
        return
      }
      await fetchMMStatus()
      returnToMM()
    } catch (error) {
      setError({ message: t('MM_FAILED_UPDATE_RUNNING') + String(error) })
    }
  }

  if (botConfigState.runStats) {
    return (
      <div className="py-2 mb-1">
        <button className="btn btn-outline-primary go w-100" onClick={handleUpdateRunningBot}>
          {t('MM_UPDATE_RUNNING_BOT')}
        </button>
      </div>
    )
  }

  const isRow = layout === 'row'

  return (
    <>
      <div className="py-2 mb-1">
        <div className={`mm-action-primary ${isRow ? 'flex-row' : 'flex-column'}`}>
          <button className={`btn btn-outline-primary go ${isRow ? 'flex-fill' : 'w-100 mb-1'}`} onClick={handleStart}>
            {t('MM_START_BOT')} <span className="ico-arrowright ms-1"></span>
          </button>
          <button className={`btn btn-primary ${isRow ? 'flex-fill' : 'w-100'}`} onClick={handleSaveSettings}>
            {t('MM_SAVE_SETTINGS')}
          </button>
        </div>
        <div className="mm-action-danger">
          <button className={`btn btn-primary danger ${isRow ? '' : 'w-100'} small`} onClick={handleDeleteBotClick}>
            {t('MM_DELETE_BOT')}
          </button>
        </div>
      </div>
      {showDeleteConfirmation && (
        <Popup
          message={t('MM_CONFIRM_DELETE')}
          buttons={[
            { text: t('MM_CANCEL'), onClick: cancelDeleteBot },
            { text: t('MM_DELETE'), onClick: confirmDeleteBot, className: 'danger' },
          ]}
          onClose={cancelDeleteBot}
        />
      )}
    </>
  )
}

interface BotTabNavigationProps {
  activeTab: ActiveTab
  onTabChange: (tab: ActiveTab) => void
  layout?: 'horizontal' | 'vertical'
}

const BotTabNavigation: React.FC<BotTabNavigationProps> = ({
  activeTab,
  onTabChange,
  layout = 'horizontal',
}) => {
  const { t } = useTranslation()
  const cfg = useBotConfigState().botConfig
  const isVertical = layout === 'vertical'
  const navClass = isVertical ? 'mm-tab-nav-vertical' : 'mm-tab-nav'

  return (
    <div className={navClass}>
      {!cfg.simpleArbConfig && (
        <div
          className={`configure-bot-tab-section ${activeTab === 'placements' ? 'active' : ''}`}
          onClick={() => onTabChange('placements')}
        >
          <div className="fs16 fw-semibold">{t('MM_PLACEMENTS')}</div>
        </div>
      )}
      <div
        className={`configure-bot-tab-section ${activeTab === 'allocations' ? 'active' : ''}`}
        onClick={() => onTabChange('allocations')}
      >
        <div className="fs16 fw-semibold">{t('MM_ALLOCATIONS')}</div>
      </div>
      <div
        className={`configure-bot-tab-section ${activeTab === 'settings' ? 'active' : ''}`}
        onClick={() => onTabChange('settings')}
      >
        <div className="fs16 fw-semibold">{t('MM_SETTINGS')}</div>
      </div>
      {cfg.cexName && (
        <div
          className={`configure-bot-tab-section ${activeTab === 'rebalanceSettings' ? 'active' : ''}`}
          onClick={() => onTabChange('rebalanceSettings')}
        >
          <div className="fs16 fw-semibold">{t('MM_REBALANCE_SETTINGS')}</div>
        </div>
      )}
    </div>
  )
}

interface ConfigureBotProps {
  onChangeMarket: () => void
  onChangeBotType: () => void
}

const ConfigureBot: React.FC<ConfigureBotProps> = ({ onChangeMarket, onChangeBotType }) => {
  const botConfigState = useBotConfigState()
  const cfg = botConfigState.botConfig
  const initialTab: ActiveTab = cfg.simpleArbConfig ? 'settings' : 'placements'
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab)
  const pageSize = useBootstrapBreakpoints(['md', 'lg', 'xl'])

  const currentTabContent = () => {
    if (activeTab === 'placements') return <BotPlacementsTab />
    if (activeTab === 'allocations') return <BotAllocationsTab />
    if (activeTab === 'settings') return <BotSettingsTab />
    if (activeTab === 'rebalanceSettings') return <RebalanceSettingsTab />
    return null
  }

  const isLargeScreen = pageSize === 'lg' || pageSize === 'xl'
  const isMediumScreen = pageSize === 'md'

  if (isLargeScreen) {
    return (
      <div className="mm-settings-container px-4 py-3">
        <div className="d-flex align-items-start">
          <section className="mm-sidebar py-2 me-3">
            <MarketButton onChangeMarket={onChangeMarket} />
            <BotTypeButton onChangeBotType={onChangeBotType} />
            <BotActionButtons />
            <div className="mt-2">
              <BotTabNavigation activeTab={activeTab} onTabChange={setActiveTab} layout="vertical" />
            </div>
          </section>
          <section className="mm-content flex-grow-1 p-3">
            {currentTabContent()}
          </section>
        </div>
      </div>
    )
  }

  if (isMediumScreen) {
    return (
      <div className="mm-settings-container px-3 py-3">
        <div className="mm-header-row mb-2">
          <MarketButton onChangeMarket={onChangeMarket} />
          <BotTypeButton onChangeBotType={onChangeBotType} />
        </div>
        <BotActionButtons layout="row" />
        <div className="mb-3">
          <BotTabNavigation activeTab={activeTab} onTabChange={setActiveTab} layout="horizontal" />
        </div>
        <section>{currentTabContent()}</section>
      </div>
    )
  }

  // Small screen: stacked layout with scrollable tabs.
  return (
    <div className="mm-settings-container px-2 py-2">
      <MarketButton onChangeMarket={onChangeMarket} />
      <BotTypeButton onChangeBotType={onChangeBotType} />
      <BotActionButtons layout="row" />
      <div className="mm-tab-scroll mb-3">
        <BotTabNavigation activeTab={activeTab} onTabChange={setActiveTab} layout="horizontal" />
      </div>
      <section>{currentTabContent()}</section>
    </div>
  )
}

export default ConfigureBot
