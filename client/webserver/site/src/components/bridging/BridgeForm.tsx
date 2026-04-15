// BridgeForm — bridge initiation form (B-L16).
//
// Direct port of vanilla
// `client/webserver/site/src/js/bridging/components/BridgeForm.tsx`.
// Replaces `app()` with `useAuthStore`, `intl.prep` with
// `useTranslation`, vanilla `app().bindTooltips` with native `title`
// attributes, and `Doc.formatCoinValue` with `formatCoinValue` from
// `hooks/useFormatters`.

import { useEffect, useCallback, useMemo, useRef } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'
import { formatCoinValue } from '../../hooks/useFormatters'
import { BridgeApprovalPending } from '../../stores/types'
import {
  approvalStatusFromBridgeApproval,
  useBridgeState,
  useBridgeDispatch
} from './BridgeState'
import {
  bridgeFeesAndLimits,
  bridgeApprovalStatus,
  approveBridgeContract,
  bridge,
  pendingBridges as apiPendingBridges
} from './bridgeApi'
import {
  atomicToConventionalString,
  bridgeDisplayName,
  bridgeLogoPath,
  calculateMaxBridgeableAmount,
  networkInfo,
  parseConventionalToAtomic,
  assetLogoPath
} from './bridgeUtils'
import type { BridgeTransaction } from './bridgeData'

interface BridgeFormProps {
  networkAssetIDs: number[]
}

