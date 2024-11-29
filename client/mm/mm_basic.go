// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package mm

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"decred.org/dcrdex/client/core"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/calc"
)

// GapStrategy is a specifier for an algorithm to choose the maker bot's target
// spread.
type GapStrategy string

const (
	// GapStrategyMultiplier calculates the spread by multiplying the
	// break-even gap by the specified multiplier, 1 <= r <= 100.
	GapStrategyMultiplier GapStrategy = "multiplier"
	// GapStrategyAbsolute sets the spread to the rate difference.
	GapStrategyAbsolute GapStrategy = "absolute"
	// GapStrategyAbsolutePlus sets the spread to the rate difference plus the
	// break-even gap.
	GapStrategyAbsolutePlus GapStrategy = "absolute-plus"
	// GapStrategyPercent sets the spread as a ratio of the mid-gap rate.
	// 0 <= r <= 0.1
	GapStrategyPercent GapStrategy = "percent"
	// GapStrategyPercentPlus sets the spread as a ratio of the mid-gap rate
	// plus the break-even gap.
	GapStrategyPercentPlus GapStrategy = "percent-plus"
	// GapStrategyCompetitive picks an order rate that tries to compete with
	// the best buy/sell orders in the book but also keeps away from the
	// basis rate far enough to respect specified gap value. Note, unlike
	// other strategies this one ignores on-chain fees (essentially equating
	// these to 0) because they cause too much order book drift if we take
	// them into account, this is calculated risk taking - use it with cation.
	GapStrategyCompetitive GapStrategy = "competitive"
)

// OrderPlacement represents the distance from the mid-gap and the
// amount of lots that should be placed at this distance.
type OrderPlacement struct {
	// Lots is the max number of lots to place at this distance from the
	// mid-gap rate. If there is not enough balance to place this amount
	// of lots, the max that can be afforded will be placed.
	Lots uint64 `json:"lots"`

	// GapFactor controls the gap width in a way determined by the GapStrategy.
	GapFactor float64 `json:"gapFactor"`
}

// BasicMarketMakingConfig is the configuration for a simple market
// maker that places orders on both sides of the order book.
type BasicMarketMakingConfig struct {
	// GapStrategy selects an algorithm for calculating the distance from
	// the basis price to place orders.
	GapStrategy GapStrategy `json:"gapStrategy"`

	// SellPlacements is a list of order placements for sell orders.
	// The orders are prioritized from the first in this list to the
	// last.
	SellPlacements []*OrderPlacement `json:"sellPlacements"`

	// BuyPlacements is a list of order placements for buy orders.
	// The orders are prioritized from the first in this list to the
	// last.
	BuyPlacements []*OrderPlacement `json:"buyPlacements"`

	// DriftTolerance is how far away from an ideal price orders can drift
	// before they are replaced (units: ratio of price). Default: 0.1%.
	// 0 <= x <= 0.01.
	DriftTolerance float64 `json:"driftTolerance"`
}

func needBreakEvenHalfSpread(strat GapStrategy) bool {
	return strat == GapStrategyAbsolutePlus || strat == GapStrategyPercentPlus || strat == GapStrategyMultiplier
}

