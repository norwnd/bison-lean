import {
  ExchangeAuth, Order, Market,
  OrderTypeLimit, OrderTypeMarket, OrderTypeCancel,
  ImmediateTiF, StandingTiF,
  StatusEpoch, StatusBooked, StatusExecuted,
  MatchSideMaker, MatchSideTaker, MakerRedeemed, TakerSwapCast, MatchComplete,
  RateEncodingFactor,
  Match
} from '../stores/types'

export const bondReserveMultiplier = 2
export const perTierBaseParcelLimit = 2
export const parcelLimitScoreMultiplier = 3

export function strongTier (auth: ExchangeAuth): number {
  const { weakStrength, targetTier, effectiveTier } = auth
  if (effectiveTier > targetTier) {
    const diff = effectiveTier - targetTier
    if (weakStrength >= diff) return targetTier
    return targetTier + (diff - weakStrength)
  }
  return effectiveTier
}

export function likelyTaker (ord: Order, rate: number): boolean {
  if (ord.type === OrderTypeMarket || ord.tif === ImmediateTiF) return true
  if (rate === 0) return false
  if (ord.sell) return ord.rate < rate
  return ord.rate > rate
}

const preparcelQuantity = (ord: Order, mkt?: Market, midGapAtom?: number) => {
  const qty = ord.qty - ord.filled
  if (ord.type === OrderTypeLimit) return qty
  if (ord.sell) return qty * (ord.rate / RateEncodingFactor)
  const rateAtom = midGapAtom || mkt?.spot?.rate || 0
  if (!mkt) return 0
  if (rateAtom && (mkt?.spot?.bookVolume || 0) > 0) return qty * RateEncodingFactor / rateAtom
  return mkt.lotsize
}

export function epochWeight (ord: Order, mkt: Market, midGapAtom?: number) {
  if (ord.status !== StatusEpoch) return 0
  const qty = preparcelQuantity(ord, mkt, midGapAtom)
  const rateAtom = midGapAtom || mkt.spot?.rate || 0
  if (likelyTaker(ord, rateAtom)) return qty * 2
  return qty
}

function bookWeight (ord: Order) {
  if (ord.status !== StatusBooked) return 0
  return preparcelQuantity(ord)
}

function settlingWeight (ord: Order) {
  let sum = 0
  for (const m of (ord.matches || [])) {
    if (m.side === MatchSideMaker) {
      if (m.status > MakerRedeemed) continue
    } else if (m.status > TakerSwapCast) continue
    sum += m.qty
  }
  return sum
}

function parcelWeight (ord: Order, mkt: Market, midGap?: number) {
  if (ord.type === OrderTypeCancel) return 0
  return epochWeight(ord, mkt, midGap) + bookWeight(ord) + settlingWeight(ord)
}

function limitBonus (score: number, maxScore: number): number {
  return score > 0 ? 1 + score / maxScore * (parcelLimitScoreMultiplier - 1) : 1
}

export function tradingLimits (
  exchanges: Record<string, { auth: ExchangeAuth; maxScore: number; markets: Record<string, Market> }>,
  host: string
): [number, number] {
  const { auth, maxScore, markets } = exchanges[host]
  const { rep: { score } } = auth
  const tier = strongTier(auth)

  let usedParcels = 0
  for (const mkt of Object.values(markets)) {
    let mktWeight = 0
    for (const ord of (mkt.inflight || [])) mktWeight += parcelWeight(ord, mkt)
    for (const ord of (mkt.orders || [])) mktWeight += parcelWeight(ord, mkt)
    usedParcels += (mktWeight / (mkt.parcelsize * mkt.lotsize))
  }
  const parcelLimit = perTierBaseParcelLimit * limitBonus(score, maxScore) * tier
  return [usedParcels, parcelLimit]
}

// Order utility functions (ported from orderutil.ts)

export function isMarketBuy (ord: Order): boolean {
  return ord.type === OrderTypeMarket && !ord.sell
}

export function hasActiveMatches (order: Order): boolean {
  if (!order.matches) return false
  for (const match of order.matches) {
    if (match.active) return true
  }
  return false
}

export function filled (order: Order): number {
  if (!order.matches) return 0
  const qty = isMarketBuy(order) ? (m: Match) => m.qty * (m.rate / RateEncodingFactor) : (m: Match) => m.qty
  return order.matches.reduce((f, match) => {
    if (match.isCancel) return f
    return f + qty(match)
  }, 0)
}

export function settled (order: Order): number {
  if (!order.matches) return 0
  const qty = isMarketBuy(order) ? (m: Match) => m.qty * (m.rate / RateEncodingFactor) : (m: Match) => m.qty
  return order.matches.reduce((s, match) => {
    if (match.isCancel) return s
    const redeemed = (match.side === MatchSideMaker && match.status >= MakerRedeemed) ||
      (match.side === MatchSideTaker && match.status >= MatchComplete)
    return redeemed ? s + qty(match) : s
  }, 0)
}

export function averageRate (ord: Order): number {
  if (!ord.matches?.length) return 0
  let rateProduct = 0
  let baseQty = 0
  for (const m of ord.matches) {
    baseQty += m.qty
    rateProduct += (m.rate * m.qty)
  }
  return rateProduct / baseQty
}

export function baseToQuote (rate: number, base: number): number {
  return rate * (base / RateEncodingFactor)
}

export function isCancellable (ord: Order): boolean {
  return ord.type === OrderTypeLimit && ord.tif === StandingTiF && ord.status < StatusExecuted
}
