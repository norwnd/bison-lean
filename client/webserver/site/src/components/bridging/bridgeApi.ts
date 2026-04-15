// API wrapper functions for the bridging subsystem (B-L16).
//
// Mirrors the methods exposed on vanilla's `app()` singleton (e.g.
// `app().bridgeFeesAndLimits`, `app().approveBridgeContract`) but
// against the actual `/api/*` endpoints registered in
// `client/webserver/webserver.go`. Each function returns the
// already-parsed JSON object the Go server emits, so the caller can
// branch on `res.ok` exactly as vanilla did.
//
// Shape parity:
// - All request bodies use the camelCase JSON tags from the Go form
//   structs (e.g. `fromAssetID`, `bridgeName`).
// - Response shapes match the inline structs in
//   `client/webserver/api.go` apiBridge*/apiAllBridgePaths/etc.

import { getJSON, postJSON, checkResponse } from '../../services/api'
import type { BridgeFeesAndLimits, WalletTransaction } from '../../stores/types'

export interface BridgePathsResult {
  ok: boolean
  msg?: string
  paths: Record<number, Record<number, string[]>>
}

export interface BridgeFeesAndLimitsResult {
  ok: boolean
  msg?: string
  result: BridgeFeesAndLimits
}

export interface BridgeApprovalStatusResult {
  ok: boolean
  msg?: string
  status: number
}

export interface BridgeSubmitResult {
  ok: boolean
  msg?: string
  txID?: string
}

export interface PendingBridgesResult {
  ok: boolean
  msg?: string
  bridges: WalletTransaction[]
}

export interface BridgeHistoryResult {
  ok: boolean
  msg?: string
  bridges: WalletTransaction[]
}

// allBridgePaths fetches the global bridge topology -- a nested map
// of {sourceAssetID: {destAssetID: [bridgeNames]}}. Vanilla calls
// this once on app start; we fetch it lazily when the bridge popup
// opens since the React app doesn't have an equivalent boot-time
// step.
export async function allBridgePaths (): Promise<BridgePathsResult> {
  const res = await getJSON('/api/allbridgepaths')
  if (!checkResponse(res)) return { ok: false, msg: res.msg, paths: {} }
  return { ok: true, paths: res.paths ?? {} }
}

export async function bridgeFeesAndLimits (
  fromAssetID: number,
  toAssetID: number,
  bridgeName: string
): Promise<BridgeFeesAndLimitsResult> {
  const res = await postJSON('/api/bridgefeesandlimits', { fromAssetID, toAssetID, bridgeName })
  if (!checkResponse(res)) {
    return {
      ok: false,
      msg: res.msg,
      result: { fees: {}, minLimit: 0, maxLimit: 0, hasLimits: false }
    }
  }
  return { ok: true, result: res.result }
}

export async function bridgeApprovalStatus (
  assetID: number,
  bridgeName: string
): Promise<BridgeApprovalStatusResult> {
  const res = await postJSON('/api/bridgeapprovalstatus', { assetID, bridgeName })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, status: 0 }
  return { ok: true, status: res.status }
}

export async function approveBridgeContract (
  assetID: number,
  bridgeName: string
): Promise<BridgeSubmitResult> {
  const res = await postJSON('/api/approvebridgecontract', { assetID, bridgeName })
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true, txID: res.txID }
}

export async function bridge (
  fromAssetID: number,
  toAssetID: number,
  amount: number,
  bridgeName: string
): Promise<BridgeSubmitResult> {
  const res = await postJSON('/api/bridge', { fromAssetID, toAssetID, amount, bridgeName })
  if (!checkResponse(res)) return { ok: false, msg: res.msg }
  return { ok: true, txID: res.txID }
}

export async function pendingBridges (assetID: number): Promise<PendingBridgesResult> {
  const res = await postJSON('/api/pendingbridges', { assetID })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, bridges: [] }
  return { ok: true, bridges: (res.bridges ?? []) as WalletTransaction[] }
}

// bridgeHistory paginates older bridge transactions. `refID` is the
// last-seen tx ID to start from (or null for the first page); `past`
// is always true in vanilla -- we keep it as a parameter for parity
// in case the backend later supports forward paging.
export async function bridgeHistory (
  assetID: number,
  n: number,
  refID: string | null,
  past: boolean
): Promise<BridgeHistoryResult> {
  const res = await postJSON('/api/bridgehistory', { assetID, n, refID, past })
  if (!checkResponse(res)) return { ok: false, msg: res.msg, bridges: [] }
  return { ok: true, bridges: (res.bridges ?? []) as WalletTransaction[] }
}
