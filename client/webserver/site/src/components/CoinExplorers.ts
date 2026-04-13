export const Mainnet = 0
export const Testnet = 1
export const Simnet = 2

const coinIDTakerFoundMakerRedemption = 'TakerFoundMakerRedemption:'

function ethBasedExplorerArg (cid: string): [string, boolean] {
  if (cid.startsWith('relayTaskHash')) {
    const parts = cid.split(',')
    return [parts[0].substring('relayTaskHash:'.length), false]
  }
  if (cid.startsWith(coinIDTakerFoundMakerRedemption)) return [cid.substring(coinIDTakerFoundMakerRedemption.length), true]
  else if (cid.length === 42) return [cid, true]
  else return [cid, false]
}

const ethExplorers: Record<number, (cid: string) => string> = {
  [Mainnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://etherscan.io/address/${arg}` : `https://etherscan.io/tx/${arg}`
  },
  [Testnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://sepolia.etherscan.io/address/${arg}` : `https://sepolia.etherscan.io/tx/${arg}`
  },
  [Simnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://etherscan.io/address/${arg}` : `https://etherscan.io/tx/${arg}`
  }
}

const polygonExplorers: Record<number, (cid: string) => string> = {
  [Mainnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://polygonscan.com/address/${arg}` : `https://polygonscan.com/tx/${arg}`
  },
  [Testnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://amoy.polygonscan.com/address/${arg}` : `https://amoy.polygonscan.com/tx/${arg}`
  },
  [Simnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://polygonscan.com/address/${arg}` : `https://polygonscan.com/tx/${arg}`
  }
}

const optimismExplorers: Record<number, (cid: string) => string> = {
  [Mainnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://basescan.org/address/${arg}` : `https://basescan.org/tx/${arg}`
  },
  [Testnet]: (cid: string) => {
    const [arg, isAddr] = ethBasedExplorerArg(cid)
    return isAddr ? `https://base-sepolia.blockscout.com/address/${arg}` : `https://base-sepolia.blockscout.com/tx/${arg}`
  }
}

export const CoinExplorers: Record<number, Record<number, (cid: string) => string>> = {
  42: { // dcr
    [Mainnet]: (cid: string) => `https://dcrdata.decred.org/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://testnet.decred.org/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `http://127.0.0.1:17779/tx/${cid.split(':')[0]}`
  },
  0: { // btc
    [Mainnet]: (cid: string) => `https://mempool.space/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://mempool.space/testnet/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://mempool.space/tx/${cid.split(':')[0]}`
  },
  2: { // ltc
    [Mainnet]: (cid: string) => `https://ltc.bitaps.com/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://sochain.com/tx/LTCTEST/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://ltc.bitaps.com/${cid.split(':')[0]}`
  },
  20: { // dgb
    [Mainnet]: (cid: string) => `https://digiexplorer.info/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://testnetexplorer.digibyteservers.io/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://digiexplorer.info/tx/${cid.split(':')[0]}`
  },
  60: ethExplorers,
  60001: ethExplorers,
  60002: ethExplorers,
  8453: optimismExplorers,
  61000: optimismExplorers,
  61001: optimismExplorers,
  61002: optimismExplorers,
  3: { // doge
    [Mainnet]: (cid: string) => `https://dogeblocks.com/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://blockexplorer.one/dogecoin/testnet/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://dogeblocks.com/tx/${cid.split(':')[0]}`
  },
  5: { // dash
    [Mainnet]: (cid: string) => `https://blockexplorer.one/dash/mainnet/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://blockexplorer.one/dash/testnet/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://blockexplorer.one/dash/mainnet/tx/${cid.split(':')[0]}`
  },
  133: { // zec
    [Mainnet]: (cid: string) => `https://zcashblockexplorer.com/transactions/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://blockexplorer.one/zcash/testnet/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://zcashblockexplorer.com/transactions/${cid.split(':')[0]}`
  },
  147: { // zcl
    [Mainnet]: (cid: string) => `https://explorer.zcl.zelcore.io/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://explorer.zcl.zelcore.io/tx/${cid.split(':')[0]}`
  },
  128: { // xmr
    [Mainnet]: (cid: string) => `https://monerohash.com/explorer/tx/${cid.split(':')[0]}`
  },
  136: { // firo
    [Mainnet]: (cid: string) => `https://explorer.firo.org/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://testexplorer.firo.org/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://explorer.firo.org/tx/${cid.split(':')[0]}`
  },
  145: { // bch
    [Mainnet]: (cid: string) => `https://bch.loping.net/tx/${cid.split(':')[0]}`,
    [Testnet]: (cid: string) => `https://tbch4.loping.net/tx/${cid.split(':')[0]}`,
    [Simnet]: (cid: string) => `https://bch.loping.net/tx/${cid.split(':')[0]}`
  },
  966: polygonExplorers,
  966001: polygonExplorers,
  966002: polygonExplorers,
  966003: polygonExplorers,
  966004: polygonExplorers
}

export function explorerURL (assetID: number, coinID: string, net: number): string | null {
  const explorer = CoinExplorers[assetID]
  if (!explorer) return null
  const formatter = explorer[net]
  if (!formatter) return null
  return formatter(coinID)
}

export function formatCoinID (cid: string): string[] {
  if (cid.startsWith(coinIDTakerFoundMakerRedemption)) {
    const makerAddr = cid.substring(coinIDTakerFoundMakerRedemption.length)
    return [`Taker found maker redemption: ${makerAddr}`]
  }
  if (cid.startsWith('relayTaskHash:')) {
    return ['Sent to relayer']
  }
  return [cid]
}
