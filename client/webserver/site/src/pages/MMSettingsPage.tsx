// MMSettingsPage - React route shell for `/mmsettings`. Thin wrapper
// around `<MMSettings>` that owns the async page-level setup: loading
// the bridge topology, enumerating DEX markets, computing the initial
// `BotConfigState` (from a saved bot OR from URL-provided specs), and
// forwarding balance / CEX-balance WS notifications into the
// `MMSettings` child via a ref.
//
// Ported from vanilla `mmsettings.ts`. The vanilla `BasePage` class
// did this work in `renderReact()`; here it lives in a `useEffect`
// on first mount.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { useNotifications } from '../hooks/useNotifications'
import { allBridgePaths } from '../services/mmApi'
import { fetchLocal, storeLocal, lastMMSpecsLK } from '../services/state'
import { botTypeBasicMM, botTypeArbMM, botTypeBasicArb } from '../components/mmsettings/botTypes'
import MMSettings, {
  cexSupportsArbOnMarket,
} from '../components/mmsettings/MMSettings'
import type {
  AvailableMarket,
  AvailableMarkets,
  BotSpecs,
  MMSettingsHandle,
} from '../components/mmsettings/MMSettings'
import {
  initialBotConfigState,
  botConfigStateFromSavedConfig,
} from '../components/mmsettings/utils/BotConfig'
import type { BotConfigState } from '../components/mmsettings/utils/BotConfig'
import type {
  BalanceNote,
  CEXNotification,
  CEXBalanceUpdate,
  CoreNote,
  MMCEXStatus,
} from '../stores/types'

const VALID_BOT_TYPES = new Set<string>([botTypeBasicMM, botTypeArbMM, botTypeBasicArb])

function parseBotSpecsFromSearch (sp: URLSearchParams): BotSpecs | null {
  const host = sp.get('host')
  const baseIDRaw = sp.get('baseID')
  const quoteIDRaw = sp.get('quoteID')
  const botType = sp.get('botType')
  const cexName = sp.get('cexName') ?? undefined
  if (!host || !baseIDRaw || !quoteIDRaw || !botType) return null
  if (!VALID_BOT_TYPES.has(botType)) return null
  const baseID = parseInt(baseIDRaw, 10)
  const quoteID = parseInt(quoteIDRaw, 10)
  if (Number.isNaN(baseID) || Number.isNaN(quoteID)) return null
  return {
    host,
    baseID,
    quoteID,
    botType: botType as BotSpecs['botType'],
    cexName,
  }
}