function BridgeForm ({ networkAssetIDs }: BridgeFormProps) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)
  const state = useBridgeState()
  const dispatch = useBridgeDispatch()
  const {
    bridgeName,
    sourceAssetID,
    destAssetID,
    amount,
    approvalStatus,
    feesAndLimits,
    allBridgePaths,
    loading,
    submitting,
    error,
    balanceRefreshToken
  } = state

  const sourceAsset = assets[sourceAssetID]
  const destAsset = assets[destAssetID]
  const availableAtomic = sourceAsset?.wallet?.balance?.available ?? 0
  // Request-version ref for the fees/approval load. If the user
  // changes selection mid-flight, the older request is discarded
  // when its result comes back.
  const loadFeesAndApprovalReq = useRef(0)

  // availableBridges returns the bridge identifiers that touch any
  // of the network assets currently displayed.
  const availableBridges = useMemo(() => {
    const set = new Set<string>()
    for (const srcID of networkAssetIDs) {
      const dests = allBridgePaths[srcID] || {}
      for (const bridges of Object.values(dests)) for (const b of bridges) set.add(b)
    }
    return Array.from(set).sort()
  }, [allBridgePaths, networkAssetIDs])

  // Source-asset options compatible with the current bridge.
  const availableSourceIDs = useMemo(() => {
    const ids: number[] = []
    for (const srcID of networkAssetIDs) {
      const dests = allBridgePaths[srcID]
      if (!dests) continue
      if (!bridgeName) {
        if (Object.keys(dests).length) ids.push(srcID)
        continue
      }
      const supportsBridge = Object.values(dests).some(bridges => bridges.includes(bridgeName))
      if (supportsBridge) ids.push(srcID)
    }
    return ids.sort((a, b) => a - b)
  }, [allBridgePaths, bridgeName, networkAssetIDs])

  // Destination-asset options compatible with the current bridge.
  const availableDestIDs = useMemo(() => {
    const set = new Set<number>()
    for (const srcID of networkAssetIDs) {
      const dests = allBridgePaths[srcID] || {}
      for (const [destStr, bridges] of Object.entries(dests)) {
        const destID = Number(destStr)
        if (!bridgeName || bridges.includes(bridgeName)) set.add(destID)
      }
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [allBridgePaths, bridgeName, networkAssetIDs])

  const allSources = useMemo(() => {
    return availableSourceIDs.map(id => ({ id, ...networkInfo(id, assets) }))
  }, [availableSourceIDs, assets])

  const allDestinations = useMemo(() => {
    return availableDestIDs.map(id => ({ id, ...networkInfo(id, assets) }))
  }, [availableDestIDs, assets])

  // parsedAmount re-runs whenever the user types a digit, switches
  // source asset, or after a balance refresh (so the same string
  // can validate differently against a refreshed balance). The
  // balanceRefreshToken dep is intentional: it's bumped by note
  // handlers to force re-validation against the latest balance.
  const parsedAmount = useMemo(() => {
    // balanceRefreshToken referenced via deps array below to force
    // re-validation when balances refresh; the value itself is unused
    // in the function body.
    if (!sourceAsset) {
      return {
        atomic: null as number | null,
        error: amount ? t('Invalid amount') : null
      }
    }
    return parseConventionalToAtomic(amount, sourceAsset.unitInfo)
  }, [amount, balanceRefreshToken, sourceAsset, t])

  const amountError = useMemo(() => {
    if (!amount) return null
    if (parsedAmount.error) return parsedAmount.error
    const atomic = parsedAmount.atomic ?? 0
    if (atomic <= 0) return t('Amount must be greater than 0')
    if (atomic > availableAtomic) {
      const maxStr = sourceAsset ? formatCoinValue(availableAtomic, sourceAsset.unitInfo) : ''
      return t('Insufficient balance (max: {{max}})', { max: maxStr })
    }
    // When bridging a base asset, leave room for the initiation fee.
    if (sourceAsset && !sourceAsset.token && feesAndLimits) {
      const baseAssetID = sourceAssetID
      const initiationFee = feesAndLimits.fees[baseAssetID] || 0
      if (atomic + initiationFee > availableAtomic) {
        const maxBridgeable = calculateMaxBridgeableAmount(sourceAssetID, availableAtomic, feesAndLimits, assets)
        const maxStr = formatCoinValue(maxBridgeable, sourceAsset.unitInfo)
        return t('Must reserve funds for fees (max bridgeable: {{max}})', { max: maxStr })
      }
    }
    if (feesAndLimits?.hasLimits && sourceAsset) {
      if (atomic < feesAndLimits.minLimit) {
        const minStr = formatCoinValue(feesAndLimits.minLimit, sourceAsset.unitInfo)
        return t('Amount is below minimum ({{min}})', { min: minStr })
      }
      if (atomic > feesAndLimits.maxLimit) {
        const maxStr = formatCoinValue(feesAndLimits.maxLimit, sourceAsset.unitInfo)
        return t('Amount is above maximum ({{max}})', { max: maxStr })
      }
    }
    return null
  }, [amount, parsedAmount, availableAtomic, feesAndLimits, sourceAssetID, sourceAsset, assets, t])

  // Load fees + approval status whenever the (source, dest, bridge)
  // selection changes. The request-version ref guards against
  // out-of-order responses from rapid selection changes.
  useEffect(() => {
    if (!destAssetID || !bridgeName || loading) return
    let cancelled = false
    const reqID = ++(loadFeesAndApprovalReq.current)
    ;(async () => {
      try {
        const fees = await bridgeFeesAndLimits(sourceAssetID, destAssetID, bridgeName)
        const approvalResp = await bridgeApprovalStatus(sourceAssetID, bridgeName)
        if (cancelled || reqID !== loadFeesAndApprovalReq.current) return
        if (!fees.ok) {
          dispatch({
            type: 'PATCH',
            patch: { error: t('Failed to load bridge info: {{err}}', { err: fees.msg ?? 'unknown error' }) }
          })
          return
        }
        dispatch({ type: 'PATCH', patch: { feesAndLimits: fees.result } })
        dispatch({
          type: 'PATCH',
          patch: {
            approvalStatus: approvalResp.ok ? approvalStatusFromBridgeApproval(approvalResp.status) : 'notRequired'
          }
        })
      } catch (e) {
        if (cancelled || reqID !== loadFeesAndApprovalReq.current) return
        dispatch({
          type: 'PATCH',
          patch: { error: t('Failed to load bridge info: {{err}}', { err: String(e) }) }
        })
      }
    })()
    return () => { cancelled = true }
  }, [sourceAssetID, destAssetID, bridgeName, loading, dispatch, t])

  const handleBridgeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    dispatch({ type: 'SELECT_BRIDGE', bridgeName: e.target.value })
  }, [dispatch])

  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    dispatch({ type: 'SELECT_SOURCE', sourceAssetID: parseInt(e.target.value) })
  }, [dispatch])

  const handleDestinationChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    dispatch({ type: 'SELECT_DESTINATION', destAssetID: parseInt(e.target.value) })
  }, [dispatch])

  const handleAmountChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch({ type: 'PATCH', patch: { amount: e.target.value } })
  }, [dispatch])

  const handleMaxClick = useCallback(() => {
    // balanceRefreshToken is in the deps array to recompute the
    // closure when balances refresh; not directly referenced here.
    if (!sourceAsset?.wallet?.balance) return
    const maxBridgeable = calculateMaxBridgeableAmount(
      sourceAssetID,
      sourceAsset.wallet.balance.available,
      feesAndLimits,
      assets
    )
    dispatch({
      type: 'PATCH',
      patch: { amount: atomicToConventionalString(maxBridgeable, sourceAsset.unitInfo, true) }
    })
  }, [sourceAssetID, balanceRefreshToken, feesAndLimits, dispatch, sourceAsset, assets])

  const handleApprove = useCallback(async () => {
    dispatch({ type: 'PATCH', patch: { submitting: true } })
    try {
      const resp = await approveBridgeContract(sourceAssetID, bridgeName)
      if (resp.ok) {
        dispatch({
          type: 'PATCH',
          patch: { approvalStatus: approvalStatusFromBridgeApproval(BridgeApprovalPending) }
        })
      } else {
        dispatch({
          type: 'PATCH',
          patch: { error: resp.msg || t('Approval failed') }
        })
      }
    } catch (e) {
      dispatch({
        type: 'PATCH',
        patch: { error: t('Approval error: {{err}}', { err: String(e) }) }
      })
    }
    dispatch({ type: 'PATCH', patch: { submitting: false } })
  }, [sourceAssetID, bridgeName, dispatch, t])

  const handleBridge = useCallback(async () => {
    if (!sourceAsset) {
      dispatch({ type: 'PATCH', patch: { error: t('Invalid source asset') } })
      return
    }
    const { atomic, error: amtErr } = parseConventionalToAtomic(amount, sourceAsset.unitInfo)
    if (amtErr || atomic === null || atomic <= 0) {
      dispatch({
        type: 'PATCH',
        patch: { error: amtErr || t('Invalid amount') }
      })
      return
    }

    dispatch({ type: 'PATCH', patch: { submitting: true } })
    try {
      const resp = await bridge(sourceAssetID, destAssetID, atomic, bridgeName)
      if (resp.ok) {
        // Optimistically refresh pending bridges so the user sees
        // their new tx in the History tab without waiting for the
        // bridge note. Failure here is fine -- the WS stream will
        // pick it up.
        let newPending: BridgeTransaction[] | undefined
        try {
          const pendingRes = await apiPendingBridges(sourceAssetID)
          if (pendingRes.ok) {
            newPending = pendingRes.bridges.map(tx => ({ ...tx, sourceAssetID }))
          }
        } catch (_e) {
          // Non-fatal.
        }
        dispatch({
          type: 'PATCH',
          patch: {
            amount: '',
            activeTab: 'history',
            ...(newPending && { pendingBridges: newPending })
          }
        })
      } else {
        dispatch({
          type: 'PATCH',
          patch: { error: resp.msg || t('Bridge failed') }
        })
      }
    } catch (e) {
      dispatch({
        type: 'PATCH',
        patch: { error: t('Bridge error: {{err}}', { err: String(e) }) }
      })
    }
    dispatch({ type: 'PATCH', patch: { submitting: false } })
  }, [sourceAssetID, destAssetID, amount, bridgeName, balanceRefreshToken, dispatch, sourceAsset, t])

  const formatFees = () => {
    if (!feesAndLimits) return null
    const feeEntries = Object.entries(feesAndLimits.fees)
    if (feeEntries.length === 0) return null

    return feeEntries.map(([assetIDStr, fee]) => {
      const assetID = parseInt(assetIDStr)
      const asset = assets[assetID]
      if (!asset) return null
      return (
        <div key={assetID} className="fs14 text-muted">
          {formatCoinValue(fee, asset.unitInfo)} {asset.unitInfo.conventional.unit}
        </div>
      )
    })
  }

  const canSubmit = useMemo(() => {
    if (submitting || loading) return false
    if (!destAssetID || !amount) return false
    if (amountError) return false
    if (approvalStatus === 'notApproved' || approvalStatus === 'pending' || approvalStatus === 'loading') return false
    if (parsedAmount.atomic === null || parsedAmount.atomic <= 0) return false
    return true
  }, [submitting, loading, destAssetID, amount, amountError, approvalStatus, parsedAmount.atomic])

  const needsApproval = approvalStatus === 'notApproved'

  if (loading) {
    return (
      <div className="flex-center p-4" style={{ minHeight: '300px' }}>
        <div className="ico-spinner spinner fs20"></div>
      </div>
    )
  }

  const isBridgeDisabled = submitting || availableBridges.length <= 1
  const isSourceDisabled = submitting || allSources.length <= 1
  const isDestDisabled = submitting || allDestinations.length <= 1

  return (
    <div className="flex-stretch-column" style={{ minHeight: '300px' }}>
      {/* Bridge selector */}
      <div className="mb-3 pb-3 border-bottom">
        <label className="form-label">{t('BRIDGE')}</label>
        <div className="position-relative">
          <img
            src={bridgeName ? bridgeLogoPath(bridgeName) : ''}
            className="mini-icon position-absolute"
            alt=""
            style={{ left: '10px', top: '50%', transform: 'translateY(-50%)', visibility: bridgeName ? 'visible' : 'hidden', zIndex: 1, pointerEvents: 'none' }}
            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
          />
          <select
            className="form-select"
            value={bridgeName}
            onChange={handleBridgeChange}
            disabled={isBridgeDisabled}
            style={{ opacity: isBridgeDisabled ? 0.5 : 1, paddingLeft: '38px' }}
          >
            {availableBridges.map(b => (
              <option key={b} value={b}>{bridgeDisplayName(b, 'long')}</option>
            ))}
          </select>
        </div>
        {/* Bridge Limits */}
        {feesAndLimits?.hasLimits && sourceAsset && (
          <div
            className="d-flex align-items-center fs14 text-muted mt-2"
            title={t('This bridge does not support bridging amounts outside of these limits.')}
          >
            <span className="me-1">{t('Bridge Limits')}:</span>
            <span>
              {formatCoinValue(feesAndLimits.minLimit, sourceAsset.unitInfo)} - {formatCoinValue(feesAndLimits.maxLimit, sourceAsset.unitInfo)}
            </span>
            <span className="ico-info fs12 ms-1"></span>
          </div>
        )}
      </div>

      {/* Source selector */}
      <div className="mb-3 pb-3 border-bottom">
        <label className="form-label">{t('From')}</label>
        <div className="position-relative">
          <img
            src={sourceAsset ? assetLogoPath(networkInfo(sourceAssetID, assets).symbol) : ''}
            className="mini-icon position-absolute"
            alt=""
            style={{ left: '10px', top: '50%', transform: 'translateY(-50%)', visibility: sourceAsset ? 'visible' : 'hidden', zIndex: 1, pointerEvents: 'none' }}
            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
          />
          <select
            className="form-select"
            value={sourceAssetID}
            onChange={handleSourceChange}
            disabled={isSourceDisabled}
            style={{ paddingLeft: '38px' }}
          >
            {allSources.map(net => (
              <option key={net.id} value={net.id}>{net.name}</option>
            ))}
          </select>
        </div>
        <div className="fs15 text-muted mt-1" style={{ minHeight: '18px' }}>
          {sourceAsset?.wallet?.balance && (
            <>
              {t('AVAILABLE_TITLE')}: {formatCoinValue(availableAtomic, sourceAsset.unitInfo)}
              {/* Show max bridgeable if different from available (base asset case) */}
              {!sourceAsset.token && feesAndLimits && (() => {
                const maxBridgeable = calculateMaxBridgeableAmount(sourceAssetID, availableAtomic, feesAndLimits, assets)
                if (maxBridgeable < availableAtomic) {
                  const maxStr = formatCoinValue(maxBridgeable, sourceAsset.unitInfo)
                  return (
                    <span className="ms-2">
                      ({t('Max bridgeable')}: {maxStr})
                    </span>
                  )
                }
                return null
              })()}
            </>
          )}
        </div>
      </div>

      {/* Destination selector */}
      <div className="mb-3 pb-3 border-bottom">
        <label className="form-label">{t('To')}</label>
        <div className="position-relative">
          <img
            src={destAsset ? assetLogoPath(networkInfo(destAssetID, assets).symbol) : ''}
            className="mini-icon position-absolute"
            alt=""
            style={{ left: '10px', top: '50%', transform: 'translateY(-50%)', visibility: destAsset ? 'visible' : 'hidden', zIndex: 1, pointerEvents: 'none' }}
            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
          />
          <select
            className="form-select"
            value={destAssetID}
            onChange={handleDestinationChange}
            disabled={isDestDisabled}
            style={{ paddingLeft: '38px' }}
          >
            {allDestinations.map(net => (
              <option key={net.id} value={net.id}>{net.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Amount input with max button */}
      <div className="mb-3 pb-3 border-bottom">
        <label className="form-label">{t('AMOUNT')}</label>
        <div className="position-relative">
          <input
            type="number"
            className={`form-control ${amountError ? 'is-invalid' : ''}`}
            value={amount}
            onChange={handleAmountChange}
            placeholder="0.0"
            disabled={submitting}
            step="any"
            style={{ paddingRight: '50px' }}
          />
          <div
            className="position-absolute d-flex align-items-center"
            style={{ right: '8px', top: '50%', transform: 'translateY(-50%)' }}
          >
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={handleMaxClick}
              disabled={submitting}
              style={{ fontSize: '11px', padding: '2px 6px' }}
            >
              {t('Max')}
            </button>
          </div>
        </div>
        {/* Amount error */}
        {amountError && (
          <div className="fs12 text-danger mt-1">{amountError}</div>
        )}
      </div>

      {/* Fees display - fixed height to prevent jumping */}
      <div className="mb-3" style={{ minHeight: '44px' }}>
        <label className="form-label">{t('ESTIMATED_FEES')}</label>
        <div style={{ minHeight: '20px' }}>
          {feesAndLimits
            ? formatFees()
            : <span className="ico-spinner spinner fs14"></span>}
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-3 fs14 text-danger">{error}</div>
      )}

      {/* Action button - shows Approve, Pending Approval, or Bridge depending on state */}
      {needsApproval
        ? (
          <button
            className="feature w-100"
            onClick={handleApprove}
            disabled={submitting}
          >
            {submitting ? <span className="ico-spinner spinner me-2"></span> : null}
            {t('APPROVE_CONTRACT')}
          </button>
          )
        : approvalStatus === 'pending'
          ? (
            <button
              className="feature w-100"
              disabled={true}
            >
              <span className="ico-spinner spinner me-2"></span>
              {t('APPROVAL_PENDING')}
            </button>
            )
          : (
            <button
              className="feature w-100"
              onClick={handleBridge}
              disabled={!canSubmit}
            >
              {submitting ? <span className="ico-spinner spinner me-2"></span> : null}
              {t('BRIDGE')}
            </button>
            )}

      {availableDestIDs.length === 0 && !loading && (
        <div className="text-center text-muted p-4">
          {t('NO_DESTINATIONS')}
        </div>
      )}
    </div>
  )
}

export default BridgeForm
