// React wrapper around the imperative `PlacementsChart` ported from
// vanilla `mmsettings/components/PlacementsChartWrapper.tsx`.
//
// The chart itself is a canvas-rendering class (no React state of its
// own); this component owns the lifecycle: instantiate on mount,
// `setMarket()` whenever the relevant slice of `BotConfigState`
// changes, tear down on unmount. Sorting placements by gap factor
// mirrors vanilla (the chart renders from closest-to-mid outward).

import React from 'react'
import { useBotConfigState } from './utils/BotConfig'
import { PlacementsChart, PlacementChartConfig } from './PlacementsChart'
import { botTypeBasicMM, botTypeArbMM, botTypeBasicArb } from './botTypes'
import type { OrderPlacement } from '../../stores/types'

const PlacementsChartWrapper: React.FC = () => {
  const chartRef = React.useRef<HTMLDivElement>(null)
  const chartInstanceRef = React.useRef<PlacementsChart | null>(null)
  const { botConfig, dexMarket, quickPlacements, fiatRatesMap } = useBotConfigState()

  React.useEffect(() => {
    if (chartRef.current && !chartInstanceRef.current) {
      chartInstanceRef.current = new PlacementsChart(chartRef.current)
    }
    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy()
        chartInstanceRef.current = null
      }
    }
  }, [])

  const chartConfig = React.useMemo<PlacementChartConfig | null>(() => {
    if (!botConfig || !dexMarket) return null
    const isBasicMM = !!botConfig.basicMarketMakingConfig
    const isArbMM = !!botConfig.arbMarketMakingConfig

    let buyPlacements: OrderPlacement[] = []
    let sellPlacements: OrderPlacement[] = []
    let profit = 0

    if (isBasicMM && botConfig.basicMarketMakingConfig) {
      buyPlacements = [...botConfig.basicMarketMakingConfig.buyPlacements]
      sellPlacements = [...botConfig.basicMarketMakingConfig.sellPlacements]
      profit = quickPlacements?.profitThreshold || 0
    } else if (isArbMM && botConfig.arbMarketMakingConfig) {
      buyPlacements = botConfig.arbMarketMakingConfig.buyPlacements.map(placement => ({
        lots: placement.lots,
        gapFactor: placement.multiplier
      }))
      sellPlacements = botConfig.arbMarketMakingConfig.sellPlacements.map(placement => ({
        lots: placement.lots,
        gapFactor: placement.multiplier
      }))
      profit = botConfig.arbMarketMakingConfig.profit || 0
    }

    buyPlacements.sort((a, b) => a.gapFactor - b.gapFactor)
    sellPlacements.sort((a, b) => a.gapFactor - b.gapFactor)

    return {
      cexName: botConfig.cexName,
      botType: isBasicMM ? botTypeBasicMM : isArbMM ? botTypeArbMM : botTypeBasicArb,
      baseFiatRate: fiatRatesMap[dexMarket.baseID] || 1,
      dict: {
        profit,
        buyPlacements,
        sellPlacements
      }
    }
  }, [botConfig, dexMarket, quickPlacements, fiatRatesMap])

  React.useEffect(() => {
    if (chartInstanceRef.current && chartConfig) {
      chartInstanceRef.current.setMarket(chartConfig)
    }
  }, [chartConfig])

  return (
    <div
      ref={chartRef}
      className="placements-chart-wrapper"
    />
  )
}

export default PlacementsChartWrapper
