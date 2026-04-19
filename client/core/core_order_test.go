//go:build !harness && !botlive

package core

import (
	"testing"
	"time"

	"decred.org/dcrdex/client/db"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
)

func TestMarkets(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	// The test rig's dexConnection comes with a market. Clear that for this test.
	rig.dc.cfgMtx.Lock()
	rig.dc.cfg.Markets = nil
	rig.dc.cfgMtx.Unlock()
	numMarkets := 10

	tCore := rig.core
	// Simulate 10 markets.
	marketIDs := make(map[string]struct{})
	for i := 0; i < numMarkets; i++ {
		base, quote := randomMsgMarket()
		marketIDs[marketName(base.ID, quote.ID)] = struct{}{}
		rig.dc.cfgMtx.RLock()
		cfg := rig.dc.cfg
		rig.dc.cfgMtx.RUnlock()
		cfg.Markets = append(cfg.Markets, &msgjson.Market{
			Name:            base.Symbol + quote.Symbol,
			Base:            base.ID,
			Quote:           quote.ID,
			EpochLen:        5000,
			MarketBuyBuffer: 1.4,
		})
		rig.dc.assetsMtx.Lock()
		rig.dc.assets[base.ID] = convertAssetInfo(base)
		rig.dc.assets[quote.ID] = convertAssetInfo(quote)
		rig.dc.assetsMtx.Unlock()
	}

	// Just check that the information is coming through correctly.
	xcs := tCore.Exchanges()
	if len(xcs) != 1 {
		t.Fatalf("expected 1 MarketInfo, got %d", len(xcs))
	}

	rig.dc.assetsMtx.RLock()
	defer rig.dc.assetsMtx.RUnlock()

	assets := rig.dc.assets
	for _, xc := range xcs {
		for _, market := range xc.Markets {
			mkt := marketName(market.BaseID, market.QuoteID)
			_, found := marketIDs[mkt]
			if !found {
				t.Fatalf("market %s not found", mkt)
			}
			if assets[market.BaseID].Symbol != market.BaseSymbol {
				t.Fatalf("base symbol mismatch. %s != %s", assets[market.BaseID].Symbol, market.BaseSymbol)
			}
			if assets[market.QuoteID].Symbol != market.QuoteSymbol {
				t.Fatalf("quote symbol mismatch. %s != %s", assets[market.QuoteID].Symbol, market.QuoteSymbol)
			}
		}
	}
}