func (c *BasicMarketMakingConfig) Validate() error {
	if c.DriftTolerance < 0 || c.DriftTolerance > 0.01 {
		return fmt.Errorf("drift tolerance %f out of bounds", c.DriftTolerance)
	}

	if c.GapStrategy != GapStrategyMultiplier &&
		c.GapStrategy != GapStrategyPercent &&
		c.GapStrategy != GapStrategyPercentPlus &&
		c.GapStrategy != GapStrategyAbsolute &&
		c.GapStrategy != GapStrategyAbsolutePlus &&
		c.GapStrategy != GapStrategyCompetitive {
		return fmt.Errorf("unknown gap strategy %q", c.GapStrategy)
	}

	validatePlacement := func(p *OrderPlacement) error {
		var limits [2]float64
		switch c.GapStrategy {
		case GapStrategyMultiplier:
			limits = [2]float64{1, 100}
		case GapStrategyPercent, GapStrategyPercentPlus, GapStrategyCompetitive:
			limits = [2]float64{0, 0.1}
		case GapStrategyAbsolute, GapStrategyAbsolutePlus:
			limits = [2]float64{0, math.MaxFloat64} // validate at < spot price at creation time
		default:
			return fmt.Errorf("unknown gap strategy %q", c.GapStrategy)
		}

		if p.GapFactor < limits[0] || p.GapFactor > limits[1] {
			return fmt.Errorf("%s gap factor %f is out of bounds %+v", c.GapStrategy, p.GapFactor, limits)
		}

		return nil
	}

	sellPlacements := make(map[float64]bool, len(c.SellPlacements))
	for _, p := range c.SellPlacements {
		if _, duplicate := sellPlacements[p.GapFactor]; duplicate {
			return fmt.Errorf("duplicate sell placement %f", p.GapFactor)
		}
		sellPlacements[p.GapFactor] = true
		if err := validatePlacement(p); err != nil {
			return fmt.Errorf("invalid sell placement: %w", err)
		}
	}

	buyPlacements := make(map[float64]bool, len(c.BuyPlacements))
	for _, p := range c.BuyPlacements {
		if _, duplicate := buyPlacements[p.GapFactor]; duplicate {
			return fmt.Errorf("duplicate buy placement %f", p.GapFactor)
		}
		buyPlacements[p.GapFactor] = true
		if err := validatePlacement(p); err != nil {
			return fmt.Errorf("invalid buy placement: %w", err)
		}
	}

	return nil
}

type basicMMCalculator interface {
	basisPrice() (bp uint64, err error)
	halfSpread(uint64) (uint64, error)
	feeGapStats(uint64) (*FeeGapStats, error)
}

type basicMMCalculatorImpl struct {
	*market
	oracle oracle
	core   botCoreAdaptor
	cfg    *BasicMarketMakingConfig
	log    dex.Logger
}

var errNoBasisPrice = errors.New("no oracle or fiat rate available")
var errOracleFiatMismatch = errors.New("oracle rate and fiat rate mismatch")

// basisPrice calculates the basis price for the market maker.
// Oracle rate is used if available, otherwise fiat rate is used.
// Also, if both oracle and fiat rates are available this method
// makes sure their difference is below 5% - otherwise error is
// returned.
func (b *basicMMCalculatorImpl) basisPrice() (uint64, error) {
	oracleRate := b.msgRate(b.oracle.getMarketPrice(b.baseID, b.quoteID))
	b.log.Tracef("oracle rate = %s", b.fmtRate(oracleRate))

	rateFromFiat := b.core.ExchangeRateFromFiatSources()
	if rateFromFiat == 0 {
		b.log.Meter("basisPrice_nofiat_"+b.market.name, time.Hour).Warn(
			"No fiat-based rate estimate(s) available for sanity check for %s", b.market.name,
		)
		if oracleRate == 0 { // steppedRate(0, x) => x, so we have to handle this.
			return 0, errNoBasisPrice
		}
		return steppedRate(oracleRate, b.rateStep), nil
	}
	if oracleRate == 0 {
		b.log.Meter("basisPrice_nooracle_"+b.market.name, time.Hour).Infof(
			"No oracle rate available. Using fiat-derived basis rate = %s for %s", b.fmtRate(rateFromFiat), b.market.name,
		)
		return steppedRate(rateFromFiat, b.rateStep), nil
	}
	mismatch := math.Abs((float64(oracleRate) - float64(rateFromFiat)) / float64(oracleRate))
	const maxOracleFiatMismatch = 0.05
	if mismatch > maxOracleFiatMismatch {
		b.log.Meter("basisPrice_sanity_fail+"+b.market.name, time.Minute*20).Warnf(
			"Oracle rate sanity check failed for %s. oracle rate = %s, rate from fiat = %s",
			b.market.name, b.market.fmtRate(oracleRate), b.market.fmtRate(rateFromFiat),
		)
		return 0, errOracleFiatMismatch
	}

	return steppedRate(oracleRate, b.rateStep), nil
}

