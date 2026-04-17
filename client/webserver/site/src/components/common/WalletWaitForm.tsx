import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'
import { useNotifications } from '../../hooks/useNotifications'
import { formatCoinValue, logoPath } from '../../hooks/useFormatters'
import type {
  Exchange, WalletStateNote, WalletSyncNote, BalanceNote
} from '../../stores/types'

interface ProgressPoint {
  stamp: number
  progress: number
}

function formatDuration (dur: number): string {
  const timeMod = (v: number, d: number): [number, number] => [Math.floor(v / d), v % d]
  let seconds = Math.floor(dur)
  let result = ''
  let chunks = 0
  const add = (n: number, s: string): boolean => {
    if (n === 0 && chunks === 0) return false
    chunks++
    let chunk = `${n}${s} `
    if (n < 10) chunk = ' ' + chunk
    result += chunk
    return chunks >= 2
  }
  let Y: number, M: number, D: number, h: number, m: number
  ;[Y, seconds] = timeMod(seconds, 31536000000)
  if (add(Y, 'y')) return result
  ;[M, seconds] = timeMod(seconds, 2592000000)
  if (add(M, 'm')) return result
  ;[D, seconds] = timeMod(seconds, 86400000)
  if (add(D, 'd')) return result
  ;[h, seconds] = timeMod(seconds, 3600000)
  if (add(h, 'h')) return result
  ;[m, seconds] = timeMod(seconds, 60000)
  if (add(m, 'm')) return result
  const [s] = timeMod(seconds, 1000)
  add(s, 's')
  return result || '0s'
}

interface Props {
  exchange: Exchange
  assetID: number
  bondFeeBuffer: number
  tier: number
  onSuccess: () => Promise<void>
  onBack: () => Promise<void>
}