func TestBookFeed(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	checkAction := func(feed BookFeed, action string) {
		t.Helper()
		select {
		case u := <-feed.Next():
			if u.Action != action {
				t.Fatalf("expected action = %s, got %s", action, u.Action)
			}
		case <-time.After(time.Second):
			t.Fatalf("no %s received", action)
		}
	}

	// Ensure handleOrderBookMsg creates an order book as expected.
	oid1 := ordertest.RandomOrderID()
	bookMsg, err := msgjson.NewResponse(1, &msgjson.OrderBook{
		Seq:      1,
		MarketID: tDcrBtcMktName,
		Orders: []*msgjson.BookOrderNote{
			{
				TradeNote: msgjson.TradeNote{
					Side:     msgjson.BuyOrderNum,
					Quantity: 10,
					Rate:     2,
				},
				OrderNote: msgjson.OrderNote{
					Seq:      1,
					MarketID: tDcrBtcMktName,
					OrderID:  oid1[:],
				},
			},
		},
	}, nil)
	if err != nil {
		t.Fatalf("[NewResponse]: unexpected err: %v", err)
	}

	oid2 := ordertest.RandomOrderID()
	bookNote, _ := msgjson.NewNotification(msgjson.BookOrderRoute, &msgjson.BookOrderNote{
		TradeNote: msgjson.TradeNote{
			Side:     msgjson.BuyOrderNum,
			Quantity: 10,
			Rate:     2,
		},
		OrderNote: msgjson.OrderNote{
			Seq:      2,
			MarketID: tDcrBtcMktName,
			OrderID:  oid2[:],
		},
	})

	err = handleBookOrderMsg(tCore, dc, bookNote)
	if err == nil {
		t.Fatalf("no error for missing book")
	}

	// Sync to unknown dex
	_, _, err = tCore.SyncBook("unknown dex", tUTXOAssetA.ID, tUTXOAssetB.ID)
	if err == nil {
		t.Fatalf("no error for unknown dex")
	}
	_, _, err = tCore.SyncBook(tDexHost, tUTXOAssetA.ID, 12345)
	if err == nil {
		t.Fatalf("no error for nonsense market")
	}

	// Success
	rig.ws.queueResponse(msgjson.OrderBookRoute, func(msg *msgjson.Message, f msgFunc) error {
		f(bookMsg)
		return nil
	})
	_, feed1, err := tCore.SyncBook(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	if err != nil {
		t.Fatalf("SyncBook 1 error: %v", err)
	}
	_, feed2, err := tCore.SyncBook(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	if err != nil {
		t.Fatalf("SyncBook 2 error: %v", err)
	}

	// Should be able to retrieve the book now.
	book, err := tCore.Book(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	if err != nil {
		t.Fatalf("Core.Book error: %v", err)
	}
	// Should have one buy order
	if len(book.Buys) != 1 {
		t.Fatalf("no buy orders found. expected 1")
	}

	// Both channels should have a full orderbook.
	checkAction(feed1, FreshBookAction)
	checkAction(feed2, FreshBookAction)

	err = handleBookOrderMsg(tCore, dc, bookNote)
	if err != nil {
		t.Fatalf("[handleBookOrderMsg]: unexpected err: %v", err)
	}

	// Both channels should have an update.
	checkAction(feed1, BookOrderAction)
	checkAction(feed2, BookOrderAction)

	// Close feed 1
	feed1.Close()

	oid3 := ordertest.RandomOrderID()
	bookNote, _ = msgjson.NewNotification(msgjson.BookOrderRoute, &msgjson.BookOrderNote{
		TradeNote: msgjson.TradeNote{
			Side:     msgjson.SellOrderNum,
			Quantity: 10,
			Rate:     3,
		},
		OrderNote: msgjson.OrderNote{
			Seq:      3,
			MarketID: tDcrBtcMktName,
			OrderID:  oid3[:],
		},
	})
	err = handleBookOrderMsg(tCore, dc, bookNote)
	if err != nil {
		t.Fatalf("[handleBookOrderMsg]: unexpected err: %v", err)
	}

	// feed1 should have no update
	select {
	case <-feed1.Next():
		t.Fatalf("update for feed 1 after Close")
	default:
	}
	// feed2 should though
	checkAction(feed2, BookOrderAction)

	// Make sure the book has been updated.
	book, _ = tCore.Book(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	if len(book.Buys) != 2 {
		t.Fatalf("expected 2 buys, got %d", len(book.Buys))
	}
	if len(book.Sells) != 1 {
		t.Fatalf("expected 1 sell, got %d", len(book.Sells))
	}

	// Update the remaining quantity of the just booked order.
	var remaining uint64 = 5 * 1e8
	bookNote, _ = msgjson.NewNotification(msgjson.BookOrderRoute, &msgjson.UpdateRemainingNote{
		OrderNote: msgjson.OrderNote{
			Seq:      4,
			MarketID: tDcrBtcMktName,
			OrderID:  oid3[:],
		},
		Remaining: remaining,
	})
	err = handleUpdateRemainingMsg(tCore, dc, bookNote)
	if err != nil {
		t.Fatalf("[handleBookOrderMsg]: unexpected err: %v", err)
	}

	// feed2 should have an update
	checkAction(feed2, UpdateRemainingAction)
	book, _ = tCore.Book(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	firstSellQty := book.Sells[0].QtyAtomic
	if firstSellQty != remaining {
		t.Fatalf("expected remaining quantity of %d after update_remaining. got %d", remaining, firstSellQty)
	}

	// Ensure handleUnbookOrderMsg removes a book order from an associated
	// order book as expected.
	unbookNote, _ := msgjson.NewNotification(msgjson.UnbookOrderRoute, &msgjson.UnbookOrderNote{
		Seq:      5,
		MarketID: tDcrBtcMktName,
		OrderID:  oid1[:],
	})

	err = handleUnbookOrderMsg(tCore, dc, unbookNote)
	if err != nil {
		t.Fatalf("[handleUnbookOrderMsg]: unexpected err: %v", err)
	}
	// feed2 should have a notification.
	checkAction(feed2, UnbookOrderAction)
	book, _ = tCore.Book(tDexHost, tUTXOAssetA.ID, tUTXOAssetB.ID)
	if len(book.Buys) != 1 {
		t.Fatalf("expected 1 buy after unbook_order, got %d", len(book.Buys))
	}

	// Test candles
	queueCandles := func() {
		rig.ws.queueResponse(msgjson.CandlesRoute, func(msg *msgjson.Message, f msgFunc) error {
			resp, _ := msgjson.NewResponse(msg.ID, &msgjson.WireCandles{
				StartStamps:  []uint64{1, 2},
				EndStamps:    []uint64{3, 4},
				MatchVolumes: []uint64{1, 2},
				QuoteVolumes: []uint64{1, 2},
				HighRates:    []uint64{3, 4},
				LowRates:     []uint64{1, 2},
				StartRates:   []uint64{1, 2},
				EndRates:     []uint64{3, 4},
			}, nil)
			f(resp)
			return nil
		})
	}
	queueCandles()

	if err := feed2.Candles("1h"); err != nil {
		t.Fatalf("Candles error: %v", err)
	}

	checkAction(feed2, FreshCandlesAction)

	// An epoch report should trigger two candle updates, one for each bin size.
	epochReport, _ := msgjson.NewNotification(msgjson.EpochReportRoute, &msgjson.EpochReportNote{
		MarketID:     tDcrBtcMktName,
		Epoch:        1,
		BaseFeeRate:  2,
		QuoteFeeRate: 3,
		Candle: msgjson.Candle{
			StartStamp:  1,
			EndStamp:    2,
			MatchVolume: 3,
			QuoteVolume: 3,
			HighRate:    4,
			LowRate:     1,
			StartRate:   1,
			EndRate:     2,
		},
	})

	if err := handleEpochReportMsg(tCore, dc, epochReport); err != nil {
		t.Fatalf("handleEpochReportMsg error: %v", err)
	}

	checkAction(feed2, EpochMatchSummary)

	// We'll only receive 1 candle update, since we only synced one set of
	// candles so far.
	checkAction(feed2, CandleUpdateAction)
	checkAction(feed2, EpochResolved)

	// Now subscribe to the 24h candles too.
	queueCandles()
	if err := feed2.Candles("24h"); err != nil {
		t.Fatalf("24h Candles error: %v", err)
	}
	checkAction(feed2, FreshCandlesAction)

	// This time, an epoch report should trigger two updates.
	if err := handleEpochReportMsg(tCore, dc, epochReport); err != nil {
		t.Fatalf("handleEpochReportMsg error: %v", err)
	}
	checkAction(feed2, EpochMatchSummary)
	checkAction(feed2, CandleUpdateAction)
	checkAction(feed2, CandleUpdateAction)
}

func Test_marketTrades(t *testing.T) {
	mktID := "dcr_btc"
	dc := &dexConnection{
		trades: make(map[order.OrderID]*trackedTrade),
	}

	preImg := newPreimage()
	activeOrd := &order.LimitOrder{P: order.Prefix{
		ServerTime: time.Now(),
		Commit:     preImg.Commit(),
	}}
	activeTracker := &trackedTrade{
		Order:  activeOrd,
		preImg: preImg,
		mktID:  mktID,
		dc:     dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusBooked,
		},
		matches: make(map[order.MatchID]*matchTracker),
	}

	dc.trades[activeTracker.ID()] = activeTracker

	preImg = newPreimage() // different oid
	inactiveOrd := &order.LimitOrder{P: order.Prefix{
		ServerTime: time.Now(),
		Commit:     preImg.Commit(),
	}}
	inactiveTracker := &trackedTrade{
		Order:  inactiveOrd,
		preImg: preImg,
		mktID:  mktID,
		dc:     dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusExecuted,
		},
		matches: make(map[order.MatchID]*matchTracker), // no matches
	}

	dc.trades[inactiveTracker.ID()] = inactiveTracker

	trades, _ := dc.marketTrades(mktID)
	if len(trades) != 1 {
		t.Fatalf("Expected only one trade from marketTrades, found %v", len(trades))
	}
	if trades[0].ID() != activeOrd.ID() {
		t.Errorf("Expected active order ID %v, got %v", activeOrd.ID(), trades[0].ID())
	}
}

// TestCore_Orders_SmartFilterExecuted tests that filtering for "executed"
// orders also includes "canceled/partially filled" orders.
func TestCore_Orders_SmartFilterExecuted(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Create test orders with different statuses
	lo1, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)
	lo2, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)
	lo3, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)
	lo4, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)

	// Set order statuses
	lo1.Force = order.StandingTiF
	lo2.Force = order.StandingTiF
	lo3.Force = order.StandingTiF
	lo4.Force = order.StandingTiF

	// Create MetaOrders
	metaOrder1 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusExecuted,
		},
		Order: lo1,
	}

	metaOrder2 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo2,
	}

	metaOrder3 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo3,
	}

	metaOrder4 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusBooked,
		},
		Order: lo4,
	}

	// Set up TDB with orders
	tCore.db.(*TDB).allOrders = []*db.MetaOrder{metaOrder1, metaOrder2, metaOrder3, metaOrder4}

	// Set up orderOrders map for coreOrderFromMetaOrder
	if tCore.db.(*TDB).orderOrders == nil {
		tCore.db.(*TDB).orderOrders = make(map[order.OrderID]*db.MetaOrder)
	}
	tCore.db.(*TDB).orderOrders[lo1.ID()] = metaOrder1
	tCore.db.(*TDB).orderOrders[lo2.ID()] = metaOrder2
	tCore.db.(*TDB).orderOrders[lo3.ID()] = metaOrder3
	tCore.db.(*TDB).orderOrders[lo4.ID()] = metaOrder4

	// Set up matches - lo1 has fills (executed), lo2 has fills (canceled), lo3 has no fills
	mid1 := ordertest.RandomMatchID()
	mid2 := ordertest.RandomMatchID()
	tCore.db.(*TDB).matchesByOrderID = map[order.OrderID][]*db.MetaMatch{
		lo1.ID(): {
			{
				MetaData: &db.MatchMetaData{},
				UserMatch: &order.UserMatch{
					OrderID:  lo1.ID(),
					MatchID:  mid1,
					Quantity: 800,
					Rate:     100,
					Status:   order.MakerSwapCast,
					Side:     order.Maker,
					Address:  "some-address", // Must be non-empty to not be a cancel match
				},
			},
		},
		lo2.ID(): {
			{
				MetaData: &db.MatchMetaData{},
				UserMatch: &order.UserMatch{
					OrderID:  lo2.ID(),
					MatchID:  mid2,
					Quantity: 500,
					Rate:     100,
					Status:   order.MakerSwapCast,
					Side:     order.Maker,
					Address:  "some-address", // Must be non-empty to not be a cancel match
				},
			},
		},
		// lo3 has no matches (empty or not in map)
	}

	// Test: Filter for "executed" orders with IncludePartial to include
	// canceled orders that have partial fills
	filter := &OrderFilter{
		Statuses:       []order.OrderStatus{order.OrderStatusExecuted},
		IncludePartial: true,
	}

	results, err := tCore.Orders(filter)
	if err != nil {
		t.Fatalf("Orders error: %v", err)
	}

	// Should return 2 orders:
	// 1. Executed order (lo1)
	// 2. Canceled with fills (lo2) - partially filled
	if len(results) != 2 {
		t.Fatalf("Expected 2 orders, got %d", len(results))
	}

	// Verify the correct orders are returned
	foundExecuted := false
	foundPartiallyCanceled := false
	for _, ord := range results {
		if ord.ID.String() == lo1.ID().String() {
			foundExecuted = true
			if ord.Status != order.OrderStatusExecuted {
				t.Errorf("Expected executed status, got %v", ord.Status)
			}
		}
		if ord.ID.String() == lo2.ID().String() {
			foundPartiallyCanceled = true
			if ord.Status != order.OrderStatusCanceled {
				t.Errorf("Expected canceled status, got %v", ord.Status)
			}
		}
	}

	if !foundExecuted {
		t.Error("Did not find executed order in results")
	}
	if !foundPartiallyCanceled {
		t.Error("Did not find partially canceled order in results")
	}
}

