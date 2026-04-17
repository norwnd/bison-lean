// MMSettings — the market-maker settings shell. Ported from vanilla
// `mmsettings/components/MMSettings.tsx` as the final piece of the
// MMS-01 module port.
//
// The shell is responsible for:
//   * owning the `BotConfigState` reducer + in-flight fee refreshes
//   * bridging balance / CEX-balance notes from the page into the
//     reducer via `useImperativeHandle` (page uses a React ref)
//   * deciding whether to show `MarketSelector`, `BotTypeSelector` or
//     `ConfigureBot` based on what the user has picked
//   * providing `BotConfigState` / `Dispatch` / error / loading contexts
//     to descendants so tab components can read/update without prop
//     drilling
//
// Lean adapts:
//   * `app().assets / walletMap / exchanges` → `useAuthStore.getState()`
//     reads inside callbacks (market pick validation) and typed props
//     from the page where it's cleaner
//   * `app().loadPage('mm')` → `useNavigate()` + `navigate(ROUTES.MM)`
//   * `MM.status() / availableBalances()` → raw `mmStatus()` /
//     `availableBalances()` from `services/mmApi`
//   * `Doc.logoPath` / `renderSymbol` → not used here; `ConfigureBot`
//     uses `<AssetSymbol />` from `components/common/AssetSymbol`
//     for parent-chain-aware symbol rendering
//   * `State.storeLocal(specLK, ...)` → `storeLocal(lastMMSpecsLK, ...)`
//     from `services/state`
//   * `prep(ID_MM_X)` → `t('MM_X')` via `useTranslation()`

import {
  useReducer,
  useState,
  useEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  createContext,
  useContext,
} from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'
import { ApprovalStatus } from '../../stores/types'
import type {
  MMCEXStatus,
  BalanceNote,
  CEXBalanceUpdate,
  SupportedAsset,
} from '../../stores/types'
import {
  mmStatus as fetchMMStatusRaw,
  availableBalances,
} from '../../services/mmApi'
import { storeLocal, lastMMSpecsLK } from '../../services/state'
import { ROUTES } from '../../router/routes'
import {
  botConfigStateReducer,
  initialBotConfigState,
  BotConfigStateContext,
  BotConfigDispatchContext,
  fetchExternalFees,
  fetchFundingFees,
  externalFeeRequestKey,
  fundingFeesRequestKey,
} from './utils/BotConfig'
import type { BotConfigState } from './utils/BotConfig'
import { requiredDexAssets } from './utils/AllocationUtil'
import MarketSelector from './MarketSelector'
import BotTypeSelector from './BotTypeSelector'
import ConfigureBot from './ConfigureBot'
import ErrorPopup from './ErrorPopup'
import { LoadingSpinner } from './FormComponents'

// BotSpecs is the persisted last-selection descriptor. Mirrors the
// vanilla `BotSpecs` shape from `mmsettings.ts` so localStorage entries
// stay compatible across the port.
export interface BotSpecs {
  host: string
  baseID: number
  quoteID: number
  botType: 'basicMM' | 'arbMM' | 'basicArb'
  cexName?: string
}

export interface MMSettingsError {
  message: string
  onClose?: () => void
}

// AvailableMarket is the row shape consumed by MarketSelector and the
// top-level MMSettingsPage dropdown. Lean adds `vol24` (used for the
// usd-equivalent volume sort) — vanilla had a `hasArb` field here that
// is never read by MarketSelector (supported-cex presence is computed
// fresh via `checkCexMarketSupport`), so it's intentionally omitted.
export interface AvailableMarket {
  host: string
  baseID: number
  quoteID: number
  baseSymbol: string
  quoteSymbol: string
  vol24: number
}

export interface AvailableMarkets {
  markets: AvailableMarket[]
  exchangesRequiringRegistration: string[]
}

// MMSettingsSetErrorContext lets any descendant surface a user-visible
// error without threading callbacks through every intermediate component.
export const MMSettingsSetErrorContext =
  createContext<Dispatch<SetStateAction<MMSettingsError | null>> | undefined>(undefined)

