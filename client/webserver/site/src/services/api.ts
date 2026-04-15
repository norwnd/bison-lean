export interface APIResponse {
  requestSuccessful: boolean
  ok: boolean
  msg: string
  err?: string
}

async function requestJSON (method: string, addr: string, reqBody?: string): Promise<any> {
  try {
    const response = await window.fetch(addr, {
      method: method,
      headers: new window.Headers({ 'content-type': 'application/json' }),
      body: reqBody
    })
    if (response.status !== 200) { throw response }
    const obj = await response.json()
    obj.requestSuccessful = true
    return obj
  } catch (response: any) {
    if (response && typeof response.text === 'function') {
      response.requestSuccessful = false
      response.msg = await response.text()
      return response
    }
    return { requestSuccessful: false, msg: String(response) }
  }
}

export async function postJSON (addr: string, data?: any): Promise<any> {
  return requestJSON('POST', addr, JSON.stringify(data))
}

export async function getJSON (addr: string): Promise<any> {
  return requestJSON('GET', addr)
}

export function checkResponse (resp: APIResponse): boolean {
  return resp.requestSuccessful && resp.ok
}

// Errors is a numeric enum whose values must match the Go-side iota
// ordering in `client/core/errors.go`. The server returns these codes
// on `res.code` for `writeAPIError` responses; the frontend compares
// against them to branch on specific failure modes (e.g.
// `res.code === Errors.activeOrdersErr` to trigger the force-confirm
// flow on recoverwallet / rescanwallet).
//
// IMPORTANT: the numeric indices are what's wire-compatible, not the
// names. But matching names to the Go source makes drift-hunting
// trivial when someone adds or renames a code.
//
// T18#7: previously had three drifted names (`noAuthErr`,
// `accountDisableErr`, `insufficientRedeemFundsRelayErr`) that were
// never referenced by any caller. Aligned to the Go names
// (`noAuthError`, `accountStatusUpdateErr`,
// `relayRedemptionLotSizeTooSmallErr`) so future additions stay
// mechanically verifiable by diffing the two files.
export enum Errors {
  walletErr,
  walletAuthErr,
  noAuthError,
  walletBalanceErr,
  dupeDEXErr,
  assetSupportErr,
  registerErr,
  signatureErr,
  zeroFeeErr,
  feeMismatchErr,
  feeSendErr,
  passwordErr,
  emptyHostErr,
  connectionErr,
  acctKeyErr,
  unknownOrderErr,
  orderParamsErr,
  dbErr,
  authErr,
  connectWalletErr,
  missingWalletErr,
  encryptionErr,
  decodeErr,
  accountVerificationErr,
  accountProofErr,
  parseKeyErr,
  marketErr,
  addressParseErr,
  addrErr,
  fileReadErr,
  unknownDEXErr,
  accountRetrieveErr,
  accountStatusUpdateErr,
  suspendedAcctErr,
  existenceCheckErr,
  createWalletErr,
  activeOrdersErr,
  newAddrErr,
  bondAmtErr,
  bondTimeErr,
  bondAssetErr,
  bondPostErr,
  insufficientRedeemFundsErr,
  relayRedemptionLotSizeTooSmallErr,
}
