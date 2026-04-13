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

export enum Errors {
  walletErr,
  walletAuthErr,
  noAuthErr,
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
  accountDisableErr,
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
  insufficientRedeemFundsRelayErr,
}