// MMSettingsSetLoadingContext exposes a page-wide loading overlay
// toggle for async operations (bridge fee lookups, etc.).
export const MMSettingsSetLoadingContext =
  createContext<Dispatch<SetStateAction<boolean>> | undefined>(undefined)

export const useMMSettingsSetError = () => {
  const context = useContext(MMSettingsSetErrorContext)
  if (context === undefined) {
    throw new Error('useMMSettingsSetError must be used within a MMSettingsSetErrorProvider')
  }
  return context
}

export const useMMSettingsSetLoading = () => {
  const context = useContext(MMSettingsSetLoadingContext)
  if (context === undefined) {
    throw new Error('useMMSettingsSetLoading must be used within a MMSettingsSetLoadingProvider')
  }
  return context
}

// cexSupportsArbOnMarket checks whether the CEX supports arbitrage market
// making on the given market. It returns a tuple of:
//
// - whether the CEX supports direct arbitrage on the market
// - the intermediate assets that can be used for multi-hop arbitrage
// - the CEX assetIDs that the base asset can be bridged to
// - the CEX assetIDs that the quote asset can be bridged to
//
// If the CEX does not support direct arb and there are no intermediate
// assets, the CEX does not support arbitrage on the market. The bridge
// destination maps will be null if the CEX supports the same asset
// that is used on the DEX market (no bridging needed on that side).
export const cexSupportsArbOnMarket = (
  baseID: number,
  quoteID: number,
  cexStatus: MMCEXStatus,
  bridgePaths: Record<number, Record<number, string[]>>
): [boolean, number[] | null, Record<number, string[]> | null, Record<number, string[]> | null] => {
  const supportedBridgePath = (dexAssetID: number, cexAssetID: number) => {
    if (!bridgePaths[dexAssetID]) return false
    return bridgePaths[dexAssetID][cexAssetID] !== undefined
  }

  const getBridgeNames = (dexAssetID: number, cexAssetID: number): string[] => {
    if (!bridgePaths[dexAssetID]) return []
    return bridgePaths[dexAssetID][cexAssetID] || []
  }

  const supportedMarkets = (dexBaseID: number, dexQuoteID: number, cexBaseID: number, cexQuoteID: number) => {
    if (dexBaseID !== cexBaseID && !supportedBridgePath(dexBaseID, cexBaseID)) return false
    if (dexQuoteID !== cexQuoteID && !supportedBridgePath(dexQuoteID, cexQuoteID)) return false
    return true
  }

  let baseDirectSupport = false
  let quoteDirectSupport = false
  const baseBridgeOptions: Record<number, string[]> = {}
  const quoteBridgeOptions: Record<number, string[]> = {}
  for (const { baseID: cexBaseID, quoteID: cexQuoteID } of Object.values(cexStatus.markets ?? [])) {
    if (cexBaseID === baseID || cexQuoteID === baseID) baseDirectSupport = true
    if (cexBaseID === quoteID || cexQuoteID === quoteID) quoteDirectSupport = true
    if (supportedBridgePath(baseID, cexBaseID)) baseBridgeOptions[cexBaseID] = getBridgeNames(baseID, cexBaseID)
    if (supportedBridgePath(baseID, cexQuoteID)) baseBridgeOptions[cexQuoteID] = getBridgeNames(baseID, cexQuoteID)
    if (supportedBridgePath(quoteID, cexQuoteID)) quoteBridgeOptions[cexQuoteID] = getBridgeNames(quoteID, cexQuoteID)
    if (supportedBridgePath(quoteID, cexBaseID)) quoteBridgeOptions[cexBaseID] = getBridgeNames(quoteID, cexBaseID)
  }

  const baseBridges = baseDirectSupport ? null : baseBridgeOptions
  const quoteBridges = quoteDirectSupport ? null : quoteBridgeOptions

  const supportsBaseAsset = (cexAssetID: number): boolean =>
    cexAssetID === baseID || baseBridgeOptions[cexAssetID] !== undefined
  const supportsQuoteAsset = (cexAssetID: number): boolean =>
    cexAssetID === quoteID || quoteBridgeOptions[cexAssetID] !== undefined

  // Find all markets that trade either base or quote assets. If there
  // is an exact match, we can return early.
  const baseMarkets = new Set<number>()
  const quoteMarkets = new Set<number>()
  for (const { baseID: cexBaseID, quoteID: cexQuoteID } of Object.values(cexStatus.markets ?? [])) {
    if (supportedMarkets(baseID, quoteID, cexBaseID, cexQuoteID)) {
      return [true, null, baseBridges, quoteBridges]
    }
    if (supportsBaseAsset(cexBaseID)) baseMarkets.add(cexQuoteID)
    if (supportsBaseAsset(cexQuoteID)) baseMarkets.add(cexBaseID)
    if (supportsQuoteAsset(cexBaseID)) quoteMarkets.add(cexQuoteID)
    if (supportsQuoteAsset(cexQuoteID)) quoteMarkets.add(cexBaseID)
  }

  // No direct match — compute intermediate assets that can bridge the
  // trade in two hops (base→intermediate on one market, intermediate→quote
  // on another).
  const intermediateAssets: Record<number, boolean> = {}
  for (const intermediateAsset of baseMarkets) {
    if (quoteMarkets.has(intermediateAsset)) intermediateAssets[intermediateAsset] = true
  }

  // Filter duplicates via the CEX's asset-group mapping (non-canonical
  // IDs collapse to their canonical equivalents). WETH is filtered out.
  const assetGroups = cexStatus.assetGroups ?? {}
  const seenCanonical = new Set<number>()
  const filteredIntermediateAssets: number[] = []
  const { assets } = useAuthStore.getState()
  for (const intermediateAsset of Object.keys(intermediateAssets).map(Number)) {
    const canonicalID = assetGroups[intermediateAsset] ?? intermediateAsset
    if (seenCanonical.has(canonicalID)) continue
    const asset = assets[canonicalID]
    if (!asset) continue
    const assetSymbol = asset.symbol.split('.')[0]
    if (assetSymbol === 'weth') continue
    seenCanonical.add(canonicalID)
    filteredIntermediateAssets.push(canonicalID)
  }

  return [false, filteredIntermediateAssets, baseBridges, quoteBridges]
}

