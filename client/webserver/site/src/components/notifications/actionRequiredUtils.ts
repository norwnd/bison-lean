import type { TFunction } from 'i18next'
import type { SupportedAsset } from '../../stores/types'

// Mirrors asset.TransactionType in client/asset/interface.go. Keep in sync
// when new types are added on the Go side; unknown values fall back to
// the i18n key TX_TYPE_UNKNOWN.
export enum TxType {
  Unknown = 0,
  Send = 1,
  Receive = 2,
  Swap = 3,
  Redeem = 4,
  Refund = 5,
  Split = 6,
  CreateBond = 7,
  RedeemBond = 8,
  ApproveToken = 9,
  Acceleration = 10,
  SelfSend = 11,
  RevokeTokenApproval = 12,
  TicketPurchase = 13,
  TicketVote = 14,
  TicketRevocation = 15,
  SwapOrSend = 16,
  Mix = 17,
  InitiateBridge = 18,
  CompleteBridge = 19,
  DeployContract = 20,
}

const txTypeKeys: Record<number, string> = {
  [TxType.Send]: 'TX_TYPE_SEND',
  [TxType.Receive]: 'TX_TYPE_RECEIVE',
  [TxType.Swap]: 'TX_TYPE_SWAP',
  [TxType.Redeem]: 'TX_TYPE_REDEEM',
  [TxType.Refund]: 'TX_TYPE_REFUND',
  [TxType.Split]: 'TX_TYPE_SPLIT',
  [TxType.CreateBond]: 'TX_TYPE_CREATE_BOND',
  [TxType.RedeemBond]: 'TX_TYPE_REDEEM_BOND',
  [TxType.ApproveToken]: 'TX_TYPE_APPROVE_TOKEN',
  [TxType.Acceleration]: 'TX_TYPE_ACCELERATION',
  [TxType.SelfSend]: 'TX_TYPE_SELF_SEND',
  [TxType.RevokeTokenApproval]: 'TX_TYPE_REVOKE_TOKEN_APPROVAL',
  [TxType.TicketPurchase]: 'TX_TYPE_TICKET_PURCHASE',
  [TxType.TicketVote]: 'TX_TYPE_TICKET_VOTE',
  [TxType.TicketRevocation]: 'TX_TYPE_TICKET_REVOCATION',
  [TxType.SwapOrSend]: 'TX_TYPE_SWAP_OR_SEND',
  [TxType.Mix]: 'TX_TYPE_MIX',
  [TxType.InitiateBridge]: 'TX_TYPE_INITIATE_BRIDGE',
  [TxType.CompleteBridge]: 'TX_TYPE_COMPLETE_BRIDGE',
  [TxType.DeployContract]: 'TX_TYPE_DEPLOY_CONTRACT',
}

// txTypeLabel returns a localized display label for a numeric
// TransactionType. Unrecognized types fall back to TX_TYPE_UNKNOWN so
// the dialog never shows a raw integer to the user.
export function txTypeLabel (t: TFunction, type: number): string {
  const key = txTypeKeys[type]
  return key ? t(key) : t('TX_TYPE_UNKNOWN')
}

// shortHash trims a 0x-prefixed hash to "0xabcd…wxyz" for compact display
// in lists. Hashes shorter than the head+tail combined are returned as
// is.
export function shortHash (hash: string): string {
  if (hash.length <= 14) return hash
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`
}

// networkSuffix returns the parent-chain qualifier to append to a token
// asset's name in dialog copy - e.g. " on Ethereum" for USDC on Ethereum.
// Returns the empty string for base-chain assets (BTC, ETH, etc.) so the
// same i18n template ("Your {{asset}}{{network}} {{type}} ...") works
// for both: tokens read "Your USDC on Ethereum Redeem ..." and base
// assets read "Your Ethereum Redeem ..." with no awkward prefix.
//
// Returns just the suffix string (with leading space) rather than
// composing the full sentence so callers retain control over wording.
export function networkSuffix (
  assets: Record<number, SupportedAsset>,
  assetID: number,
  t: TFunction
): string {
  const asset = assets[assetID]
  const parentID = asset?.token?.parentID
  if (parentID === undefined) return ''
  const parent = assets[parentID]
  if (!parent) return ''
  return t('NETWORK_SUFFIX', { network: parent.name })
}