// halfSpread calculates the distance from the mid-gap where if you sell a lot
// at the basis price plus half-gap, then buy a lot at the basis price minus
// half-gap, you will have one lot of the base asset plus the total fees in
// base units. Since the fees are in base units, basis price can be used to
// convert the quote fees to base units. In the case of tokens, the fees are
// converted using fiat rates.
func (b *basicMMCalculatorImpl) halfSpread(basisPrice uint64) (uint64, error) {
	feeStats, err := b.feeGapStats(basisPrice)
	if err != nil {
		return 0, err
	}
	return feeStats.FeeGap / 2, nil
}

// FeeGapStats is info about market and fee state. The intepretation of the
// various statistics may vary slightly with bot type.
type FeeGapStats struct {
	BasisPrice    uint64 `json:"basisPrice"`
	RemoteGap     uint64 `json:"remoteGap"`
	FeeGap        uint64 `json:"feeGap"`
	RoundTripFees uint64 `json:"roundTripFees"` // base units
}

func (b *basicMMCalculatorImpl) feeGapStats(basisPrice uint64) (*FeeGapStats, error) {
	if basisPrice == 0 { // prevent divide by zero later
		return nil, fmt.Errorf("basis price cannot be zero")
	}

	sellFeesInBaseUnits, err := b.core.OrderFeesInUnits(true, true, basisPrice)
	if err != nil {
		return nil, fmt.Errorf("error getting sell fees in base units: %w", err)
	}

	buyFeesInBaseUnits, err := b.core.OrderFeesInUnits(false, true, basisPrice)
	if err != nil {
		return nil, fmt.Errorf("error getting buy fees in base units: %w", err)
	}

	/*
	 * g = half-gap
	 * r = basis price (atomic ratio)
	 * l = lot size
	 * f = total fees in base units
	 *
	 * We must choose a half-gap such that:
	 * (r + g) * l / (r - g) = l + f
	 *
	 * This means that when you sell a lot at the basis price plus half-gap,
	 * then buy a lot at the basis price minus half-gap, you will have one
	 * lot of the base asset plus the total fees in base units.
	 *
	 * Solving for g, you get:
	 * g = f * r / (f + 2l)
	 */

	f := sellFeesInBaseUnits + buyFeesInBaseUnits
	l := b.lotSize

	r := float64(basisPrice) / calc.RateEncodingFactor
	g := float64(f) * r / float64(f+2*l)

	halfGap := uint64(math.Round(g * calc.RateEncodingFactor))

	//if b.log.Level() == dex.LevelTrace {
	//	b.log.Tracef("halfSpread: basis price = %s, lot size = %s, aggregate fees = %s, half-gap = %s, sell fees = %s, buy fees = %s",
	//		b.fmtRate(basisPrice), b.fmtBase(l), b.fmtBaseFees(f), b.fmtRate(halfGap),
	//		b.fmtBaseFees(sellFeesInBaseUnits), b.fmtBaseFees(buyFeesInBaseUnits))
	//}

	return &FeeGapStats{
		BasisPrice:    basisPrice,
		FeeGap:        halfGap * 2,
		RoundTripFees: f,
	}, nil
}

type basicMarketMaker struct {
	*unifiedExchangeAdaptor
	cfgV             atomic.Value // *BasicMarketMakingConfig
	core             botCoreAdaptor
	oracle           oracle
	rebalanceRunning atomic.Bool
	calculator       basicMMCalculator
	// firstReliableBisonPrice is a reference Bison price calculated at the start
	// of this MM bot, its value is the first reliable/confirmed Bison price we've
	// got.
	firstReliableBisonPrice uint64
	// firstReliableBasisPrice is same as firstReliableBisonPrice for Basis price.
	firstReliableBasisPrice uint64
}