// createCexMarketSupportChecker produces a `(baseID, quoteID, cexName,
// directOnly) => boolean` closure that MarketSelector / BotTypeSelector
// use to filter CEXes per market.
export const createCexMarketSupportChecker = (
  bridgePaths: Record<number, Record<number, string[]>>,
  cexes: Record<string, MMCEXStatus>
) => {
  return (baseID: number, quoteID: number, cexName: string, directOnly: boolean): boolean => {
    const cexStatus = cexes[cexName]
    if (!cexStatus) return false
    const [supportsDirectArb, intermediateAssets] = cexSupportsArbOnMarket(baseID, quoteID, cexStatus, bridgePaths)
    if (directOnly) return supportsDirectArb
    return supportsDirectArb || (!!intermediateAssets && intermediateAssets.length > 0)
  }
}

function missingFiatRateAssetIDs (botConfigState: BotConfigState): number[] {
  const { baseID, quoteID } = botConfigState.dexMarket
  const requiredAssetIDs = [...new Set([baseID, quoteID])]
  return requiredAssetIDs.filter((assetID) => !botConfigState.fiatRatesMap[assetID])
}

function missingFiatRateMessage (assetIDs: number[], t: (k: string, opts?: Record<string, unknown>) => string): string {
  const { assets } = useAuthStore.getState()
  const symbols = assetIDs.map((assetID) => assets[assetID]?.symbol.toUpperCase() || String(assetID))
  return t('MM_MISSING_FIAT_RATES', { assetSymbols: symbols.join(', ') })
}

function initialErrorState (
  botConfigStateOnLoad: BotConfigState | string | undefined,
  t: (k: string, opts?: Record<string, unknown>) => string
): [BotConfigState | null, MMSettingsError | null] {
  if (!botConfigStateOnLoad) return [null, null]
  if (typeof botConfigStateOnLoad === 'string') {
    return [null, { message: botConfigStateOnLoad }]
  }
  const missingFiatRates = missingFiatRateAssetIDs(botConfigStateOnLoad)
  if (missingFiatRates.length > 0) {
    return [null, { message: missingFiatRateMessage(missingFiatRates, t) }]
  }
  return [botConfigStateOnLoad, null]
}