export function WalletWaitForm ({
  exchange, assetID, bondFeeBuffer, tier, onSuccess, onBack
}: Props) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const walletMap = useAuthStore(s => s.walletMap)

  const [synced, setSynced] = useState(false)
  const [syncProgress, setSyncProgress] = useState(0)
  const [funded, setFunded] = useState(false)
  const [balance, setBalance] = useState(0)
  const [parentBalance, setParentBalance] = useState(0)
  const [remainingTime, setRemainingTime] = useState<string | null>(null)
  const [finishingUp, setFinishingUp] = useState(false)

  const progressCacheRef = useRef<ProgressPoint[]>([])
  const progressedRef = useRef(false)
  const fundedRef = useRef(false)
  const successCalledRef = useRef(false)

  const asset = assets[assetID]
  const bondAsset = asset ? exchange.bondAssets[asset.symbol] : undefined
  const parentID = asset?.token?.parentID
  const parentAsset = parentID !== undefined ? assets[parentID] : undefined

  // Initialize state from the current wallet on mount.
  useEffect(() => {
    if (!asset?.wallet || !bondAsset) return
    const { balance: bal, synced: walletSynced, syncProgress: walletProgress } = asset.wallet
    setSyncProgress(walletProgress)
    setSynced(walletSynced)
    setBalance(bal.available)
    if (walletSynced) progressedRef.current = true

    const threshold = 2 * bondAsset.amount + bondFeeBuffer
    if (bal.available >= threshold) {
      setFunded(true)
      fundedRef.current = true
    }
  }, [asset, bondAsset, bondFeeBuffer])

  const trySuccess = useCallback(async () => {
    if (successCalledRef.current) return
    if (progressedRef.current && fundedRef.current) {
      successCalledRef.current = true
      await onSuccess()
    }
  }, [onSuccess])

  const reportProgress = useCallback(async (isSynced: boolean, prog: number) => {
    if (isSynced) {
      setSyncProgress(1)
      setSynced(true)
      setRemainingTime(null)
      setFinishingUp(false)
      progressedRef.current = true
      await trySuccess()
      return
    }
    setSyncProgress(prog)

    if (prog >= 0.999) {
      setFinishingUp(true)
      setRemainingTime(null)
      return
    }
    setFinishingUp(false)

    const cacheSize = 20
    const cache = progressCacheRef.current
    cache.push({ stamp: Date.now(), progress: prog })
    if (cache.length < 2) return
    while (cache.length > cacheSize) cache.shift()
    const [first, last] = [cache[0], cache[cache.length - 1]]
    const progDelta = last.progress - first.progress
    if (progDelta === 0) return
    const timeDelta = last.stamp - first.stamp
    const progRate = progDelta / timeDelta
    const toGoProg = 1 - last.progress
    const toGoTime = toGoProg / progRate
    setRemainingTime(formatDuration(toGoTime))
  }, [trySuccess])

  const reportBalance = useCallback(async (noteAssetID: number) => {
    if (fundedRef.current || assetID === -1) return
    if (noteAssetID !== assetID && noteAssetID !== parentID) return
    const currentAsset = assets[assetID]
    if (!currentAsset?.wallet || !bondAsset) return

    const avail = currentAsset.wallet.balance.available
    setBalance(avail)

    if (currentAsset.token && parentID !== undefined) {
      const pa = assets[parentID]
      if (pa?.wallet) {
        const parentAvail = pa.wallet.balance.available
        setParentBalance(parentAvail)
        if (parentAvail < bondFeeBuffer) return
      }
    }

    const threshold = 2 * bondAsset.amount + bondFeeBuffer
    if (avail < threshold) return

    setFunded(true)
    fundedRef.current = true
    await trySuccess()
  }, [assetID, parentID, assets, bondAsset, bondFeeBuffer, trySuccess])

  // Register notification handlers.
  useNotifications(useMemo(() => ({
    walletstate: (note: any) => {
      const wn = note as WalletStateNote
      if (progressedRef.current && fundedRef.current) return
      if (wn.wallet.assetID === assetID) {
        reportProgress(wn.wallet.synced, wn.wallet.syncProgress)
      }
      reportBalance(wn.wallet.assetID)
    },
    walletsync: (note: any) => {
      const wn = note as WalletSyncNote
      if (wn.assetID !== assetID) return
      const w = walletMap[wn.assetID]
      if (w) reportProgress(w.synced, w.syncProgress)
    },
    balance: (note: any) => {
      const bn = note as BalanceNote
      reportBalance(bn.assetID)
    },
  }), [assetID, reportProgress, reportBalance, walletMap]))

  if (!asset || !bondAsset) {
    return <div className="px-3 py-2">{t('Loading...')}</div>
  }

  const { symbol, unitInfo: ui } = asset
  const depositAddress = asset.wallet?.address ?? ''
  const bondLock = 2 * bondAsset.amount * tier
  const totalNeeded = bondLock + bondFeeBuffer
  const needMore = Math.max(totalNeeded - (asset.wallet?.balance.available ?? 0) + (asset.wallet?.balance.reservesDeficit ?? 0), 0)
  const isToken = !!asset.token

  return (
    <div className="px-3 py-2">
      <div className="fs20 mb-2 d-flex align-items-center gap-2">
        <img className="mini-icon" src={logoPath(symbol)} alt="" />
        {t('Waiting for wallet sync and funds')}
      </div>

      {/* Sync status */}
      <div className="d-flex align-items-center gap-2 mb-2">
        {synced
? (
          <span className="ico-check text-success" />
        )
: syncProgress >= 1
? (
          <span className="ico-spinner spinner" />
        )
: (
          <span className="ico-cross text-secondary" />
        )}
        <span className="fs15">
          {t('Sync')}: {(syncProgress * 100).toFixed(1)}%
        </span>
        {!synced && remainingTime && !finishingUp && (
          <span className="fs14 text-secondary">
            (~{remainingTime} {t('remaining')})
          </span>
        )}
        {!synced && finishingUp && (
          <span className="fs14 text-secondary">{t('WALLET_SYNC_FINISHING_UP')}</span>
        )}
      </div>

      {/* Balance status */}
      <div className="d-flex align-items-center gap-2 mb-2">
        {funded
? (
          <span className="ico-check text-success" />
        )
: (
          <span className="ico-cross text-secondary" />
        )}
        <span className="fs15">
          {t('Balance')}: {formatCoinValue(balance, ui)} {ui.conventional.unit}
        </span>
      </div>

      {/* Deposit info (shown when not yet funded) */}
      {!funded && (
        <div className="mb-3">
          {bondFeeBuffer > 0
? (
            <div className="fs14 mb-1">
              <div>{t('Bond lock')}: {formatCoinValue(bondLock, ui)} {ui.conventional.unit}</div>
              <div>{t('Fee buffer')}: {formatCoinValue(bondFeeBuffer, ui)} {ui.conventional.unit}</div>
              <div className="fw-bold">
                {t('Amount needed')}: {formatCoinValue(needMore, ui)} {ui.conventional.unit}
              </div>

              {isToken && parentAsset && (
                <div className="mt-1">
                  <div>
                    {t('Parent fees')}: {formatCoinValue(bondFeeBuffer, parentAsset.unitInfo)}{' '}
                    {parentAsset.unitInfo.conventional.unit}
                  </div>
                  <div>
                    {t('Parent balance')}: {formatCoinValue(parentBalance, parentAsset.unitInfo)}{' '}
                    {parentAsset.unitInfo.conventional.unit}
                  </div>
                </div>
              )}

              {!isToken && (
                <div className="fs14 mt-1 text-secondary">
                  {t('Total')}: {formatCoinValue(totalNeeded, ui)} {ui.conventional.unit}
                </div>
              )}
            </div>
          )
: (
            <div className="fs14 mb-1">
              {t('Send enough funds to cover the bond.')}
            </div>
          )}

          {depositAddress && (
            <div className="mb-2">
              <label className="fs14">{t('Deposit Address')}</label>
              <div className="fs13 text-break user-select-all border rounded p-2">
                {depositAddress}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="d-flex gap-2">
        <button
          className="btn btn-secondary"
          onClick={() => onBack()}
        >
          {t('Back')}
        </button>
      </div>
    </div>
  )
}