var _ bot = (*basicMarketMaker)(nil)

func (m *basicMarketMaker) cfg() *BasicMarketMakingConfig {
	return m.cfgV.Load().(*BasicMarketMakingConfig)
}

func (m *basicMarketMaker) orderPrice(truePrice, bestPrice, feeAdj uint64, sell bool, gapFactor float64) uint64 {
	if m.cfg().GapStrategy == GapStrategyCompetitive {
		var chosenPrice uint64
		// maxAdj is how close we are permitted to get to truePrice
		maxAdj := uint64(math.Round(gapFactor * float64(truePrice)))
		if sell {
			chosenPrice = bestPrice - m.rateStep
			if chosenPrice < (truePrice + maxAdj) {
				chosenPrice = truePrice + maxAdj
			}
		} else {
			chosenPrice = bestPrice + m.rateStep
			if chosenPrice > (truePrice - maxAdj) {
				chosenPrice = truePrice - maxAdj
			}
		}
		chosenPrice = steppedRate(chosenPrice, m.rateStep)
		m.log.Tracef(
			"(competitive strategy) prepare %s order: chosenPrice = %d, truePrice = %d, bestPrice = %d, gapFactor = %v",
			sellStr(sell),
			chosenPrice,
			truePrice,
			bestPrice,
			gapFactor,
		)
		return chosenPrice
	}

	var adj uint64

	// Apply the base strategy.
	switch m.cfg().GapStrategy {
	case GapStrategyMultiplier:
		adj = uint64(math.Round(float64(feeAdj) * gapFactor))
	case GapStrategyPercent, GapStrategyPercentPlus:
		adj = uint64(math.Round(gapFactor * float64(truePrice)))
	case GapStrategyAbsolute, GapStrategyAbsolutePlus:
		adj = m.msgRate(gapFactor)
	}

	// Add the break-even to the "-plus" strategies
	switch m.cfg().GapStrategy {
	case GapStrategyAbsolutePlus, GapStrategyPercentPlus:
		adj += feeAdj
	}

	adj = steppedRate(adj, m.rateStep)

	if sell {
		return truePrice + adj
	}

	if truePrice < adj {
		return 0
	}

	return truePrice - adj
}