// tokenAssetApprovalStatuses looks up the token-approval state for the
// base/quote token on the given host. Non-token assets are always
// `Approved`. Used to gate market selection on the "you must approve
// this token first" check.
function tokenAssetApprovalStatuses (host: string, b: SupportedAsset, q: SupportedAsset) {
  const { assets, exchanges } = useAuthStore.getState()
  let baseApprovalStatus = ApprovalStatus.Approved
  let quoteApprovalStatus = ApprovalStatus.Approved

  if (b?.token) {
    const baseAsset = assets[b.id]
    const baseVersion = exchanges[host]?.assets[b.id]?.version
    if (baseVersion !== undefined && baseAsset?.wallet?.approved?.[baseVersion] !== undefined) {
      baseApprovalStatus = baseAsset.wallet.approved[baseVersion]
    }
  }
  if (q?.token) {
    const quoteAsset = assets[q.id]
    const quoteVersion = exchanges[host]?.assets[q.id]?.version
    if (quoteVersion !== undefined && quoteAsset?.wallet?.approved?.[quoteVersion] !== undefined) {
      quoteApprovalStatus = quoteAsset.wallet.approved[quoteVersion]
    }
  }

  return { baseApprovalStatus, quoteApprovalStatus }
}

interface MMSettingsProps {
  availableMarkets?: AvailableMarkets
  initialCexes?: Record<string, MMCEXStatus>
  bridgePaths?: Record<number, Record<number, string[]>>
  // botConfigStateOnLoad may be a string, which means an error should be displayed.
  botConfigStateOnLoad?: BotConfigState | string
}

export interface MMSettingsHandle {
  handleBalanceNote: (note: BalanceNote) => void
  handleCEXBalanceUpdate: (cexName: string, update: CEXBalanceUpdate) => void
}

