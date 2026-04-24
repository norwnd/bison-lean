import type { Exchange } from './types'

// for whatever reason current DEX server(s) are configured to have insanely large rate-step,
// I guess this allows for tweaking prices very precisely but at a detriment to how all rates
// are displayed in UI (markets page is especially affected by this) - hence to remedy this
// we introduce "magnifying factors" (these are different for every market) that let us cut
// down high rate-step precision so that rate/price numbers look better in UI
const rateStepMagnifyingFactors: Record<string, number> = {
  'dcr_usdc.polygon': 1000,
  'dcr_usdt.polygon': 1000,
  'ltc_usdt.polygon': 1000,
  'dcr_btc': 1, // this one is already fine
  'usdc.polygon_usdt.polygon': 1000,
  'btc_usdt.polygon': 1000,
  'dcr_polygon': 1000000
}

export function applyRateStepMagnifyingFactors (exchanges: Record<string, Exchange>): void {
  for (const xc of Object.values(exchanges)) {
    for (const [mktId, mkt] of Object.entries(xc.markets || {})) {
      const factor = rateStepMagnifyingFactors[mktId]
      if (factor) mkt.ratestep = mkt.ratestep * factor
    }
  }
}
