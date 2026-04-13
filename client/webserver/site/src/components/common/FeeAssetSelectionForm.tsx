import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON, checkResponse } from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { useNotifications } from '../../hooks/useNotifications'
import { formatFullPrecision, formatBestWeCan } from '../../hooks/useFormatters'
import {
  bondReserveMultiplier,
  perTierBaseParcelLimit,
  parcelLimitScoreMultiplier
} from '../AccountUtils'
import type {
  Exchange, Market, WalletCreationNote
} from '../../stores/types'

function logoPath (symbol: string): string {
  const base = symbol.split('.')[0]
  return `/img/coins/${base === 'weth' ? 'eth' : base}.png`
}

interface BondAssetRow {
  assetID: number
  name: string
  symbol: string
  unit: string
  bondAmount: number
  bondSizeConventional: number
  fiatBondAmount: number | null
  walletReady: boolean
}

interface MarketLimitsRow {
  market: Market
  baseSymbol: string
  quoteSymbol: string
  baseUnit: string
  quoteUnit: string
  setTier: (tier: number) => { low: number; high: number; fiatLow: number | null; fiatHigh: number | null }
}

interface Props {
  exchange: Exchange
  certFile: string
  onSuccess: (assetID: number, tier: number) => void
}

type View = 'assets' | 'tier' | 'whatsABond' | 'prepaid'