// TestCore_Orders_CanceledFilterStillWorks tests that explicitly filtering
// for "canceled" returns ALL canceled orders (with and without fills).
func TestCore_Orders_CanceledFilterStillWorks(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Create canceled orders with and without fills
	lo1, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)
	lo2, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100)

	lo1.Force = order.StandingTiF
	lo2.Force = order.StandingTiF

	metaOrder1 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo1,
	}

	metaOrder2 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo2,
	}

	tCore.db.(*TDB).allOrders = []*db.MetaOrder{metaOrder1, metaOrder2}

	if tCore.db.(*TDB).orderOrders == nil {
		tCore.db.(*TDB).orderOrders = make(map[order.OrderID]*db.MetaOrder)
	}
	tCore.db.(*TDB).orderOrders[lo1.ID()] = metaOrder1
	tCore.db.(*TDB).orderOrders[lo2.ID()] = metaOrder2

	// Test: Filter for "canceled" orders only
	filter := &OrderFilter{
		Statuses: []order.OrderStatus{order.OrderStatusCanceled},
	}

	results, err := tCore.Orders(filter)
	if err != nil {
		t.Fatalf("Orders error: %v", err)
	}

	// Should return ALL canceled orders (both with and without fills)
	if len(results) != 2 {
		t.Fatalf("Expected 2 canceled orders, got %d", len(results))
	}

	for _, ord := range results {
		if ord.Status != order.OrderStatusCanceled {
			t.Errorf("Expected canceled status, got %v", ord.Status)
		}
	}
}