func (m *basicMarketMaker) ordersToPlace() (buyOrders, sellOrders []*TradePlacement, err error) {
	m.log.Tracef("mm bot (basic) is starting to calculate placements")
	defer func() {
		m.log.Tracef(
			"mm bot (basic) is done calculating placements, buyOrdersCnt = %d, sellOrdersCnt = %d, err = %+v",
			len(buyOrders),
			len(sellOrders),
			err,
		)
	}()

	// maxAllowedRateDiffPercent is a safety threshold we don't want for MM bot to cross
	const maxAllowedRateDiffPercent = 0.05 // 5%
	var (
		// bisonRateDiffPercent is a directional (with +/- sign) difference between bisonPrice
		// and m.firstReliableBisonPrice
		bisonRateDiffPercent float64
		// basisRateDiffPercent is same as bisonRateDiffPercent, but for Basis price
		basisRateDiffPercent float64
	)

	book, feed, err := m.core.SyncBook(m.host, m.baseID, m.quoteID)
	if err != nil {
		return nil, nil, fmt.Errorf("fetch Bison book: %v", err)
	}
	defer feed.Close() // have to release resources, otherwise feed isn't used here
	bisonPrice, err := book.MidGap()
	if err != nil {
		return nil, nil, fmt.Errorf("calculate Bison rate: %v", err)
	}
	if m.firstReliableBisonPrice != 0 {
		// below we'll want to check how delinquent Bison price is (compared to the reliable
		// price we have from the time when MM bot started)
		bisonRateDiffPercent = (float64(bisonPrice) - float64(m.firstReliableBisonPrice)) / float64(m.firstReliableBisonPrice)
	}

	basisPrice, err := m.calculator.basisPrice()
	if err != nil {
		return nil, nil, err
	}
	if m.firstReliableBasisPrice != 0 {
		// below we'll want to check how delinquent Basis price is (compared to the reliable
		// price we have from the time when MM bot started)
		basisRateDiffPercent = (float64(basisPrice) - float64(m.firstReliableBasisPrice)) / float64(m.firstReliableBasisPrice)
	}

	m.log.Tracef("bisonPrice = %d", bisonPrice)
	m.log.Tracef("basisPrice = %d", basisPrice)

	{
		// check the confluence of Bison and Basis price
		rateConfluenceDiffPercent := math.Abs((float64(bisonPrice) - float64(basisPrice)) / float64(bisonPrice))
		if rateConfluenceDiffPercent > maxAllowedRateDiffPercent {
			return nil, nil, fmt.Errorf(
				"(strategy - %s) unacceptable bisonPrice = %d and basisPrice = %d mismatch of %v percent",
				m.cfg().GapStrategy,
				bisonPrice,
				basisPrice,
				rateConfluenceDiffPercent,
			)
		}
	}

	if m.firstReliableBisonPrice == 0 {
		// Bison price is reliable because it has confluence with Basis price, initializing
		// reference (first) price
		m.firstReliableBisonPrice = bisonPrice
	}
	if m.firstReliableBasisPrice == 0 {
		// Basis price is reliable because it has confluence with Bison price, initializing reference (first) price
		m.firstReliableBasisPrice = basisPrice
	}

	// find the best buy & sell orders in Bison books, these will help us determine
	// how good of a price we should offer (compared to unattractive & safe default)

	// bestBuy falls back to min(bisonPrice-4%, basisPrice-4%), this is a reasonably safe reference point
	// even when the difference between bisonPrice and basisPrice is large (at the edge of what's allowed)
	bestBuy := min(
		steppedRate(uint64(float64(bisonPrice)-0.04*float64(bisonPrice)), m.rateStep),
		steppedRate(uint64(float64(basisPrice)-0.04*float64(basisPrice)), m.rateStep),
	)
	// bestSell falls back to min(bisonPrice+4%, basisPrice+4%), this is reasonably safe reference point
	// in case the difference between bisonPrice and basisPrice is large
	bestSell := max(
		steppedRate(uint64(float64(bisonPrice)+0.04*float64(bisonPrice)), m.rateStep),
		steppedRate(uint64(float64(basisPrice)+0.04*float64(basisPrice)), m.rateStep),
	)
	m.log.Tracef("(default 4%%) bestBuy = %d, bestSell = %d", bestBuy, bestSell)
	bisonOrders, found, err := book.BestNOrders(1, false)
	if err != nil {
		return nil, nil, fmt.Errorf("find best buy order in Bison book: %v", err)
	}
	if found && bisonOrders[0].Rate > bestBuy {
		bestBuy = bisonOrders[0].Rate
	}
	bisonOrders, found, err = book.BestNOrders(1, true)
	if err != nil {
		return nil, nil, fmt.Errorf("find best sell order in Bison book: %v", err)
	}
	if found && bisonOrders[0].Rate < bestSell {
		bestSell = bisonOrders[0].Rate
	}
	m.log.Tracef("(with Bison book) bestBuy = %d, bestSell = %d", bestBuy, bestSell)

	feeGap, err := m.calculator.feeGapStats(basisPrice)
	if err != nil {
		return nil, nil, fmt.Errorf("error calculating fee gap stats: %w", err)
	}
	m.registerFeeGap(feeGap)
	var feeAdj uint64
	if needBreakEvenHalfSpread(m.cfg().GapStrategy) {
		feeAdj = feeGap.FeeGap / 2
	}

	orders := func(orderPlacements []*OrderPlacement, sell bool) []*TradePlacement {
		placements := make([]*TradePlacement, 0, len(orderPlacements))
		for _, p := range orderPlacements {
			// when assessing how far the price has gone since MM bot started (current price vs first
			// reliable price difference), we must 1) never chase the price and 2) we actually always
			// want to "resist it, but from a safe distance" (because this is the best time to
			// buy/sell into - best liquidity, since people panic/FoMO in those moments)
			if sell {
				if bisonRateDiffPercent < 0 && math.Abs(bisonRateDiffPercent) > maxAllowedRateDiffPercent {
					m.log.Tracef(
						"(strategy - %s) won't place sell order since bisonPrice = %d has rapidly moved down compared to firstReliableBisonPrice = %d (mismatch of %v percent)",
						m.cfg().GapStrategy,
						bisonPrice,
						m.firstReliableBisonPrice,
						math.Abs(bisonRateDiffPercent),
					)
					continue
				}
				if bisonRateDiffPercent < 0 && math.Abs(basisRateDiffPercent) > maxAllowedRateDiffPercent {
					m.log.Tracef(
						"(strategy - %s) won't place sell order since basisPrice = %d has rapidly moved down compared to firstReliableBasisPrice = %d (mismatch of %v percent)",
						m.cfg().GapStrategy,
						basisPrice,
						m.firstReliableBasisPrice,
						math.Abs(basisRateDiffPercent),
					)
					continue
				}
			}
			if !sell {
				if bisonRateDiffPercent > 0 && math.Abs(bisonRateDiffPercent) > maxAllowedRateDiffPercent {
					m.log.Tracef(
						"(strategy - %s) won't place buy order since bisonPrice = %d has rapidly moved up compared to firstReliableBisonPrice = %d (mismatch of %v percent)",
						m.cfg().GapStrategy,
						bisonPrice,
						m.firstReliableBisonPrice,
						math.Abs(bisonRateDiffPercent),
					)
					continue
				}
				if bisonRateDiffPercent > 0 && math.Abs(basisRateDiffPercent) > maxAllowedRateDiffPercent {
					m.log.Tracef(
						"(strategy - %s) won't place buy order since basisPrice = %d has rapidly moved up compared to firstReliableBasisPrice = %d (mismatch of %v percent)",
						m.cfg().GapStrategy,
						basisPrice,
						m.firstReliableBasisPrice,
						math.Abs(basisRateDiffPercent),
					)
					continue
				}
			}

			bestPrice := bestBuy
			if sell {
				bestPrice = bestSell
			}
			// truePrice is the most reliable estimate of "real" price we can get, for now
			// we consider basisPrice to be "safest", but once we can calculate
			// MidGapBookWeightedWithSpread we might prefer switching to that if there is
			// enough liquidity in Bison book(s) and the spread it returns is low (and
			// we ofc will still need to fall back to basisPrice here otherwise).
			// And in case there is no reliable basisPrice to fall back to - we can use
			// bisonPrice itself as true price IF it's within reasonable range compared
			// to some other values (like spot price, or last confirmed price).
			truePrice := basisPrice
			rate := m.orderPrice(truePrice, bestPrice, feeAdj, sell, p.GapFactor)

			lots := p.Lots
			if rate == 0 {
				lots = 0 // just a no-op placement I guess
			}
			placements = append(placements, &TradePlacement{
				Rate: rate,
				Lots: lots,
			})
		}
		return placements
	}

	// TODO - since MM bot doesn't support disable 1 side in UI we are temporarily
	// hardcoding it here until the following issue is resolved:
	// https://github.com/decred/dcrdex/issues/3101
	buyOrders = orders(m.cfg().BuyPlacements, false)
	//sellOrders = orders(m.cfg().SellPlacements, true)
	return buyOrders, sellOrders, nil
}