const MMSettings = forwardRef<MMSettingsHandle, MMSettingsProps>(({
  availableMarkets = { markets: [], exchangesRequiringRegistration: [] },
  initialCexes = {},
  bridgePaths = {},
  botConfigStateOnLoad = undefined,
}, ref) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [initialState, initialError] = initialErrorState(botConfigStateOnLoad, t)
  const [error, setError] = useState<MMSettingsError | null>(initialError)
  const [botConfigState, dispatch] = useReducer(botConfigStateReducer, initialState)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [updatingMarketOrType, setUpdatingMarketOrType] = useState<boolean>(false)
  const [cexes, setCexes] = useState<Record<string, MMCEXStatus>>(initialCexes)
  const [selectedMarket, setSelectedMarket] = useState<{
    host: string
    baseID: number
    quoteID: number
  } | null>(null)
  const latestBotConfigState = useRef<BotConfigState | null>(initialState)
  const fundingFeesRequestSeq = useRef(0)
  const fundingFeesInFlightKey = useRef<string | null>(null)
  const fundingFeesRetry = useRef<{ key: string; timer: number } | null>(null)
  const externalFeesRequestSeq = useRef(0)
  const externalFeesInFlightKey = useRef<string | null>(null)
  const externalFeesLoadedKey = useRef<string | null>(null)
  const mounted = useRef(true)
  latestBotConfigState.current = botConfigState

  useEffect(() => {
    return () => {
      mounted.current = false
      if (fundingFeesRetry.current) {
        window.clearTimeout(fundingFeesRetry.current.timer)
        fundingFeesRetry.current = null
      }
    }
  }, [])

  const handleCEXesUpdated = async () => {
    const res = await fetchMMStatusRaw()
    if (res.ok && res.status) setCexes(res.status.cexes)
  }

  // Expose handleBalanceNote and handleCEXBalanceUpdate to the page via
  // ref so WS note feeders can forward relevant updates into the reducer.
  useImperativeHandle(ref, () => ({
    handleBalanceNote: async (note: BalanceNote) => {
      if (!botConfigState) return
      const requiredAssets = requiredDexAssets(botConfigState)
      if (!requiredAssets.includes(note.assetID)) return

      const res = await availableBalances(
        {
          host: botConfigState.botConfig.host,
          baseID: botConfigState.dexMarket.baseID,
          quoteID: botConfigState.dexMarket.quoteID,
        },
        botConfigState.botConfig.cexBaseID,
        botConfigState.botConfig.cexQuoteID,
        botConfigState.botConfig.cexName
      )
      if (!res.ok) {
        console.error('Failed to update available balances:', res.msg)
        return
      }
      dispatch({
        type: 'UPDATE_AVAILABLE_BALANCES',
        payload: { dexBalances: res.dexBalances, cexBalances: res.cexBalances },
      })
    },

    handleCEXBalanceUpdate: async (cexName: string, update: CEXBalanceUpdate) => {
      if (!botConfigState) return
      if (botConfigState.botConfig.cexName !== cexName) return
      const { cexBaseID, cexQuoteID } = botConfigState.botConfig
      if (update.assetID !== cexBaseID && update.assetID !== cexQuoteID) return

      const res = await availableBalances(
        {
          host: botConfigState.botConfig.host,
          baseID: botConfigState.dexMarket.baseID,
          quoteID: botConfigState.dexMarket.quoteID,
        },
        cexBaseID,
        cexQuoteID,
        cexName
      )
      if (!res.ok) {
        console.error('Failed to update CEX available balances:', res.msg)
        return
      }
      dispatch({
        type: 'UPDATE_AVAILABLE_BALANCES',
        payload: { dexBalances: res.dexBalances, cexBalances: res.cexBalances },
      })
    },
  }), [botConfigState])

  // Derived fetch keys — both effects below key off these so they only
  // refire when the actual fee-inputs change, not on every reducer
  // transition. Inside each effect we read the fresh state via
  // `latestBotConfigState.current`.
  const fundingKey = botConfigState ? fundingFeesRequestKey(botConfigState) : null
  const externalKey = botConfigState ? externalFeeRequestKey(botConfigState) : null
  const fundingFeesReadyKey = botConfigState?.fundingFeesKey ?? null

  // Funding fees fetch/retry effect. Tracks an in-flight key to avoid
  // racing concurrent requests and schedules a 3s retry on failure
  // (the remote fee estimator can be briefly unavailable during bridge
  // reconfiguration).
  useEffect(() => {
    if (!fundingKey) return
    const state = latestBotConfigState.current
    if (!state) return
    const key = fundingKey
    const fundingFeesReady = fundingFeesReadyKey === key
    if (fundingFeesReady || fundingFeesInFlightKey.current === key) return

    if (fundingFeesRetry.current && fundingFeesRetry.current.key !== key) {
      window.clearTimeout(fundingFeesRetry.current.timer)
      fundingFeesRetry.current = null
    }

    const performFetch = async (stateSnapshot: BotConfigState, keySnapshot: string) => {
      if (fundingFeesInFlightKey.current === keySnapshot) return
      fundingFeesInFlightKey.current = keySnapshot
      const requestID = ++fundingFeesRequestSeq.current
      const result = await fetchFundingFees(stateSnapshot)
      if (!mounted.current || fundingFeesRequestSeq.current !== requestID) return
      if (fundingFeesInFlightKey.current === keySnapshot) fundingFeesInFlightKey.current = null

      if (result.ok) {
        if (fundingFeesRetry.current?.key === keySnapshot) {
          window.clearTimeout(fundingFeesRetry.current.timer)
          fundingFeesRetry.current = null
        }
        dispatch({
          type: 'SET_FUNDING_FEES',
          payload: { buyFees: result.buyFees, sellFees: result.sellFees, key: result.key },
        })
      } else {
        if (fundingFeesRetry.current?.key === keySnapshot) return
        const timer = window.setTimeout(() => {
          if (fundingFeesRetry.current?.key === keySnapshot) fundingFeesRetry.current = null
          const latestState = latestBotConfigState.current
          if (!latestState) return
          const latestKey = fundingFeesRequestKey(latestState)
          if (latestKey !== keySnapshot || latestState.fundingFeesKey === latestKey) return
          performFetch(latestState, keySnapshot).then(() => undefined)
        }, 3000)
        fundingFeesRetry.current = { key: keySnapshot, timer }
      }
    }

    if (fundingFeesRetry.current?.key === key) return
    performFetch(state, key).then(() => undefined)
  }, [fundingKey, fundingFeesReadyKey])

  // External fees (CEX-side) fetch effect. No retry — this is a
  // read-through lookup that either works or returns 0s.
  useEffect(() => {
    if (!externalKey) return
    const state = latestBotConfigState.current
    if (!state) return
    const key = externalKey
    if (externalFeesLoadedKey.current === key || externalFeesInFlightKey.current === key) return

    const performFetch = async (stateSnapshot: BotConfigState, keySnapshot: string) => {
      if (externalFeesInFlightKey.current === keySnapshot) return
      externalFeesInFlightKey.current = keySnapshot
      const requestID = ++externalFeesRequestSeq.current
      const result = await fetchExternalFees(stateSnapshot)
      if (!mounted.current || externalFeesRequestSeq.current !== requestID) return
      if (externalFeesInFlightKey.current === keySnapshot) externalFeesInFlightKey.current = null
      externalFeesLoadedKey.current = result.key
      dispatch({ type: 'SET_EXTERNAL_FEES', payload: result })
    }

    performFetch(state, key).then(() => undefined)
  }, [externalKey])

  const checkCexMarketSupport = useMemo(
    () => createCexMarketSupportChecker(bridgePaths, cexes),
    [bridgePaths, cexes]
  )

  const handleBotTypeSelected = async (botType: 'basicMM' | 'arbMM' | 'basicArb', cexName?: string) => {
    if (!selectedMarket) {
      console.error('No market selected')
      return
    }

    if (botConfigState) {
      const currentConfig = botConfigState.botConfig
      const marketMatches = (
        currentConfig.host === selectedMarket.host &&
        currentConfig.baseID === selectedMarket.baseID &&
        currentConfig.quoteID === selectedMarket.quoteID
      )

      let currentBotType: 'basicMM' | 'arbMM' | 'basicArb'
      if (currentConfig.basicMarketMakingConfig) currentBotType = 'basicMM'
      else if (currentConfig.arbMarketMakingConfig) currentBotType = 'arbMM'
      else if (currentConfig.simpleArbConfig) currentBotType = 'basicArb'
      else throw new Error('Invalid bot type in current config')

      const botTypeMatches = currentBotType === botType
      const cexMatches = currentConfig.cexName === (cexName || '')

      if (marketMatches && botTypeMatches && cexMatches) {
        setUpdatingMarketOrType(false)
        return
      }
    }

    let baseBridges: Record<number, string[]> | null = null
    let quoteBridges: Record<number, string[]> | null = null
    let intermediateAssets: number[] | null = null
    let cexStatus: MMCEXStatus | null = null

    if (cexName) {
      cexStatus = cexes[cexName] ?? null
      if (cexStatus) {
        [, intermediateAssets, baseBridges, quoteBridges] = cexSupportsArbOnMarket(
          selectedMarket.baseID,
          selectedMarket.quoteID,
          cexStatus,
          bridgePaths
        )
      }
    }

    const newBotConfigState = await initialBotConfigState(
      selectedMarket.host,
      selectedMarket.baseID,
      selectedMarket.quoteID,
      botType,
      intermediateAssets,
      baseBridges,
      quoteBridges,
      cexStatus,
      cexName
    )

    const [newState, errorState] = initialErrorState(newBotConfigState, t)
    if (errorState != null) {
      setError(errorState)
      return
    }

    const botSpecs: BotSpecs = {
      host: selectedMarket.host,
      baseID: selectedMarket.baseID,
      quoteID: selectedMarket.quoteID,
      botType,
      cexName,
    }
    storeLocal(lastMMSpecsLK, botSpecs)

    dispatch({ type: 'SET_INITIAL_CONFIG', payload: newState })
    setUpdatingMarketOrType(false)
  }

  const handleChangeMarket = () => {
    setSelectedMarket(null)
    setUpdatingMarketOrType(true)
  }

  const handleChangeBotType = () => {
    // When the user arrived at ConfigureBot via a pre-filled botConfigState
    // (URL/localStorage-seeded flow), selectedMarket is still null. Derive
    // it from the current config so BotTypeSelector has somewhere to dock.
    if (!selectedMarket && botConfigState) {
      setSelectedMarket({
        host: botConfigState.botConfig.host,
        baseID: botConfigState.botConfig.baseID,
        quoteID: botConfigState.botConfig.quoteID,
      })
    }
    setUpdatingMarketOrType(true)
  }

  let mainComponent: ReactNode

  if (botConfigState && !updatingMarketOrType) {
    mainComponent = (
      <BotConfigStateContext.Provider value={botConfigState}>
        <BotConfigDispatchContext.Provider value={dispatch}>
          <ConfigureBot
            onChangeMarket={handleChangeMarket}
            onChangeBotType={handleChangeBotType}
          />
        </BotConfigDispatchContext.Provider>
      </BotConfigStateContext.Provider>
    )
  } else if (selectedMarket) {
    mainComponent = (
      <BotTypeSelector
        selectedMarket={selectedMarket}
        cexes={cexes}
        checkCexMarketSupport={checkCexMarketSupport}
        onClose={() => {
          if (updatingMarketOrType) setUpdatingMarketOrType(false)
          else setSelectedMarket(null)
        }}
        onBotTypeSelected={handleBotTypeSelected}
        onChangeMarket={handleChangeMarket}
        handleCEXesUpdated={handleCEXesUpdated}
      />
    )
  } else {
    mainComponent = (
      <MarketSelector
        markets={availableMarkets.markets}
        exchangesRequiringRegistration={availableMarkets.exchangesRequiringRegistration}
        cexes={cexes}
        onClose={() => {
          if (botConfigState) {
            setSelectedMarket({
              host: botConfigState.botConfig.host,
              baseID: botConfigState.botConfig.baseID,
              quoteID: botConfigState.botConfig.quoteID,
            })
            setUpdatingMarketOrType(false)
          } else {
            navigate(ROUTES.MM)
          }
        }}
        checkCexMarketSupport={checkCexMarketSupport}
        handleMarketSelected={(host: string, baseID: number, quoteID: number) => {
          const { assets, walletMap } = useAuthStore.getState()
          const baseWallet = walletMap[baseID]
          const quoteWallet = walletMap[quoteID]
          const baseLabel = assets[baseID]?.symbol ?? String(baseID)
          const quoteLabel = assets[quoteID]?.symbol ?? String(quoteID)

          if (!baseWallet) {
            setError({ message: t('MM_NEED_WALLET', { asset: baseLabel }) })
            return
          }
          if (baseWallet.disabled) {
            setError({ message: t('MM_WALLET_DISABLED', { asset: baseLabel }) })
            return
          }
          if (!quoteWallet) {
            setError({ message: t('MM_NEED_WALLET', { asset: quoteLabel }) })
            return
          }
          if (quoteWallet.disabled) {
            setError({ message: t('MM_WALLET_DISABLED', { asset: quoteLabel }) })
            return
          }

          const { baseApprovalStatus, quoteApprovalStatus } =
            tokenAssetApprovalStatuses(host, assets[baseID], assets[quoteID])
          if (baseApprovalStatus === ApprovalStatus.NotApproved) {
            setError({ message: t('MM_NEED_ASSET_APPROVAL', { asset: baseLabel }) })
            return
          }
          if (quoteApprovalStatus === ApprovalStatus.NotApproved) {
            setError({ message: t('MM_NEED_ASSET_APPROVAL', { asset: quoteLabel }) })
            return
          }

          setSelectedMarket({ host, baseID, quoteID })
        }}
      />
    )
  }

  return (
    <div>
      <MMSettingsSetErrorContext.Provider value={setError}>
        <MMSettingsSetLoadingContext.Provider value={setIsLoading}>
          {mainComponent}
          <ErrorPopup error={error} />
          <LoadingSpinner isLoading={isLoading} />
        </MMSettingsSetLoadingContext.Provider>
      </MMSettingsSetErrorContext.Provider>
    </div>
  )
})

MMSettings.displayName = 'MMSettings'

export default MMSettings