// TestCore_Orders_ExecutedAndCanceledFilter tests that when user explicitly
// selects BOTH "executed" AND "canceled" filters, ALL canceled orders are
// returned (including those with 0% filled), because the user explicitly
// selected "canceled" status.
func TestCore_Orders_ExecutedAndCanceledFilter(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Create test orders
	lo1, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100) // Executed
	lo2, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100) // Canceled with fills
	lo3, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100) // Canceled without fills
	lo4, _, _, _ := makeLimitOrder(rig.dc, true, 1000, 100) // Booked (should not be returned)

	lo1.Force = order.StandingTiF
	lo2.Force = order.StandingTiF
	lo3.Force = order.StandingTiF
	lo4.Force = order.StandingTiF

	metaOrder1 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusExecuted,
		},
		Order: lo1,
	}

	metaOrder2 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo2,
	}

	metaOrder3 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusCanceled,
		},
		Order: lo3,
	}

	metaOrder4 := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusBooked,
		},
		Order: lo4,
	}

	tCore.db.(*TDB).allOrders = []*db.MetaOrder{metaOrder1, metaOrder2, metaOrder3, metaOrder4}

	if tCore.db.(*TDB).orderOrders == nil {
		tCore.db.(*TDB).orderOrders = make(map[order.OrderID]*db.MetaOrder)
	}
	tCore.db.(*TDB).orderOrders[lo1.ID()] = metaOrder1
	tCore.db.(*TDB).orderOrders[lo2.ID()] = metaOrder2
	tCore.db.(*TDB).orderOrders[lo3.ID()] = metaOrder3
	tCore.db.(*TDB).orderOrders[lo4.ID()] = metaOrder4

	// Set up matches - lo1 has fills (executed), lo2 has fills (canceled), lo3 has no fills (canceled)
	mid1 := ordertest.RandomMatchID()
	mid2 := ordertest.RandomMatchID()
	tCore.db.(*TDB).matchesByOrderID = map[order.OrderID][]*db.MetaMatch{
		lo1.ID(): {
			{
				MetaData: &db.MatchMetaData{},
				UserMatch: &order.UserMatch{
					OrderID:  lo1.ID(),
					MatchID:  mid1,
					Quantity: 800,
					Rate:     100,
					Status:   order.MakerSwapCast,
					Side:     order.Maker,
					Address:  "some-address", // Non-empty to not be a cancel match
				},
			},
		},
		lo2.ID(): {
			{
				MetaData: &db.MatchMetaData{},
				UserMatch: &order.UserMatch{
					OrderID:  lo2.ID(),
					MatchID:  mid2,
					Quantity: 500,
					Rate:     100,
					Status:   order.MakerSwapCast,
					Side:     order.Maker,
					Address:  "some-address", // Non-empty to not be a cancel match
				},
			},
		},
		// lo3 has no matches
	}

	// Test: Filter for BOTH "executed" AND "canceled"
	filter := &OrderFilter{
		Statuses: []order.OrderStatus{order.OrderStatusExecuted, order.OrderStatusCanceled},
	}

	results, err := tCore.Orders(filter)
	if err != nil {
		t.Fatalf("Orders error: %v", err)
	}

	// Should return 3 orders:
	// 1. Executed order (lo1)
	// 2. Canceled with fills (lo2)
	// 3. Canceled without fills (lo3) - Should NOT be filtered because user explicitly selected "canceled"
	if len(results) != 3 {
		t.Fatalf("Expected 3 orders (executed + all canceled), got %d", len(results))
	}

	// Verify the correct orders are returned
	foundExecuted := false
	foundCanceledWithFills := false
	foundCanceledNoFills := false
	for _, ord := range results {
		if ord.ID.String() == lo1.ID().String() {
			foundExecuted = true
		}
		if ord.ID.String() == lo2.ID().String() {
			foundCanceledWithFills = true
		}
		if ord.ID.String() == lo3.ID().String() {
			foundCanceledNoFills = true
		}
	}

	if !foundExecuted {
		t.Error("Did not find executed order in results")
	}
	if !foundCanceledWithFills {
		t.Error("Did not find canceled order with fills in results")
	}
	if !foundCanceledNoFills {
		t.Error("Did not find canceled order without fills in results - should NOT be filtered when user explicitly selects 'canceled'")
	}
}