func (m *basicMarketMaker) rebalance(newEpoch uint64) {
	if !m.rebalanceRunning.CompareAndSwap(false, true) {
		return
	}
	defer m.rebalanceRunning.Store(false)

	m.log.Tracef("rebalance: epoch %d", newEpoch)

	if !m.checkBotHealth(newEpoch) {
		m.tryCancelOrders(m.ctx, &newEpoch, false)
		return
	}

	// simple work-around for not competing with my own (bot's) orders in Bison book,
	// every 4th epoch (happens every 60s) we simply revoke our orders so that we can
	// re-book these with correct price (presumably on that very same epoch).
	// Additionally, by canceling orders here we are also making sure no delinquent
	// order of ours stays in Bison book for too long (e.g. when Binance price changes
	// rapidly the orders we have in Bison book will stay there until we prepare next
	// batch of order placements that are meant to replace them - which we won't be able
	// to do since speedy price change completely prevents MM bot from preparing/placing
	// any orders due to lack of price confluence between Bison and Oracle price; and
	// inability to fetch oracle price also prevents MM bot from revising/updating his
	// trades in the current implementation)
	if newEpoch%4 == 0 {
		m.tryCancelOrders(m.ctx, &newEpoch, false)
	}

	var buysReport, sellsReport *OrderReport
	buyOrders, sellOrders, determinePlacementsErr := m.ordersToPlace()
	if determinePlacementsErr != nil {
		m.tryCancelOrders(m.ctx, &newEpoch, false)
	} else {
		_, buysReport = m.multiTrade(buyOrders, false, m.cfg().DriftTolerance, newEpoch)
		_, sellsReport = m.multiTrade(sellOrders, true, m.cfg().DriftTolerance, newEpoch)
	}

	epochReport := &EpochReport{
		BuysReport:  buysReport,
		SellsReport: sellsReport,
		EpochNum:    newEpoch,
	}
	epochReport.setPreOrderProblems(determinePlacementsErr)
	m.updateEpochReport(epochReport)
}