export default function MMSettingsPage () {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const assets = useAuthStore(s => s.assets)
  const exchanges = useAuthStore(s => s.exchanges)
  const mmStatus = useAuthStore(s => s.mmStatus)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)

  const [bridgePaths, setBridgePaths] = useState<Record<number, Record<number, string[]>> | null>(null)
  const [botConfigStateOnLoad, setBotConfigStateOnLoad] = useState<BotConfigState | string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const mmSettingsRef = useRef<MMSettingsHandle>(null)

  // Snapshot cexes so <MMSettings> renders with a stable initial
  // value. Afterwards <MMSettings> owns its own cexes state (updated
  // via its `handleCEXesUpdated` callback whenever a CEX is configured
  // from within the settings flow).
  const initialCexes = useMemo<Record<string, MMCEXStatus>>(
    () => mmStatus?.cexes ?? {},
    []
  )

  // One-shot initial load: fetch bridgePaths, pick up specs from URL
  // (first) or localStorage (fallback), and seed the initial bot
  // config state. We avoid re-running this on every URL change - once
  // the user enters the settings flow the MMSettings component owns
  // subsequent market/bot-type changes internally and persists them.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const bridgeRes = await allBridgePaths()
      if (cancelled) return
      const paths = bridgeRes.ok ? bridgeRes.paths : {}
      setBridgePaths(paths)

      let specs = parseBotSpecsFromSearch(searchParams)
      if (!specs) {
        const saved = fetchLocal(lastMMSpecsLK) as BotSpecs | null
        if (saved && VALID_BOT_TYPES.has(saved.botType)) specs = saved
      }
      if (specs) storeLocal(lastMMSpecsLK, specs)

      if (!specs) {
        setBotConfigStateOnLoad(undefined)
        setLoading(false)
        return
      }

      let intermediateAssets: number[] | null = null
      let baseBridges: Record<number, string[]> | null = null
      let quoteBridges: Record<number, string[]> | null = null
      let cexStatus: MMCEXStatus | null = null

      if (specs.cexName) {
        cexStatus = mmStatus?.cexes[specs.cexName] ?? null
        if (cexStatus) {
          let supportsDirectArb: boolean
          ;[supportsDirectArb, intermediateAssets, baseBridges, quoteBridges] =
            cexSupportsArbOnMarket(specs.baseID, specs.quoteID, cexStatus, paths)
          if (!supportsDirectArb && (!intermediateAssets || intermediateAssets.length === 0)) {
            setBotConfigStateOnLoad(`CEX does not support arb on market: ${specs.cexName} ${specs.baseID} ${specs.quoteID}`)
            setLoading(false)
            return
          }
        }
      }

      // If there's already a saved bot for this market, edit it;
      // otherwise seed a fresh default config.
      const savedBot = mmStatus?.bots.find(b =>
        b.config.host === specs!.host &&
        b.config.baseID === specs!.baseID &&
        b.config.quoteID === specs!.quoteID
      )

      const configState: BotConfigState | string = savedBot
        ? await botConfigStateFromSavedConfig(savedBot.config, cexStatus, intermediateAssets, baseBridges, quoteBridges)
        : await initialBotConfigState(
            specs.host, specs.baseID, specs.quoteID, specs.botType,
            intermediateAssets, baseBridges, quoteBridges, cexStatus, specs.cexName
          )

      if (cancelled) return
      setBotConfigStateOnLoad(configState)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  // availableMarkets enumerates all exchanges the user has registered
  // with, plus the exchanges that still need registration (MarketSelector
  // surfaces a "register" button per-host). Sorted by USD-equivalent
  // 24h volume descending so the most active markets surface first.
  const availableMarkets = useMemo<AvailableMarkets>(() => {
    const markets: AvailableMarket[] = []
    const exchangesRequiringRegistration: string[] = []
    for (const [host, exchange] of Object.entries(exchanges)) {
      if (exchange.auth.effectiveTier + exchange.auth.pendingStrength === 0) {
        exchangesRequiringRegistration.push(host)
        continue
      }
      for (const market of Object.values(exchange.markets)) {
        if (!assets[market.baseid] || !assets[market.quoteid]) continue
        markets.push({
          host,
          baseID: market.baseid,
          quoteID: market.quoteid,
          baseSymbol: market.basesymbol,
          quoteSymbol: market.quotesymbol,
          vol24: market.spot?.vol24 ?? 0,
        })
      }
    }
    markets.sort((a, b) => {
      const rateA = fiatRatesMap[a.baseID] ?? 0
      const rateB = fiatRatesMap[b.baseID] ?? 0
      const usdA = rateA > 0 ? a.vol24 * rateA : a.vol24
      const usdB = rateB > 0 ? b.vol24 * rateB : b.vol24
      return usdB - usdA
    })
    return { markets, exchangesRequiringRegistration }
  }, [exchanges, assets, fiatRatesMap])

  // Forward balance / CEX-balance WS notifications into the MMSettings
  // child so it can refresh its available-balances view. Uses a ref
  // instead of prop drilling because the notes arrive asynchronously
  // and the handler identity would otherwise change every render.
  const noteHandlers = useMemo(() => ({
    balance: (note: CoreNote) => {
      mmSettingsRef.current?.handleBalanceNote(note as BalanceNote)
    },
    cexnote: (note: CoreNote) => {
      const cexNote = note as CEXNotification
      if (cexNote.topic === 'BalanceUpdate') {
        mmSettingsRef.current?.handleCEXBalanceUpdate(cexNote.cexName, cexNote.note as CEXBalanceUpdate)
      }
    },
  }), [])
  useNotifications(noteHandlers)

  if (loading || bridgePaths === null) {
    return (
      <div className="page-view p-3 d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
        <div className="spinner-border text-primary" role="status" style={{ width: '3rem', height: '3rem' }}>
          <span className="visually-hidden">{t('MM_LOADING')}</span>
        </div>
      </div>
    )
  }

  return (
    <MMSettings
      ref={mmSettingsRef}
      availableMarkets={availableMarkets}
      initialCexes={initialCexes}
      bridgePaths={bridgePaths}
      botConfigStateOnLoad={botConfigStateOnLoad}
    />
  )
}
