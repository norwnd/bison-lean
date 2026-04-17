// BotPlacementsTab — tab content that picks between the quick and
// advanced placement views for an mmsettings bot, keyed on whether
// the reducer is currently in quick-placements mode. Ported from
// vanilla `mmsettings/components/BotPlacementsTab.tsx`.

import React from 'react'
import { useBotConfigState } from './utils/BotConfig'
import { AdvancedPlacements } from './AdvancedPlacements'
import { QuickPlacements } from './QuickPlacements'

const BotPlacementsTab: React.FC = () => {
  const { quickPlacements } = useBotConfigState()

  return (
    <div>
      {quickPlacements
        ? <QuickPlacements />
        : <AdvancedPlacements />}
    </div>
  )
}

export default BotPlacementsTab
