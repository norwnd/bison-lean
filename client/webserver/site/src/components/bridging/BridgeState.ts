// Bridge reducer + context (B-L16).
//
// Direct port of vanilla
// `client/webserver/site/src/js/bridging/utils/BridgeState.ts`. The
// reducer logic is identical -- it tracks the user's bridge / source
// / destination selection across the asset selectors and tries to
// keep a valid (bridge, source, dest) tuple when any of the three is
// changed. The history pagination state is also kept here so all
// sub-components can read/write through dispatch.

import { createContext, useContext } from 'react'
import type { Dispatch } from 'react'
import type { BridgeFeesAndLimits } from '../../stores/types'
import { BridgeApprovalApproved, BridgeApprovalPending } from '../../stores/types'
import type { BridgeTransaction } from './bridgeData'

export type ApprovalStatus = 'approved' | 'pending' | 'notApproved' | 'loading' | 'notRequired'

export interface BridgeState {
  // Selection state (all non-nullable after initialization).
  bridgeName: string
  sourceAssetID: number
  destAssetID: number

  // Form state
  amount: string
  approvalStatus: ApprovalStatus
  feesAndLimits: BridgeFeesAndLimits | null

  // History
  pendingBridges: BridgeTransaction[]
  bridgeHistory: BridgeTransaction[]
  // Per-asset cursor for paging older history.
  bridgeHistoryRefIDByAsset: Record<number, string | null>
  bridgeHistoryDoneByAsset: Record<number, boolean>
  bridgeHistoryPageIndex: number
  bridgeHistoryPageSize: number
  bridgeHistoryLoaded: boolean

  // Bridge topology (immutable after init).
  allBridgePaths: Record<number, Record<number, string[]>>

  // UI state
  loading: boolean
  historyLoading: boolean
  submitting: boolean
  error: string | null
  activeTab: 'bridge' | 'history'

  // Counter bumped by imperative note handlers to trigger
  // useEffect-driven refresh in BridgeForm.
  balanceRefreshToken: number
}

type BridgePatch = Partial<Pick<
  BridgeState,
  'amount' | 'approvalStatus' | 'feesAndLimits' | 'pendingBridges' | 'bridgeHistory' |
  'submitting' | 'error' | 'activeTab' | 'historyLoading' |
  'bridgeHistoryRefIDByAsset' | 'bridgeHistoryDoneByAsset' | 'bridgeHistoryPageIndex' | 'bridgeHistoryPageSize' | 'bridgeHistoryLoaded'
>>

export type BridgeAction =
  | {
      type: 'INITIALIZE'
      paths: Record<number, Record<number, string[]>>
      initialBridge: string
      initialSource: number
      initialDest: number
    }
  | { type: 'SELECT_BRIDGE'; bridgeName: string }
  | { type: 'SELECT_SOURCE'; sourceAssetID: number }
  | { type: 'SELECT_DESTINATION'; destAssetID: number }
  | { type: 'PATCH'; patch: BridgePatch }
  | { type: 'BUMP_BALANCE_REFRESH' }

export function createInitialState (): BridgeState {
  return {
    bridgeName: '',
    sourceAssetID: 0,
    destAssetID: 0,
    amount: '',
    approvalStatus: 'loading',
    feesAndLimits: null,
    pendingBridges: [],
    bridgeHistory: [],
    bridgeHistoryRefIDByAsset: {},
    bridgeHistoryDoneByAsset: {},
    bridgeHistoryPageIndex: 0,
    bridgeHistoryPageSize: 10,
    bridgeHistoryLoaded: false,
    allBridgePaths: {},
    loading: true,
    historyLoading: false,
    submitting: false,
    error: null,
    activeTab: 'bridge',
    balanceRefreshToken: 0
  }
}

export function approvalStatusFromBridgeApproval (status: number): ApprovalStatus {
  if (status === BridgeApprovalApproved) return 'approved'
  if (status === BridgeApprovalPending) return 'pending'
  return 'notApproved'
}

// Helper: Check if a (bridge, source, dest) combination is valid.
function isValidCombination (
  paths: Record<number, Record<number, string[]>>,
  bridgeName: string,
  sourceAssetID: number,
  destAssetID: number
): boolean {
  const bridges = paths[sourceAssetID]?.[destAssetID] || []
  return bridges.includes(bridgeName)
}

// Helper: Find a valid (bridge, source) for a destination.
function findBridgeAndSourceForDest (
  paths: Record<number, Record<number, string[]>>,
  destAssetID: number,
  preferredBridge?: string,
  preferredSource?: number
): { bridge: string; source: number } | null {
  if (preferredSource !== undefined) {
    const bridges = paths[preferredSource]?.[destAssetID] || []
    if (bridges.length > 0) {
      if (preferredBridge && bridges.includes(preferredBridge)) {
        return { bridge: preferredBridge, source: preferredSource }
      }
      return { bridge: bridges[0], source: preferredSource }
    }
  }

  for (const [srcIDStr, dests] of Object.entries(paths)) {
    const srcID = Number(srcIDStr)
    const bridges = dests[destAssetID] || []
    if (bridges.length > 0) {
      if (preferredBridge && bridges.includes(preferredBridge)) {
        return { bridge: preferredBridge, source: srcID }
      }
      return { bridge: bridges[0], source: srcID }
    }
  }
  return null
}