func (m *basicMarketMaker) botLoop(ctx context.Context) (*sync.WaitGroup, error) {
	_, bookFeed, err := m.core.SyncBook(m.host, m.baseID, m.quoteID)
	if err != nil {
		return nil, fmt.Errorf("failed to sync book: %v", err)
	}

	m.calculator = &basicMMCalculatorImpl{
		market: m.market,
		oracle: m.oracle,
		core:   m.core,
		cfg:    m.cfg(),
		log:    m.log,
	}

	// Process book updates
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer bookFeed.Close()
		for {
			select {
			case ni := <-bookFeed.Next():
				m.log.Tracef(
					"MM bot %s got book feed update, action: %s, market: %s, host: %s",
					m.botID,
					ni.Action,
					ni.MarketID,
					ni.Host,
				)
				switch epoch := ni.Payload.(type) {
				case *core.ResolvedEpoch:
					m.rebalance(epoch.Current)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	return &wg, nil
}

func (m *basicMarketMaker) updateConfig(cfg *BotConfig) error {
	if cfg.BasicMMConfig == nil {
		// implies bug in caller
		return errors.New("no market making config provided")
	}

	err := cfg.BasicMMConfig.Validate()
	if err != nil {
		return fmt.Errorf("invalid market making config: %v", err)
	}

	m.cfgV.Store(cfg.BasicMMConfig)
	return nil
}

// RunBasicMarketMaker starts a basic market maker bot.
func newBasicMarketMaker(cfg *BotConfig, adaptorCfg *exchangeAdaptorCfg, oracle oracle, log dex.Logger) (*basicMarketMaker, error) {
	if cfg.BasicMMConfig == nil {
		// implies bug in caller
		return nil, errors.New("no market making config provided")
	}

	adaptor, err := newUnifiedExchangeAdaptor(adaptorCfg)
	if err != nil {
		return nil, fmt.Errorf("error constructing exchange adaptor: %w", err)
	}

	err = cfg.BasicMMConfig.Validate()
	if err != nil {
		return nil, fmt.Errorf("invalid market making config: %v", err)
	}

	basicMM := &basicMarketMaker{
		unifiedExchangeAdaptor: adaptor,
		core:                   adaptor,
		oracle:                 oracle,
	}
	basicMM.cfgV.Store(cfg.BasicMMConfig)
	adaptor.setBotLoop(basicMM.botLoop)
	return basicMM, nil
}