export function FeeAssetSelectionForm ({ exchange, certFile, onSuccess }: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const fiatRatesMap = useAuthStore(s => s.fiatRatesMap)

  const [view, setView] = useState<View>('assets')
  const [selectedAssetID, setSelectedAssetID] = useState<number | null>(null)
  const [tier, setTierValue] = useState(() => {
    return exchange.auth.targetTier ? exchange.auth.targetTier : 1
  })
  const [assetError, setAssetError] = useState('')
  const [tierError, setTierError] = useState('')
  const [prepaidCode, setPrepaidCode] = useState('')
  const [prepaidError, setPrepaidError] = useState('')
  const [walletReadyMap, setWalletReadyMap] = useState<Record<number, boolean>>({})

  // Listen for wallet creation notes so we can mark assets as "ready".
  useNotifications(useMemo(() => ({
    createwallet: (note: any) => {
      const wn = note as WalletCreationNote
      if (wn.topic === 'QueuedCreationSuccess') {
        setWalletReadyMap(prev => ({ ...prev, [wn.assetID]: true }))
      }
    }
  }), []))

  // Build bond asset rows from exchange data.
  const bondAssetRows: BondAssetRow[] = useMemo(() => {
    const rows: BondAssetRow[] = []
    for (const xcAsset of Object.values(exchange.assets || {})) {
      const asset = assets[xcAsset.id]
      if (!asset) continue
      const bondAsset = exchange.bondAssets[xcAsset.symbol]
      if (!bondAsset) continue
      const { conventional: { unit, conversionFactor } } = asset.unitInfo
      const bondSizeConventional = bondAsset.amount / conversionFactor
      const fiatRate = fiatRatesMap[xcAsset.id]
      rows.push({
        assetID: xcAsset.id,
        name: asset.name,
        symbol: asset.symbol,
        unit,
        bondAmount: bondAsset.amount,
        bondSizeConventional,
        fiatBondAmount: fiatRate ? bondSizeConventional * fiatRate : null,
        walletReady: !!asset.wallet || !!walletReadyMap[xcAsset.id],
      })
    }
    return rows
  }, [exchange, assets, fiatRatesMap, walletReadyMap])

  // Build market limit rows.
  const marketRows: MarketLimitsRow[] = useMemo(() => {
    const rows: MarketLimitsRow[] = []
    for (const mkt of Object.values(exchange.markets || {})) {
      const b = assets[mkt.baseid]
      const q = assets[mkt.quoteid]
      if (!b || !q) continue
      const xcBase = exchange.assets[mkt.baseid]
      const xcQuote = exchange.assets[mkt.quoteid]
      if (!xcBase || !xcQuote) continue
      const bui = xcBase.unitInfo
      rows.push({
        market: mkt,
        baseSymbol: xcBase.symbol,
        quoteSymbol: xcQuote.symbol,
        baseUnit: bui.conventional.unit,
        quoteUnit: xcQuote.unitInfo.conventional.unit,
        setTier: (t: number) => {
          const { parcelsize: parcelSize, lotsize: lotSize } = mkt
          const conventionalLotSize = lotSize / bui.conventional.conversionFactor
          const startingLimit = conventionalLotSize * parcelSize * perTierBaseParcelLimit * t
          const privilegedLimit = conventionalLotSize * parcelSize * perTierBaseParcelLimit * parcelLimitScoreMultiplier * t
          const baseFiatRate = fiatRatesMap[mkt.baseid]
          return {
            low: startingLimit,
            high: privilegedLimit,
            fiatLow: baseFiatRate ? startingLimit * baseFiatRate : null,
            fiatHigh: baseFiatRate ? privilegedLimit * baseFiatRate : null,
          }
        },
      })
    }
    return rows
  }, [exchange, assets, fiatRatesMap])

  // On mount, check if a valid bond asset is already selected and skip to tier view.
  useEffect(() => {
    if (exchange.viewOnly) return
    const { targetTier, bondAssetID } = exchange.auth
    if (targetTier < 1) return
    const a = assets[bondAssetID]
    if (a && exchange.bondAssets[a.symbol]) {
      setSelectedAssetID(bondAssetID)
      setTierValue(targetTier)
      setView('tier')
    }
  }, [exchange, assets])

  // Computed values for the tier configuration panel.
  const tierInfo = useMemo(() => {
    if (selectedAssetID === null) return null
    const asset = assets[selectedAssetID]
    if (!asset) return null
    const { symbol, unitInfo: ui } = asset
    const { conventional: { conversionFactor, unit } } = ui
    const bondAsset = exchange.bondAssets[symbol]
    if (!bondAsset) return null

    const bondLock = bondAsset.amount * tier * bondReserveMultiplier
    const bondSizeConventional = formatFullPrecision(bondAsset.amount, ui)
    const bondLockConventional = formatFullPrecision(bondLock, ui)
    const fiatRate = fiatRatesMap[selectedAssetID]
    const fiatLock = fiatRate ? formatBestWeCan(bondLock / conversionFactor * fiatRate) : null

    return { unit, bondSizeConventional, bondLockConventional, fiatLock, fiatRate }
  }, [selectedAssetID, tier, exchange, assets, fiatRatesMap])

  // Current bonds locked across all wallets.
  const currentBonds = useMemo(() => {
    const entries: { assetID: number; bonded: number }[] = []
    for (const [idStr, asset] of Object.entries(assets)) {
      if (!asset.wallet) continue
      const { bondlocked, bondReserves } = asset.wallet.balance
      const bonded = bondlocked + bondReserves
      if (bonded > 0) entries.push({ assetID: Number(idStr), bonded })
    }
    return entries
  }, [assets])

  // Market limits at current tier.
  const marketLimits = useMemo(() => {
    return marketRows.map(r => ({ ...r, limits: r.setTier(tier) }))
  }, [marketRows, tier])

  const clearErrors = () => {
    setAssetError('')
    setTierError('')
  }

  const handleAssetSelected = (assetID: number) => {
    clearErrors()
    setSelectedAssetID(assetID)
    setView('tier')
  }

  const incrementTier = (up: boolean) => {
    setTierValue(prev => Math.max(1, prev + (up ? 1 : -1)))
  }

  const handleTierInput = (raw: string) => {
    clearErrors()
    if (!raw) {
      setTierValue(1)
      return
    }
    const n = parseInt(raw)
    if (isNaN(n)) {
      setTierError(t('INVALID_TIER_VALUE'))
      return
    }
    setTierValue(Math.max(1, n))
  }

  const acceptTier = () => {
    clearErrors()
    if (selectedAssetID === null) return
    const n = tier
    if (isNaN(n) || n < 1) {
      setTierError(t('INVALID_TIER_VALUE'))
      return
    }
    onSuccess(selectedAssetID, n)
  }

  const submitPrepaidBond = useCallback(async () => {
    setPrepaidError('')
    if (!prepaidCode) {
      setPrepaidError(t('INVALID_VALUE'))
      return
    }
    const res = await postJSON('/api/redeemprepaidbond', {
      host: exchange.host,
      code: prepaidCode,
      cert: certFile,
    })
    if (!checkResponse(res)) {
      setPrepaidError(res.msg)
      return
    }
    // PrepaidBondID = 2147483647 from types.ts
    onSuccess(2147483647, res.tier)
  }, [prepaidCode, exchange.host, certFile, onSuccess, t])

  // ---- Asset selection view ----
  if (view === 'whatsABond') {
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          <div className="fs20 mb-2">{t('What is a fidelity bond?')}</div>
          <p className="fs15">
            {t('WHATS_A_BOND_DESC')}
          </p>
          <div className="d-flex gap-2">
            <button className="btn btn-secondary" onClick={() => setView('assets')}>
              {t('Back')}
            </button>
            <button className="btn btn-primary" onClick={() => setView('assets')}>
              {t('Got it')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'prepaid') {
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          <div className="fs20 mb-2">{t('Prepaid Bond')}</div>
          <div className="mb-3">
            <label>{t('Bond Code')}</label>
            <input
              type="text"
              className="form-control"
              value={prepaidCode}
              onChange={e => setPrepaidCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitPrepaidBond() }}
            />
          </div>
          {prepaidError && (
            <div className="fs15 text-danger mb-2">{prepaidError}</div>
          )}
          <div className="d-flex gap-2">
            <button className="btn btn-secondary" onClick={() => { setView('assets'); setPrepaidError('') }}>
              {t('Back')}
            </button>
            <button className="btn btn-primary" onClick={submitPrepaidBond}>
              {t('Submit')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'assets') {
    return (
      <div className="form-closer">
        <div className="px-3 py-2">
          <div className="fs20 mb-2">{t('Choose your bond asset')}</div>

          {/* Bond asset list */}
          <div className="flex-stretch-column">
            {bondAssetRows.map(row => (
              <div
                key={row.assetID}
                className="known-exchange d-flex align-items-center p-2 pointer"
                onClick={() => handleAssetSelected(row.assetID)}
              >
                <img className="micro-icon me-2" src={logoPath(row.symbol)} alt="" />
                <div className="flex-grow-1">
                  <div className="fs16">{row.name}</div>
                  <div className="fs14 text-secondary">
                    {formatBestWeCan(row.bondSizeConventional)} {row.unit}
                    {row.fiatBondAmount !== null && (
                      <span className="ms-1">(~${formatBestWeCan(row.fiatBondAmount)})</span>
                    )}
                  </div>
                </div>
                {row.walletReady && (
                  <span className="fs14 text-success">{t('WALLET_READY')}</span>
                )}
              </div>
            ))}
          </div>

          {assetError && (
            <div className="fs15 text-danger mt-2">{assetError}</div>
          )}

          <div className="d-flex gap-2 mt-3">
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setView('whatsABond')}
            >
              {t('What is a bond?')}
            </button>
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setView('prepaid')}
            >
              {t('Use a prepaid bond')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---- Tier configuration view ----
  return (
    <div className="form-closer">
      <div className="px-3 py-2">
        <div className="fs20 mb-2">{t('Trading Tier')}</div>

        {tierInfo && (
          <>
            <div className="fs15 mb-1">
              {t('Bond size')}: {tierInfo.bondSizeConventional} {tierInfo.unit}
            </div>
            <div className="fs15 mb-1">
              {t('Tier')}: {tier}
            </div>
            <div className="fs15 mb-1">
              {t('Total bond lock')}: {tierInfo.bondLockConventional} {tierInfo.unit}
              {tierInfo.fiatLock && (
                <span className="ms-1">(~${tierInfo.fiatLock})</span>
              )}
            </div>
          </>
        )}

        {/* Tier input with increment buttons */}
        <div className="d-flex align-items-center gap-2 my-3">
          <button className="btn btn-sm btn-outline-secondary" onClick={() => incrementTier(false)}>
            -
          </button>
          <input
            type="number"
            className="form-control text-center"
            style={{ width: '80px' }}
            value={tier}
            min={1}
            onChange={e => handleTierInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') acceptTier() }}
            autoFocus
          />
          <button className="btn btn-sm btn-outline-secondary" onClick={() => incrementTier(true)}>
            +
          </button>
        </div>

        {tierError && (
          <div className="fs15 text-danger mb-2">{tierError}</div>
        )}

        {/* Current bonds */}
        {currentBonds.length > 0 && (
          <div className="mb-3">
            <div className="fs16 mb-1">{t('Current bonds')}</div>
            {currentBonds.map(({ assetID, bonded }) => {
              const a = assets[assetID]
              if (!a) return null
              const { unitInfo: ui, symbol, name } = a
              const { conventional: { conversionFactor, unit } } = ui
              const fiatRate = fiatRatesMap[assetID]
              return (
                <div key={assetID} className="d-flex align-items-center gap-2 fs14 mb-1">
                  <img className="micro-icon" src={logoPath(symbol)} alt="" />
                  <span>{name}</span>
                  <span>{formatFullPrecision(bonded, ui)} {unit}</span>
                  {fiatRate && (
                    <span>(~${formatBestWeCan(bonded / conversionFactor * fiatRate)})</span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Market limits table */}
        {marketLimits.length > 0 && (
          <div className="mb-3">
            <div className="fs16 mb-1">{t('Market Limits')}</div>
            <table className="table table-sm fs14">
              <thead>
                <tr>
                  <th>{t('Market')}</th>
                  <th>{t('Starting')}</th>
                  <th>{t('Privileged')}</th>
                </tr>
              </thead>
              <tbody>
                {marketLimits.map(({ market, baseSymbol, quoteSymbol, baseUnit, limits }) => (
                  <tr key={`${market.baseid}-${market.quoteid}`}>
                    <td className="d-flex align-items-center gap-1">
                      <img className="micro-icon" src={logoPath(baseSymbol)} alt="" />
                      <img className="micro-icon" src={logoPath(quoteSymbol)} alt="" />
                    </td>
                    <td>
                      {formatBestWeCan(limits.low)} {baseUnit}
                      {limits.fiatLow !== null && (
                        <span className="text-secondary ms-1">(~${formatBestWeCan(limits.fiatLow)})</span>
                      )}
                    </td>
                    <td>
                      {formatBestWeCan(limits.high)} {baseUnit}
                      {limits.fiatHigh !== null && (
                        <span className="text-secondary ms-1">(~${formatBestWeCan(limits.fiatHigh)})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="d-flex gap-2">
          <button className="btn btn-secondary" onClick={() => setView('assets')}>
            {t('Back')}
          </button>
          <button className="btn btn-primary" onClick={acceptTier}>
            {t('Submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
