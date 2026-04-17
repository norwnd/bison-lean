import { MarketOrderBook, MiniOrder } from '../stores/types'

export default class OrderBook {
  base: number
  baseSymbol: string
  quote: number
  quoteSymbol: string
  buys: MiniOrder[]
  sells: MiniOrder[]
  onChange?: () => void

  constructor (mktBook: MarketOrderBook, baseSymbol: string, quoteSymbol: string, onChange?: () => void) {
    this.base = mktBook.base
    this.baseSymbol = baseSymbol
    this.quote = mktBook.quote
    this.quoteSymbol = quoteSymbol
    this.buys = mktBook.book.buys || []
    this.sells = mktBook.book.sells || []
    this.onChange = onChange
  }

  add (ord: MiniOrder) {
    if (ord.qtyAtomic === 0) {
      console.warn('zero quantity order encountered', ord)
      return
    }
    // Dedup by id: the server can legitimately re-announce the same order
    // (epoch→booked transition sends `book_order` while the epoch copy is
    // still present; reconnect replays overlap in-flight updates). Without
    // this, `binOrdersByRateAndEpoch` splits the two copies into separate
    // bins and the "own-order" dot renders twice. Inlined (not via
    // `this.remove`) to avoid firing `onChange` twice for a single add.
    if (!this.removeFromSide(this.sells, ord.id)) {
      this.removeFromSide(this.buys, ord.id)
    }
    const side = ord.sell ? this.sells : this.buys
    side.splice(findIdx(side, ord.rate, !ord.sell), 0, ord)
    this.onChange?.()
  }

  remove (id: string) {
    const changed = this.removeFromSide(this.sells, id) || this.removeFromSide(this.buys, id)
    if (changed) this.onChange?.()
  }

  removeFromSide (side: MiniOrder[], id: string) {
    const [ord, i] = this.findOrder(side, id)
    if (ord) {
      side.splice(i, 1)
      return true
    }
    return false
  }

  findOrder (side: MiniOrder[], id: string): [MiniOrder | null, number] {
    for (let i = 0; i < side.length; i++) {
      if (side[i].id === id) {
        return [side[i], i]
      }
    }
    return [null, -1]
  }

  updateRemaining (token: string, qty: number, qtyAtomic: number) {
    const changed = this.updateRemainingSide(this.sells, token, qty, qtyAtomic) ||
      this.updateRemainingSide(this.buys, token, qty, qtyAtomic)
    if (changed) this.onChange?.()
  }

  updateRemainingSide (side: MiniOrder[], token: string, qty: number, qtyAtomic: number) {
    const ord = this.findOrder(side, token)[0]
    if (ord) {
      ord.qty = qty
      ord.qtyAtomic = qtyAtomic
      return true
    }
    return false
  }

  setEpoch (epochIdx: number) {
    const approve = (ord: MiniOrder) => ord.epoch === undefined || ord.epoch === 0 || ord.epoch === epochIdx
    const before = this.sells.length + this.buys.length
    this.sells = this.sells.filter(approve)
    this.buys = this.buys.filter(approve)
    if (this.sells.length + this.buys.length !== before) this.onChange?.()
  }

  empty () {
    return !this.sells.length && !this.buys.length
  }

  count () {
    return this.sells.length + this.buys.length
  }

  bestOrder (sell: boolean): MiniOrder | null {
    const side = sell ? this.sells : this.buys
    return side.length > 0 ? side[0] : null
  }

  bestBuyRateAtom (): number {
    const bestBuy = this.bestOrder(false)
    return bestBuy ? bestBuy.msgRate : 0
  }

  bestSellRateAtom (): number {
    const bestSell = this.bestOrder(true)
    return bestSell ? bestSell.msgRate : 0
  }

  heaviestOrder (sell: boolean, bestPriceDriftTolerance: number): MiniOrder | null {
    const side = sell ? this.sells : this.buys
    if (side.length <= 0) return null

    const best = this.bestOrder(sell)
    if (!best) return null

    let heaviest = side[0]
    side.forEach((order: MiniOrder) => {
      if (bestPriceDriftTolerance > 0 && bestPriceDriftTolerance <= 1) {
        if (!sell && (best.msgRate - order.msgRate > bestPriceDriftTolerance * best.msgRate)) return
        if (sell && (order.msgRate - best.msgRate > bestPriceDriftTolerance * best.msgRate)) return
      }
      if (order.qtyAtomic > heaviest.qtyAtomic) {
        heaviest = order
      }
    })
    return heaviest
  }
}

function findIdx (side: MiniOrder[], rate: number, less: boolean): number {
  for (let i = 0; i < side.length; i++) {
    if ((side[i].rate < rate) === less) return i
  }
  return side.length
}
