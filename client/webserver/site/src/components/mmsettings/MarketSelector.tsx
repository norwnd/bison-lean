// MarketSelector - modal popup for picking an (exchange, base, quote)
// triple for a new mmsettings bot. Ported from vanilla
// `mmsettings/components/MarketSelector.tsx`.
//
// Vanilla used `Doc.logoPath(symbol)` and its own `renderSymbol`
// helper for symbol display. Lean has the equivalent via `logoPath`
// from `hooks/useFormatters` and `<AssetSymbol asset={...} />` from
// `components/common/AssetSymbol`. `AvailableMarket` lives in
// `MMSettings.tsx` (the shell, same location as vanilla).
//
// Registration redirect uses react-router's `navigate()` rather than
// vanilla's raw `window.location.href` assignment.

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { logoPath } from '../../hooks/useFormatters'
import { useAuthStore } from '../../stores/useAuthStore'
import type { MMCEXStatus } from '../../stores/types'
import { CEXDisplayInfos } from './cexDisplayInfo'
import { AssetSymbol } from '../common/AssetSymbol'
import type { AvailableMarket } from './MMSettings'

interface MarketData {
  baseSymbol: string
  quoteSymbol: string
  baseID: number
  quoteID: number
  host: string
  supportedCexes: string[]
}

interface CexMarketSupportChecker {
  (baseID: number, quoteID: number, cexName: string, directOnly: boolean): boolean
}

interface MarketSelectorProps {
  markets?: AvailableMarket[]
  exchangesRequiringRegistration?: string[]
  cexes?: Record<string, MMCEXStatus>
  checkCexMarketSupport?: CexMarketSupportChecker
  onClose: () => void
  handleMarketSelected: (host: string, baseID: number, quoteID: number, baseSymbol: string, quoteSymbol: string) => void
}

const MarketSelector: React.FC<MarketSelectorProps> = ({
  markets = [],
  exchangesRequiringRegistration = [],
  cexes = {},
  checkCexMarketSupport,
  onClose,
  handleMarketSelected
}) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const assets = useAuthStore(s => s.assets)
  const [filterText, setFilterText] = useState('')

  const getSupportedCexes = (market: AvailableMarket) => {
    const supportedCexes: string[] = []
    if (checkCexMarketSupport) {
      for (const cexName of Object.keys(cexes)) {
        if (checkCexMarketSupport(market.baseID, market.quoteID, cexName, false)) {
          supportedCexes.push(cexName)
        }
      }
    }
    return supportedCexes
  }

  const marketData: MarketData[] = markets.map(market => ({
    baseSymbol: market.baseSymbol,
    quoteSymbol: market.quoteSymbol,
    host: market.host,
    baseID: market.baseID,
    quoteID: market.quoteID,
    supportedCexes: getSupportedCexes(market)
  }))

  const filteredMarkets = marketData.filter(market =>
    market.baseSymbol.toLowerCase().includes(filterText.toLowerCase()) ||
    market.quoteSymbol.toLowerCase().includes(filterText.toLowerCase()) ||
    market.host.toLowerCase().includes(filterText.toLowerCase())
  )

  const handleMarketClick = (market: MarketData) => {
    handleMarketSelected(market.host, market.baseID, market.quoteID, market.baseSymbol, market.quoteSymbol)
  }

  return (
    <div id="forms" className="stylish-overflow flex-center">
      <form id="marketSelectForm" className="flex-stretch-column position-relative">
        <div className="form-closer">
          <span className="ico-cross pointer" onClick={onClose}></span>
        </div>

        <div>
          <header className="d-flex align-items-center mb-3">
            <span className="me-2 ico-robot fs35 pb-1"></span>
            <span className="fs26">{t('MM_SELECT_MARKET')}</span>
          </header>
          <div className="fs14 text-muted mb-3">
            {t('MM_SELECT_MARKET_DESC')}
          </div>

          <div id="marketFilterBox" className="flex-center mb-3">
            <div className="position-relative">
              <input
                id="marketFilterInput"
                type="text"
                placeholder={t('MM_SEARCH_MARKETS')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              <span id="marketFilterIcon" className="fs22 ico-search"></span>
            </div>
          </div>

          <div id="marketSelectionTable" className="mm-table-wrapper">
            <table className="row-border w-100">
              <thead>
                <tr>
                  <th>{t('MM_MARKET_HEADER')}</th>
                  <th>{t('MM_HOST_HEADER')}</th>
                  <th>{t('MM_ARB_HEADER')}</th>
                </tr>
              </thead>
              <tbody id="marketSelect">
                {filteredMarkets.map((market, index) => {
                  const baseAsset = assets[market.baseID]
                  const quoteAsset = assets[market.quoteID]
                  return (
                    <tr
                      key={`${market.baseSymbol}-${market.quoteSymbol}-${market.host}-${index}`}
                      className="hoverbg pointer"
                      onClick={() => handleMarketClick(market)}
                    >
                      <td>
                        <div className="d-flex align-items-center">
                          <img src={logoPath(market.baseSymbol)} className="mini-icon me-1" />
                          <img src={logoPath(market.quoteSymbol)} className="mini-icon me-1" />
                          {baseAsset ? <AssetSymbol asset={baseAsset} /> : market.baseSymbol.toUpperCase()}-
                          {quoteAsset ? <AssetSymbol asset={quoteAsset} /> : market.quoteSymbol.toUpperCase()}
                        </div>
                      </td>
                      <td>{market.host}</td>
                      <td>
                        <div className="d-flex flex-wrap gap-1">
                          {market.supportedCexes.map(cexName => {
                            const cexInfo = CEXDisplayInfos[cexName]
                            return cexInfo
                              ? <img key={cexName} src={cexInfo.logo} className="mini-icon" />
                              : null
                          })}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {filteredMarkets.length === 0 && (
            <div id="noMarkets" className="flex-center py-4">
              {t('MM_NO_MARKETS_MATCH')}
            </div>
          )}

          {exchangesRequiringRegistration.map(host => (
            <div key={host} id="needRegBox" className="flex-stretch-column pt-0">
              <button
                type="button"
                id="needRegTmpl"
                className="mt-3"
                onClick={() => navigate(`/settings?registerHost=${encodeURIComponent(host)}&backTo=mmsettings`)}
              >
                {t('MM_REGISTER_HOST', { host })}
              </button>
            </div>
          ))}
        </div>
      </form>
    </div>
  )
}

export default MarketSelector