// Helper: Find a valid (bridge, dest) for a source.
function findBridgeAndDestForSource (
  paths: Record<number, Record<number, string[]>>,
  sourceAssetID: number,
  preferredBridge?: string,
  preferredDest?: number
): { bridge: string; dest: number } | null {
  const dests = paths[sourceAssetID] || {}

  if (preferredDest !== undefined) {
    const bridges = dests[preferredDest] || []
    if (bridges.length > 0) {
      if (preferredBridge && bridges.includes(preferredBridge)) {
        return { bridge: preferredBridge, dest: preferredDest }
      }
      return { bridge: bridges[0], dest: preferredDest }
    }
  }

  for (const [destIDStr, bridges] of Object.entries(dests)) {
    if (bridges.length > 0) {
      if (preferredBridge && bridges.includes(preferredBridge)) {
        return { bridge: preferredBridge, dest: Number(destIDStr) }
      }
      return { bridge: bridges[0], dest: Number(destIDStr) }
    }
  }
  return null
}

export function bridgeReducer (state: BridgeState, action: BridgeAction): BridgeState {
  switch (action.type) {
    case 'INITIALIZE': {
      const { paths, initialBridge, initialSource, initialDest } = action
      return {
        ...state,
        allBridgePaths: paths,
        bridgeName: initialBridge,
        sourceAssetID: initialSource,
        destAssetID: initialDest,
        loading: false
      }
    }

    case 'SELECT_BRIDGE': {
      const { bridgeName } = action

      // If the current (source, dest) still works with the new bridge,
      // keep them and just mark the approval status as loading so
      // BridgeForm re-fetches.
      if (isValidCombination(state.allBridgePaths, bridgeName, state.sourceAssetID, state.destAssetID)) {
        return {
          ...state,
          bridgeName,
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      // Try to keep current source, find a valid dest.
      const withSource = findBridgeAndDestForSource(
        state.allBridgePaths,
        state.sourceAssetID,
        bridgeName,
        state.destAssetID
      )
      if (withSource && withSource.bridge === bridgeName) {
        return {
          ...state,
          bridgeName,
          destAssetID: withSource.dest,
          amount: '',
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      // Try to keep current dest, find a valid source.
      const withDest = findBridgeAndSourceForDest(
        state.allBridgePaths,
        state.destAssetID,
        bridgeName,
        state.sourceAssetID
      )
      if (withDest && withDest.bridge === bridgeName) {
        return {
          ...state,
          bridgeName,
          sourceAssetID: withDest.source,
          amount: '',
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      // Last resort: any valid (source, dest) for this bridge.
      for (const [srcIDStr, dests] of Object.entries(state.allBridgePaths)) {
        for (const [destIDStr, bridges] of Object.entries(dests)) {
          if (bridges.includes(bridgeName)) {
            return {
              ...state,
              bridgeName,
              sourceAssetID: Number(srcIDStr),
              destAssetID: Number(destIDStr),
              amount: '',
              approvalStatus: 'loading',
              feesAndLimits: null
            }
          }
        }
      }

      // Bridge has no valid paths -- shouldn't happen since the
      // selectors are populated from the same paths map.
      return state
    }

    case 'SELECT_SOURCE': {
      const { sourceAssetID } = action

      if (isValidCombination(state.allBridgePaths, state.bridgeName, sourceAssetID, state.destAssetID)) {
        return {
          ...state,
          sourceAssetID,
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      const result = findBridgeAndDestForSource(
        state.allBridgePaths,
        sourceAssetID,
        state.bridgeName,
        state.destAssetID
      )
      if (result) {
        return {
          ...state,
          sourceAssetID,
          bridgeName: result.bridge,
          destAssetID: result.dest,
          amount: '',
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      return state
    }

    case 'SELECT_DESTINATION': {
      const { destAssetID } = action

      if (isValidCombination(state.allBridgePaths, state.bridgeName, state.sourceAssetID, destAssetID)) {
        return {
          ...state,
          destAssetID,
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      const result = findBridgeAndSourceForDest(
        state.allBridgePaths,
        destAssetID,
        state.bridgeName,
        state.sourceAssetID
      )
      if (result) {
        return {
          ...state,
          destAssetID,
          bridgeName: result.bridge,
          sourceAssetID: result.source,
          amount: '',
          approvalStatus: 'loading',
          feesAndLimits: null
        }
      }

      return state
    }

    case 'PATCH':
      return { ...state, ...action.patch }

    case 'BUMP_BALANCE_REFRESH':
      return { ...state, balanceRefreshToken: state.balanceRefreshToken + 1 }

    default:
      return state
  }
}

// Context
export const BridgeStateContext = createContext<BridgeState | null>(null)
export const BridgeDispatchContext = createContext<Dispatch<BridgeAction> | null>(null)

export function useBridgeState (): BridgeState {
  const ctx = useContext(BridgeStateContext)
  if (!ctx) throw new Error('useBridgeState must be used within BridgeStateProvider')
  return ctx
}

export function useBridgeDispatch (): Dispatch<BridgeAction> {
  const ctx = useContext(BridgeDispatchContext)
  if (!ctx) throw new Error('useBridgeDispatch must be used within BridgeDispatchProvider')
  return ctx
}
