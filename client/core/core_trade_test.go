//go:build !harness && !botlive

package core

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/db"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/calc"
	"decred.org/dcrdex/dex/encode"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
)

// TestValidateTradeRateNilBook verifies the nil-book guard added to
// Core.validateTradeRate in commit bcbd6d95. The Bison-specific
// immediate-match warning dereferences dc.bookie(market).BestBuy()
// / BestSell() — if the market isn't currently subscribed,
// dc.bookie returns nil, and without the guard the next call
// panics. The guard returns nil (skipping the advisory warning;
// server-side validation still runs).
func TestValidateTradeRateNilBook(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// newTestRig() leaves rig.dc.books empty, so any market name is
	// unsubscribed — dc.bookie(mkt) returns nil. Use a synthetic
	// market name so this test is independent of any future default
	// book fixtures another test might add.
	const unsubscribedMkt = "nosuchbase_nosuchquote"

	// Sell side: the nil-book branch is hit before book.BestBuy() is
	// called. Without the fix this path panics.
	if err := tCore.validateTradeRate(true, 1e8, unsubscribedMkt, rig.dc); err != nil {
		t.Fatalf("validateTradeRate(sell) returned error for unsubscribed market: %v", err)
	}

	// Buy side: same nil-book branch guards book.BestSell() too.
	// Use a different rate so the 1-time-warning state set on the sell
	// side doesn't short-circuit this call at the earlier
	// previouslyFailedTradeAttempt check.
	if err := tCore.validateTradeRate(false, 2e8, unsubscribedMkt, rig.dc); err != nil {
		t.Fatalf("validateTradeRate(buy) returned error for unsubscribed market: %v", err)
	}
}

// TestValidateTradeRateWarningFlow covers the Bison-specific 1-time-
// warning state machine around immediate-match trades
// (CL-TEST-COV-VALIDATE-TRADE-RATE-WARNING; commit bcbd6d95).
//
// validateTradeRate warns when a limit order's rate would immediately
// match an opposite-side order in the local Bison book. The state
// is keyed on (market, rate) and stored in
// Core.previouslyFailedTradeAttempt (an atomic.Pointer[tradeAttempt])
// via the rememberFailedTradeAttempt / clearFailedTradeAttempt /
// isRetryOfFailedTradeAttempt helpers. A trailing defer updates the
// state: failure stores the current (market, rate); success clears
// to nil.
//
// The expected state machine:
//
//  1. First call with an immediate-match rate → warning returned,
//     state stored.
//  2. Retry at the same (market, rate) → early short-circuit returns
//     nil, state cleared.
//  3. Re-attempt after clear → warning fires again (state was reset,
//     not permanently greenlit).
//  4. Safe rate → normal validation passes, state cleared.
//  5. State with a different market doesn't short-circuit the current
//     call; the tuple has to match both market and rate.
func TestValidateTradeRateWarningFlow(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	mktID := tDcrBtcMktName

	// Subscribe the market with a single sell-side order at bookRate.
	// Buying at any rate >= bookRate immediate-matches that sell, which
	// is the scenario the 1-time-warning guards against.
	var bookRate = dcrBtcRateStep * 1000
	book := newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)
	rig.dc.books[mktID] = book
	msgOrderNote := &msgjson.BookOrderNote{
		OrderNote: msgjson.OrderNote{OrderID: encode.RandomBytes(32)},
		TradeNote: msgjson.TradeNote{
			Side:     msgjson.SellOrderNum,
			Quantity: dcrBtcLotSize,
			Time:     uint64(time.Now().Unix()),
			Rate:     bookRate,
		},
	}
	if err := book.Sync(&msgjson.OrderBook{
		MarketID: mktID,
		Seq:      1,
		Epoch:    1,
		Orders:   []*msgjson.BookOrderNote{msgOrderNote},
	}); err != nil {
		t.Fatalf("book sync: %v", err)
	}

	// crossRate > bookRate: buying at crossRate immediate-matches the
	// sell. safeRate < bookRate: buying at safeRate does not.
	var crossRate = bookRate + dcrBtcRateStep
	var safeRate = bookRate - dcrBtcRateStep

	// Start from a known-clean state (newTestRig gives us an
	// atomic.Pointer with zero value — Load() returns nil — but
	// setting it explicitly documents intent).
	tCore.clearFailedTradeAttempt()

	// 1) First attempt at crossRate: warning returned, state stored.
	if err := tCore.validateTradeRate(false, crossRate, mktID, rig.dc); err == nil {
		t.Fatalf("expected 1-time-warning error on first attempt at crossRate=%d", crossRate)
	}
	prev := tCore.previouslyFailedTradeAttempt.Load()
	if prev == nil || prev.market != mktID || prev.rate != crossRate {
		t.Fatalf("previouslyFailedTradeAttempt = %+v, want {market:%q rate:%d}", prev, mktID, crossRate)
	}

	// 2) Retry at same (market, rate): short-circuits to nil, state
	//    cleared.
	if err := tCore.validateTradeRate(false, crossRate, mktID, rig.dc); err != nil {
		t.Fatalf("retry at same (market, rate) should succeed, got: %v", err)
	}
	if prev := tCore.previouslyFailedTradeAttempt.Load(); prev != nil {
		t.Fatalf("state not cleared after successful retry: %+v", prev)
	}

	// 3) Fresh attempt at crossRate after the state cleared: warning
	//    fires again. Confirms the retry-bypass is a one-shot, not a
	//    permanent greenlist.
	if err := tCore.validateTradeRate(false, crossRate, mktID, rig.dc); err == nil {
		t.Fatalf("expected warning to fire again after state reset")
	}

	// 4) Safe rate: normal validation passes, state cleared.
	if err := tCore.validateTradeRate(false, safeRate, mktID, rig.dc); err != nil {
		t.Fatalf("validateTradeRate(safeRate=%d) returned unexpected error: %v", safeRate, err)
	}
	if prev := tCore.previouslyFailedTradeAttempt.Load(); prev != nil {
		t.Fatalf("state not cleared after safeRate success: %+v", prev)
	}

	// 5) Retry-bypass key is (market, rate) — a stored state under a
	//    different market must not short-circuit the current call.
	tCore.rememberFailedTradeAttempt("other_mkt", crossRate)
	if err := tCore.validateTradeRate(false, crossRate, mktID, rig.dc); err == nil {
		t.Fatalf("expected warning since stored-market != current-market")
	}
}

// TestPrepareTradeRequestErrorCloser is a regression guard for the
// error-preservation fix at prepareTradeRequest's errCloser callback
// (CL-TEST-COV-ERRCLOSER-ERROR-PRESERVATION; commit bcbd6d95).
//
// prepareTradeRequest uses a named return (result, err) and an
// errCloser that runs in a defer when err != nil. The errCloser
// callback unlocks funding coins and refreshes wallet balances. If
// that callback assigned to the outer `err` (e.g. by writing `err =
// fromWallet.ReturnCoins(coins)` or `_, err = c.updateWalletBalance(...)`),
// a successful cleanup would clobber the original failure from
// createTradeRequest back to nil. prepareTradeRequest would then
// return (nil, nil), and Trade() would invoke sendTradeRequest(nil)
// -> nil-pointer panic.
//
// The fix uses a local `localErr` variable inside the callback. This
// test injects a createTradeRequest failure (via signCoinErr, which
// bubbles up through messageCoins) and asserts that Trade() returns a
// non-nil error that wraps the injected failure. If the fix is
// reverted to write to the outer `err`, this test fails (panic or
// nil-error assertion).
func TestPrepareTradeRequestErrorCloser(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	dcrWallet, tDcrWallet := newTradingTWalletDisconnected(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)
	_ = dcrWallet.Connect() // matches trade(): avoids connector.Wait panic and keeps sync goroutines alive
	defer dcrWallet.Disconnect()

	btcWallet, _ := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	var lots uint64 = 10
	qty := dcrBtcLotSize * lots
	rate := dcrBtcRateStep * 1000
	form := &TradeForm{
		Host:    tDexHost,
		IsLimit: true,
		Sell:    true,
		Base:    tUTXOAssetA.ID,
		Quote:   tUTXOAssetB.ID,
		Qty:     qty,
		Rate:    rate,
	}
	tDcrWallet.fundingCoins = asset.Coins{&tCoin{
		id:  encode.RandomBytes(36),
		val: qty * 2,
	}}
	tDcrWallet.fundRedeemScripts = []dex.Bytes{nil}

	// Pre-seed the retry-bypass state so validateTradeRate's
	// 1-time-warning branch short-circuits. This lets us skip the
	// book/Sync boilerplate that trade() uses — we only need to
	// reach createTradeRequest's messageCoins call to trigger the
	// errCloser path we're guarding.
	tCore.rememberFailedTradeAttempt(marketName(form.Base, form.Quote), form.Rate)

	// Inject failure inside createTradeRequest's messageCoins call.
	// This is what makes createTradeRequest return (nil, err) while
	// prepareTradeRequest's errCloser callback is still pending in
	// its defer — i.e., the scenario the localErr fix guards.
	tDcrWallet.signCoinErr = tErr

	_, err := tCore.Trade(tPW, form)
	if err == nil {
		t.Fatalf("Trade returned nil error; errCloser callback likely clobbered the original createTradeRequest failure")
	}
	if !errors.Is(err, tErr) {
		t.Fatalf("Trade returned error that does not wrap tErr: %v", err)
	}
}

// TestPrepareMultiTradeRequestsPerPlacementCleanup is the regression
// guard for the inner-loop shadow bug fixed in commit 43ff4594
// (CL-TEST-COV-MULTITRADE-RETURNCOINS follow-up).
//
// prepareMultiTradeRequests registers one cleanup defer per placement
// BEFORE entering the createTradeRequest loop:
//
//	for _, coins := range allCoins {
//	    errCloser := dex.NewErrorCloser()
//	    defer errCloser.DoneOnError(c.log, &err) // captures &err at function level
//	    errCloser.Add(c.returnCoinsErrCloser(fromWallet, coins))
//	    errClosers = append(errClosers, errCloser)
//	}
//
// Each defer reads the function-level `err` when it fires. If the
// subsequent inner loop uses `req, err := c.createTradeRequest(...)`
// (note the `:=`), the inner `err` SHADOWS the outer one — so on a
// placement failure the outer err stays nil (last written by the
// successful FundMultiOrder call), every defer sees nil, and none of
// the ReturnCoins callbacks fire. The funding coins for every
// placement leak (stay locked until the next wallet-balance refresh).
//
// This test drives prepareMultiTradeRequests with 3 placements,
// arranges for placement 0's createTradeRequest to succeed and
// placement 1's to fail via a SignCoinMessage "error after N calls"
// mock knob, and asserts that ReturnCoins was invoked once per
// placement (3 total) — that's the only way the post-fix behaviour
// can be observed from outside the function.
//
// Regression-guard validated empirically: re-introducing the `:=`
// shadow makes this test fail with 0 ReturnCoins calls; restoring the
// fix makes it pass with 3.
func TestPrepareMultiTradeRequestsPerPlacementCleanup(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Same wallet+rig shape as TestPrepareTradeRequestErrorCloser:
	// disconnected-then-Connect (via newTradingTWalletDisconnected) to
	// satisfy connectAndUnlock without panicking on a re-Connect.
	dcrWallet, tDcrWallet := newTradingTWalletDisconnected(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)
	_ = dcrWallet.Connect()
	defer dcrWallet.Disconnect()

	btcWallet, _ := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	var lots uint64 = 10
	qty := dcrBtcLotSize * lots

	// Three placements at distinct rates. No book is installed on
	// the rig, so validateTradeRate takes the `book == nil` short-
	// circuit for every placement — this test doesn't care about
	// rate validation.
	placements := []*QtyRate{
		{Qty: qty, Rate: dcrBtcRateStep * 1000},
		{Qty: qty, Rate: dcrBtcRateStep * 2000},
		{Qty: qty, Rate: dcrBtcRateStep * 3000},
	}
	form := &MultiTradeForm{
		Host:       tDexHost,
		Sell:       true,
		Base:       tUTXOAssetA.ID,
		Quote:      tUTXOAssetB.ID,
		Placements: placements,
	}

	// Configure FundMultiOrder to return 3 distinct coin sets — one
	// per placement. Each set has a single coin for simplicity, so
	// placement i's createTradeRequest -> messageCoins makes exactly
	// one SignCoinMessage call.
	coinSets := []asset.Coins{
		{&tCoin{id: encode.RandomBytes(36), val: qty * 2}},
		{&tCoin{id: encode.RandomBytes(36), val: qty * 2}},
		{&tCoin{id: encode.RandomBytes(36), val: qty * 2}},
	}
	tDcrWallet.multiFundCoins = coinSets
	tDcrWallet.multiFundRedeemScripts = [][]dex.Bytes{{nil}, {nil}, {nil}}

	// Fail at placement index 1 (the second createTradeRequest
	// call). signCoinErrAfterN=1 means: the first SignCoinMessage
	// call succeeds (placement 0), the second fails (placement 1)
	// — messageCoins then returns an error, createTradeRequest
	// returns (nil, err), the inner loop assigns it to the outer
	// `err` and bails. Placement 2 is never reached.
	tDcrWallet.signCoinErr = tErr
	tDcrWallet.signCoinErrAfterN = 1
	// Reset the counter in case setup (Unlock / Connect) happened
	// to bump it. None of the setup paths currently call
	// SignCoinMessage, but being explicit avoids future drift.
	tDcrWallet.signCoinCallCounter.Store(0)

	_, err := tCore.prepareMultiTradeRequests(tPW, form)
	if err == nil {
		t.Fatal("prepareMultiTradeRequests: expected error, got nil")
	}
	if !errors.Is(err, tErr) {
		t.Fatalf("prepareMultiTradeRequests: error does not wrap tErr: %v", err)
	}

	// The regression guard: on failure, every placement's funding
	// coins must have been passed to ReturnCoins. With the shadow
	// bug in place, every per-iteration defer sees a stale nil
	// outer `err` and short-circuits — no ReturnCoins call happens
	// for any placement, and this assertion fails with len=0.
	tDcrWallet.fundingMtx.Lock()
	returnedCalls := append([]asset.Coins(nil), tDcrWallet.allReturnedCoins...)
	tDcrWallet.fundingMtx.Unlock()

	if len(returnedCalls) != len(placements) {
		t.Fatalf("expected ReturnCoins called once per placement (%d); got %d calls (shadow-bug symptom: 0)",
			len(placements), len(returnedCalls))
	}

	// Order-independent check: the set of coin IDs passed to
	// ReturnCoins across all calls must exactly equal the set of
	// coin IDs returned by FundMultiOrder. Defers run LIFO, so
	// the call order is placement 2, 1, 0 — but the assertion is
	// on the multiset, not the sequence.
	expectedByID := map[string]struct{}{}
	for _, cs := range coinSets {
		for _, c := range cs {
			expectedByID[string(c.ID())] = struct{}{}
		}
	}
	for _, cs := range returnedCalls {
		for _, c := range cs {
			id := string(c.ID())
			if _, ok := expectedByID[id]; !ok {
				t.Fatalf("ReturnCoins received unexpected coin id %x", c.ID())
			}
			delete(expectedByID, id)
		}
	}
	if len(expectedByID) != 0 {
		t.Fatalf("ReturnCoins did not receive %d expected coin(s); missing IDs indicate some placement's cleanup was skipped",
			len(expectedByID))
	}
}

// TestFeeSuggestionSwapAny covers the wallet-rate-precedence logic
// introduced at Core.feeSuggestionSwapAny (CL-TEST-COV-FEE-SUGGESTION-
// SWAP-ANY; commit bcbd6d95).
//
// The priority order is:
//
//  1. If a wallet is registered for assetID AND it is connected AND
//     it exposes a non-zero FeeRateSwap → use the wallet rate.
//  2. If a wallet is registered for assetID but is NOT connected →
//     return 0 (refuse any fallback; the caller should wait for the
//     wallet to connect so its configuration, e.g. max fee rate, is
//     respected).
//  3. Otherwise (no wallet, or wallet connected but no rate yet) →
//     fall through to cached book fee rates, then to the server's
//     fee_rate RPC.
//
// Regression scenarios:
//   - Step 2 must NOT leak the DEX cache rate through when a wallet is
//     registered but disconnected — that would ignore wallet settings.
//   - Step 1 must take precedence over a cached DEX rate; otherwise
//     user-configured max-fee settings could be silently overridden.
func TestFeeSuggestionSwapAny(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	const (
		walletFeeRate = uint64(150) // chosen to be distinct from
		dexFeeRate    = uint64(250) // dexFeeRate and 0
	)

	// Subtest 1: baseline — no wallet, no cache. Returns 0 (no panic).
	t.Run("no wallet, no DEX cache", func(t *testing.T) {
		if got := tCore.feeSuggestionSwapAny(tUTXOAssetA.ID); got != 0 {
			t.Fatalf("got %d, want 0", got)
		}
	})

	// Install a DEX-side cached rate via the bookie. feeSuggestionSwapAny
	// iterates dc.books via dc.bestBookFeeSuggestion, which reads
	// ob.BaseFeeRate() / QuoteFeeRate() — both set by book.Sync().
	book := newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)
	rig.dc.books[tDcrBtcMktName] = book
	if err := book.Sync(&msgjson.OrderBook{
		MarketID:     tDcrBtcMktName,
		Seq:          1,
		Epoch:        1,
		BaseFeeRate:  dexFeeRate,
		QuoteFeeRate: dexFeeRate,
	}); err != nil {
		t.Fatalf("book sync: %v", err)
	}

	// Subtest 2: no wallet but DEX has a cached rate → use cache.
	// Exercises the step-3 fall-through path.
	t.Run("no wallet, DEX cache available", func(t *testing.T) {
		if got := tCore.feeSuggestionSwapAny(tUTXOAssetA.ID); got != dexFeeRate {
			t.Fatalf("got %d, want dexFeeRate %d (fallback to DEX cache when no wallet)", got, dexFeeRate)
		}
	})

	// Install a wallet that exposes FeeRateSwap = walletFeeRate.
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	dcrWallet.Wallet = &TFeeRater{tDcrWallet, walletFeeRate}
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet

	// Subtest 3: wallet connected + non-zero FeeRateSwap → wallet rate
	// wins over the DEX cache. This is the PRECEDENCE guarantee that
	// protects the user's wallet-side max-fee configuration.
	t.Run("wallet connected, FeeRateSwap non-zero (precedence over DEX cache)", func(t *testing.T) {
		dcrWallet.hookedUp = true
		if got := tCore.feeSuggestionSwapAny(tUTXOAssetA.ID); got != walletFeeRate {
			t.Fatalf("got %d, want walletFeeRate %d (wallet must take precedence over DEX cache %d)",
				got, walletFeeRate, dexFeeRate)
		}
	})

	// Subtest 4: wallet present but NOT connected → return 0 even
	// though the DEX has a cached rate. This is the REFUSAL guarantee
	// that keeps wallet settings (e.g., user's max fee rate) authoritative.
	t.Run("wallet present but not connected (refuse DEX cache)", func(t *testing.T) {
		dcrWallet.hookedUp = false
		if got := tCore.feeSuggestionSwapAny(tUTXOAssetA.ID); got != 0 {
			t.Fatalf("got %d, want 0 (disconnected wallet must not fall through to DEX cache %d)",
				got, dexFeeRate)
		}
	})

	// Subtest 5: wallet connected, but FeeRateSwap returns 0 (e.g., no
	// rate cached yet in the wallet). Step-3 fall-through should apply.
	t.Run("wallet connected, FeeRateSwap zero (falls through to DEX cache)", func(t *testing.T) {
		dcrWallet.hookedUp = true
		dcrWallet.Wallet = &TFeeRater{tDcrWallet, 0}
		if got := tCore.feeSuggestionSwapAny(tUTXOAssetA.ID); got != dexFeeRate {
			t.Fatalf("got %d, want dexFeeRate %d (wallet has no rate; must fall through)", got, dexFeeRate)
		}
	})
}

func TestTrade(t *testing.T) {
	trade(t, false)
}

func TestTradeAsync(t *testing.T) {
	trade(t, true)
}

func TestRefundReserves(t *testing.T) {
	const reserves = 100_000

	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	btcWallet, tBtcWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)
	tBtcWallet.redemptionAddr = "somenonemptyaddress"
	tBtcWallet.validAddr = true

	ethWallet, tEthWallet := newTAccountLocker(tACCTAsset.ID)
	tCore.wallets[tACCTAsset.ID] = ethWallet
	ethWallet.address = "18d65fb8d60c1199bb1ad381be47aa692b482605"
	ethWallet.Unlock(rig.crypter)

	lotSize := dcrBtcLotSize
	qty := lotSize * 10
	rate := dcrBtcRateStep * 100

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, qty, rate)
	lo.BaseAsset = tUTXOAssetB.ID
	lo.QuoteAsset = tACCTAsset.ID
	lo.Force = order.StandingTiF
	loid := lo.ID()

	walletSet, _, _, err := tCore.walletSet(dc, tACCTAsset.ID, tUTXOAssetA.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	dbOrder.MetaData.RefundReserves = reserves

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[loid] = tracker
	preImgC := newPreimage()
	co := &order.CancelOrder{
		P: order.Prefix{
			AccountID:  dc.acct.ID(),
			BaseAsset:  tACCTAsset.ID,
			QuoteAsset: tUTXOAssetA.ID,
			OrderType:  order.MarketOrderType,
			ClientTime: time.Now(),
			ServerTime: time.Now().Add(time.Millisecond),
			Commit:     preImgC.Commit(),
		},
	}

	msgCancelMatch := &msgjson.Match{
		OrderID:  loid[:],
		MatchID:  encode.RandomBytes(32),
		Quantity: qty / 3,
		// empty Address signals cancel order match
	}
	sign(tDexPriv, msgCancelMatch)

	matchQty := qty * 2 / 3
	matchReserves := applyFraction(2, 3, reserves)
	msgMatch := &msgjson.Match{
		OrderID:  loid[:],
		MatchID:  encode.RandomBytes(32),
		Quantity: matchQty,
		Rate:     rate,
		Address:  "somenonemptyaddress",
	}
	sign(tDexPriv, msgMatch)

	test := func(tag string, expUnlock uint64, f func()) {
		t.Helper()
		tEthWallet.refundUnlocked = 0
		tracker.mtx.Lock()
		tracker.refundLocked = reserves
		tracker.metaData.Status = order.OrderStatusEpoch
		tracker.mtx.Unlock()
		f()
		if tEthWallet.refundUnlocked != expUnlock {
			t.Fatalf("%s: expected %d to be unlocked. saw %d", tag, expUnlock, tEthWallet.refundUnlocked)
		}
	}

	test("revoke_order in epoch", reserves, func() {
		tracker.revoke()
	})

	test("revoke_order in booked, partial fill", reserves/2, func() {
		// Revoke in booked with partial fill.
		tracker.Trade().SetFill(qty / 2)
		tracker.metaData.Status = order.OrderStatusBooked
		tracker.revoke()
	})

	test("canceled, partially filled", reserves/3, func() {
		tracker.cancel = &trackedCancel{CancelOrder: *co}
		msgCancel, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch, msgCancelMatch})
		if err := handleMatchRoute(tCore, rig.dc, msgCancel); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	tracker.mtx.Lock()
	tracker.cancel = nil
	tracker.mtx.Unlock()

	// Create a new order with immediate TiF for testing
	lo, dbOrder, preImg, _ = makeLimitOrderWithTiF(dc, true, qty, rate, order.ImmediateTiF)
	lo.BaseAsset = tUTXOAssetB.ID
	lo.QuoteAsset = tACCTAsset.ID
	oldLoid := loid
	loid = lo.ID()
	dbOrder.MetaData.RefundReserves = reserves

	tracker = newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.tradeMtx.Lock()
	delete(dc.trades, oldLoid)
	dc.trades[loid] = tracker
	dc.tradeMtx.Unlock()

	msgMatch.OrderID = loid[:]
	sign(tDexPriv, msgMatch)

	test("partial immediate TiF limit order", reserves/3, func() {
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	// Create a new order with standing TiF for subsequent tests
	lo, dbOrder, preImg, _ = makeLimitOrderWithTiF(dc, true, qty, rate, order.StandingTiF)
	lo.BaseAsset = tUTXOAssetB.ID
	lo.QuoteAsset = tACCTAsset.ID
	oldLoid = loid
	loid = lo.ID()
	dbOrder.MetaData.RefundReserves = reserves

	tracker = newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.tradeMtx.Lock()
	delete(dc.trades, oldLoid)
	dc.trades[loid] = tracker
	dc.tradeMtx.Unlock()

	msgMatch.OrderID = loid[:]
	sign(tDexPriv, msgMatch)

	addMatch := func(side order.MatchSide, status order.MatchStatus, qty uint64) order.MatchID {
		t.Helper()
		msgMatch.Side = uint8(side)
		m := *msgMatch
		var mid order.MatchID
		copy(mid[:], encode.RandomBytes(32))
		m.MatchID = mid[:]
		m.Quantity = qty
		sign(tDexPriv, &m)
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{&m})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
		// Wait for any in-flight schedTradeTick goroutine to finish.
		for atomic.LoadUint32(&tracker.tickRunning) != 0 {
			time.Sleep(time.Millisecond)
		}
		tracker.mtx.Lock()
		mt, ok := tracker.matches[mid]
		if !ok {
			tracker.mtx.Unlock()
			t.Fatalf("match not found")
		}
		mt.Status = status
		if status >= order.TakerSwapCast {
			mt.counterSwap = &asset.AuditInfo{}
		}
		tracker.mtx.Unlock()
		return mid
	}

	resetMatches := func() {
		tracker.mtx.Lock()
		tracker.matches = make(map[order.MatchID]*matchTracker)
		tracker.mtx.Unlock()
	}

	test("redemption received", reserves/10, func() {
		mid := addMatch(order.Taker, order.TakerSwapCast, lotSize)
		redemption := &msgjson.Redemption{
			Redeem: msgjson.Redeem{
				OrderID: loid[:],
				MatchID: mid[:],
				CoinID:  encode.RandomBytes(36),
			},
		}
		tracker.processRedemption(1, redemption)
	})

	// Market sell order
	mo := &order.MarketOrder{
		P: lo.P,
		T: *lo.Trade(),
	}
	mo.Prefix().OrderType = order.MarketOrderType
	moid := mo.ID()
	dbOrder.Order = mo
	msgMatch.OrderID = moid[:]
	sign(tDexPriv, msgMatch)

	tracker = newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades = map[order.OrderID]*trackedTrade{moid: tracker}

	test("nomatch", reserves, func() {
		tracker.nomatch(moid)
	})

	test("partial market sell match", reserves/3, func() {
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	resetMatches()

	testRevokeMatch := func(side order.MatchSide, status order.MatchStatus, expReserves uint64) {
		t.Helper()
		resetMatches()
		matchID := addMatch(side, status, matchQty)
		desc := fmt.Sprintf("match revoke - %s in %s", side, status)
		test(desc, expReserves, func() {
			tracker.revokeMatch(matchID, true)
		})
	}

	testRevokeMatch(order.Maker, order.NewlyMatched, matchReserves)

	testRevokeMatch(order.Taker, order.NewlyMatched, matchReserves)

	testRevokeMatch(order.Taker, order.MakerSwapCast, matchReserves)

	// But Maker in MakerSwapCast shouldn't return reserves, because they will
	// need to do a refund
	testRevokeMatch(order.Maker, order.MakerSwapCast, 0)

	// Similarly Taker in TakerSwapCast shouldn't return anything, since
	// they will need to do a refund.
	testRevokeMatch(order.Taker, order.TakerSwapCast, 0)

	resetMatches()

	// Market buy order
	mo.BaseAsset, mo.QuoteAsset = mo.QuoteAsset, mo.BaseAsset
	mo.Sell = false
	tracker.wallets, _, _, _ = tCore.walletSet(dc, tUTXOAssetA.ID, tACCTAsset.ID, false)

	test("redemption received, market buy", reserves, func() {
		mid := addMatch(order.Taker, order.TakerSwapCast, lotSize)
		redemption := &msgjson.Redemption{
			Redeem: msgjson.Redeem{
				OrderID: loid[:],
				MatchID: mid[:],
				CoinID:  encode.RandomBytes(36),
			},
		}
		tracker.processRedemption(1, redemption)
	})

	resetMatches()
	mids := []order.MatchID{
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
	}

	tracker.refundLocked = reserves
	tEthWallet.refundUnlocked = 0
	for _, mid := range mids {
		// Third match should catch the market buy order dust filter.
		if err := tracker.revokeMatch(mid, true); err != nil {
			t.Fatalf("revokeMatch error: %v", err)
		}
	}
	if tracker.refundLocked != 0 {
		t.Fatalf("redemptionLocked (1/3) * 3 != 1: %d still reserved of %d", tracker.refundLocked, reserves)
	}
	if tEthWallet.refundUnlocked != reserves {
		t.Fatalf("redemptionUnlocked (1/3) * 3 != 1: %d returned of %d", tEthWallet.refundUnlocked, reserves)
	}
}

func TestRedemptionReserves(t *testing.T) {
	const reserves = 100_000

	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	ethWallet, tEthWallet := newTAccountLocker(tACCTAsset.ID)
	tCore.wallets[tACCTAsset.ID] = ethWallet
	ethWallet.address = "18d65fb8d60c1199bb1ad381be47aa692b482605"
	ethWallet.Unlock(rig.crypter)
	tEthWallet.redemptionAddr = "somenonemptyaddress"
	tEthWallet.validAddr = true

	lotSize := dcrBtcLotSize
	qty := lotSize * 10
	rate := dcrBtcRateStep * 100

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, qty, rate)
	lo.BaseAsset = tUTXOAssetB.ID
	lo.QuoteAsset = tACCTAsset.ID
	lo.Force = order.StandingTiF
	loid := lo.ID()

	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetB.ID, tACCTAsset.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	dbOrder.MetaData.RedemptionReserves = reserves

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[loid] = tracker
	preImgC := newPreimage()
	co := &order.CancelOrder{
		P: order.Prefix{
			AccountID:  dc.acct.ID(),
			BaseAsset:  tACCTAsset.ID,
			QuoteAsset: tUTXOAssetB.ID,
			OrderType:  order.MarketOrderType,
			ClientTime: time.Now(),
			ServerTime: time.Now().Add(time.Millisecond),
			Commit:     preImgC.Commit(),
		},
	}

	msgCancelMatch := &msgjson.Match{
		OrderID:  loid[:],
		MatchID:  encode.RandomBytes(32),
		Quantity: qty / 3,
		// empty Address signals cancel order match
	}
	sign(tDexPriv, msgCancelMatch)

	matchQty := qty * 2 / 3
	matchReserves := applyFraction(2, 3, reserves)
	msgMatch := &msgjson.Match{
		OrderID:  loid[:],
		MatchID:  encode.RandomBytes(32),
		Quantity: matchQty,
		Rate:     rate,
		Address:  "somenonemptyaddress",
	}
	sign(tDexPriv, msgMatch)

	test := func(tag string, expUnlock uint64, f func()) {
		t.Helper()
		tEthWallet.redemptionUnlocked = 0
		tracker.mtx.Lock()
		tracker.redemptionLocked = reserves
		tracker.metaData.Status = order.OrderStatusEpoch
		tracker.mtx.Unlock()
		f()
		if tEthWallet.redemptionUnlocked != expUnlock {
			t.Fatalf("%s: expected %d to be unlocked. saw %d", tag, expUnlock, tEthWallet.redemptionUnlocked)
		}
	}

	test("revoke_order in epoch", reserves, func() {
		tracker.revoke()
	})

	test("revoke_order in booked, partial fill", reserves/2, func() {
		// Revoke in booked with partial fill.
		tracker.Trade().SetFill(qty / 2)
		tracker.metaData.Status = order.OrderStatusBooked
		tracker.revoke()
	})

	test("canceled, partially filled", reserves/3, func() {
		tracker.cancel = &trackedCancel{CancelOrder: *co}
		msgCancel, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch, msgCancelMatch})
		if err := handleMatchRoute(tCore, rig.dc, msgCancel); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	tracker.mtx.Lock()
	tracker.cancel = nil
	tracker.mtx.Unlock()

	lo.Force = order.ImmediateTiF
	loid = lo.ID()
	msgMatch.OrderID = loid[:]
	sign(tDexPriv, msgMatch)

	test("partially filled immediate TiF limit order", reserves/3, func() {
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	mo := &order.MarketOrder{
		P: lo.P,
		T: *lo.Trade(),
	}
	mo.Prefix().OrderType = order.MarketOrderType
	moid := mo.ID()
	dbOrder.Order = mo
	msgMatch.OrderID = moid[:]
	sign(tDexPriv, msgMatch)

	tracker = newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades = map[order.OrderID]*trackedTrade{moid: tracker}

	test("nomatch", reserves, func() {
		tracker.nomatch(moid)
	})

	test("partial market sell match", reserves/3, func() {
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
	})

	addMatch := func(side order.MatchSide, status order.MatchStatus, qty uint64) order.MatchID {
		msgMatch.Side = uint8(side)
		m := *msgMatch
		var mid order.MatchID
		copy(mid[:], encode.RandomBytes(32))
		m.MatchID = mid[:]
		m.Quantity = qty
		sign(tDexPriv, &m)
		matchReq, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{&m})
		if err := handleMatchRoute(tCore, rig.dc, matchReq); err != nil {
			t.Fatalf("handleMatchRoute error: %v", err)
		}
		// Wait for any in-flight schedTradeTick goroutine to finish.
		for atomic.LoadUint32(&tracker.tickRunning) != 0 {
			time.Sleep(time.Millisecond)
		}
		tracker.mtx.Lock()
		mt, ok := tracker.matches[mid]
		if !ok {
			tracker.mtx.Unlock()
			t.Fatalf("match not found")
		}
		mt.Status = status
		tracker.mtx.Unlock()
		return mid
	}

	resetMatches := func() {
		tracker.mtx.Lock()
		tracker.matches = make(map[order.MatchID]*matchTracker)
		tracker.mtx.Unlock()
	}

	testRevokeMatch := func(side order.MatchSide, status order.MatchStatus, expReserves uint64) {
		t.Helper()
		resetMatches()
		matchID := addMatch(side, status, matchQty)
		desc := fmt.Sprintf("match revoke - %s in %s", side, status)
		test(desc, expReserves, func() {
			tracker.revokeMatch(matchID, true)
		})
	}

	testRevokeMatch(order.Maker, order.NewlyMatched, matchReserves)

	testRevokeMatch(order.Taker, order.NewlyMatched, matchReserves)

	testRevokeMatch(order.Taker, order.MakerSwapCast, matchReserves)

	// But Maker in MakerSwapCast shouldn't return reserves, since the trade
	// will proceed to redeem.
	testRevokeMatch(order.Maker, order.MakerSwapCast, 0)

	// Similarly Taker in TakerSwapCast shouldn't return anything, since we will
	// be watching for a redemption.
	testRevokeMatch(order.Taker, order.TakerSwapCast, 0)

	// Market buy order with dust handling.
	mo.BaseAsset, mo.QuoteAsset = mo.QuoteAsset, mo.BaseAsset
	mo.Sell = false
	tracker.wallets, _, _, _ = tCore.walletSet(dc, tACCTAsset.ID, tUTXOAssetB.ID, false)

	resetMatches()
	mids := []order.MatchID{
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
		addMatch(order.Maker, order.NewlyMatched, lotSize*2),
	}

	tracker.redemptionLocked = reserves
	tEthWallet.redemptionUnlocked = 0
	for _, mid := range mids {
		// Third match should catch the market buy order dust filter.
		if err := tracker.revokeMatch(mid, true); err != nil {
			t.Fatalf("revokeMatch error: %v", err)
		}
	}
	if tracker.redemptionLocked != 0 {
		t.Fatalf("redemptionLocked (1/3) * 3 != 1: %d still reserved of %d", tracker.redemptionLocked, reserves)
	}
	if tEthWallet.redemptionUnlocked != reserves {
		t.Fatalf("redemptionUnlocked (1/3) * 3 != 1: %d returned of %d", tEthWallet.redemptionUnlocked, reserves)
	}
}

func TestCancel(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, 0, 0)
	lo.Force = order.StandingTiF
	oid := lo.ID()
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, nil, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	rig.queueCancel(nil)
	err := rig.core.Cancel(oid[:])
	if err != nil {
		t.Fatalf("cancel error: %v", err)
	}
	if tracker.cancel == nil {
		t.Fatalf("cancel order not found")
	}

	ensureErr := func(tag string) {
		t.Helper()
		err := rig.core.Cancel(oid[:])
		if err == nil {
			t.Fatalf("%s: no error", tag)
		}
	}

	// Should get an error for existing cancel order.
	ensureErr("second cancel")

	// remove the cancel order so we can check its nilness on error.
	tracker.cancel = nil

	ensureNilCancel := func(tag string) {
		if tracker.cancel != nil {
			t.Fatalf("%s: cancel order found", tag)
		}
	}

	// Bad order ID
	ogID := oid
	oid = order.OrderID{0x01, 0x02}
	ensureErr("bad id")
	ensureNilCancel("bad id")
	oid = ogID

	// Order not found
	delete(dc.trades, oid)
	ensureErr("no order")
	ensureNilCancel("no order")
	dc.trades[oid] = tracker

	// Send error
	rig.ws.reqErr = tErr
	ensureErr("Request error")
	ensureNilCancel("Request error")
	rig.ws.reqErr = nil
}

func TestTradeTracking(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core
	tCore.loggedIn = true
	dcrWallet, tDcrWallet := newTradingTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)

	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	tBtcWallet.confirmTxErr = errors.New("")
	tDcrWallet.confirmTxErr = errors.New("")

	matchSize := 4 * dcrBtcLotSize
	cancelledQty := dcrBtcLotSize
	qty := 2*matchSize + cancelledQty
	rate := dcrBtcRateStep * 10
	lo, dbOrder, preImgL, addr := makeLimitOrder(dc, true, qty, dcrBtcRateStep)

	// Per-match addresses are required for swap negotiation. Use the
	// order-level address so test audit recipients match SwapAddr.
	tBtcWallet.redemptionAddr = addr
	tBtcWallet.validAddr = true
	tDcrWallet.redemptionAddr = addr
	lo.Force = order.StandingTiF
	// fundCoinDcrID := encode.RandomBytes(36)
	// lo.Coins = []order.CoinID{fundCoinDcrID}
	loid := lo.ID()

	//fundCoinDcr := &tCoin{id: fundCoinDcrID}
	//tDcrWallet.fundingCoins = asset.Coins{fundCoinDcr}

	mid := ordertest.RandomMatchID()
	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}
	mkt := dc.marketConfig(tDcrBtcMktName)
	fundCoinDcrID := encode.RandomBytes(36)
	fundingCoins := asset.Coins{&tCoin{id: fundCoinDcrID}}
	tracker := newTrackedTrade(dbOrder, preImgL, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundingCoins, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	rig.dc.trades[tracker.ID()] = tracker

	// Simulate the counterparty_address notification by injecting
	// CounterPartyAddr when new matches are stored. In production, the
	// server sends this after both sides ack. Here we inject it in the
	// DB hook so it's available before the first tick fires.
	rig.db.updateMatchHook = func(m *db.MetaMatch) {
		if m.Status == order.NewlyMatched && m.MetaData.SwapAddr != "" && m.MetaData.CounterPartyAddr == "" {
			m.MetaData.CounterPartyAddr = m.Address
		}
	}

	var match *matchTracker
	checkStatus := func(tag string, wantStatus order.MatchStatus) {
		t.Helper()
		if match.Status != wantStatus {
			t.Fatalf("%s: wrong status wanted %v, got %v", tag,
				wantStatus, match.Status)
		}
	}

	// create new notification feed to catch swap-related errors from goroutines
	notes := tCore.NotificationFeed()
	drainNotes := func() {
		for {
			select {
			case <-notes.C:
			default:
				return
			}
		}
	}

	lastSwapErrorNote := func() Notification {
		for {
			select {
			case note := <-notes.C:
				if note.Severity() == db.ErrorLevel && (note.Topic() == TopicSwapSendError ||
					note.Topic() == TopicInitError || note.Topic() == TopicReportRedeemError) {

					return note
				}
			default:
				return nil
			}
		}
	}

	type swapRelatedAction struct {
		name                 string
		fn                   func() error
		expectError          bool
		expectMatchDBUpdates int
		expectSwapErrorNote  bool
	}
	testSwapRelatedAction := func(action swapRelatedAction) {
		t.Helper()
		drainNotes() // clear previous (swap error) notes before exec'ing swap-related action
		if action.expectMatchDBUpdates > 0 {
			rig.db.updateMatchChan = make(chan order.MatchStatus, action.expectMatchDBUpdates)
		}
		// Try the action and confirm the behaviour is as expected.
		err := action.fn()
		if action.expectError && err == nil {
			t.Fatalf("%s: expected error but got nil", action.name)
		} else if !action.expectError && err != nil {
			t.Fatalf("%s: unexpected error: %v", action.name, err)
		}
		// Check that we received the expected number of match db updates.
		for i := 0; i < action.expectMatchDBUpdates; i++ {
			<-rig.db.updateMatchChan
		}
		rig.db.updateMatchChan = nil
		// Check that we received a swap error note (if expected), and that
		// no error note was received, if not expected.
		time.Sleep(100 * time.Millisecond) // wait briefly as swap error notes may be sent from a goroutine
		swapErrNote := lastSwapErrorNote()
		if action.expectSwapErrorNote && swapErrNote == nil {
			t.Fatalf("%s: expected swap error note but got nil", action.name)
		} else if !action.expectSwapErrorNote && swapErrNote != nil {
			t.Fatalf("%s: unexpected swap error note: %s", action.name, swapErrNote.Details())
		}
	}

	// MAKER MATCH
	matchTime := time.Now()
	msgMatch := &msgjson.Match{
		OrderID:    loid[:],
		MatchID:    mid[:],
		Quantity:   matchSize,
		Rate:       rate,
		Address:    "counterparty-address",
		Side:       uint8(order.Maker),
		ServerTime: uint64(matchTime.UnixMilli()),
	}
	counterSwapID := encode.RandomBytes(36)
	tDcrWallet.swapReceipts = []asset.Receipt{&tReceipt{coin: &tCoin{id: counterSwapID}}}
	sign(tDexPriv, msgMatch)

	// Note: the match-time MaxFeeRate check was removed (see makeMetaMatch in
	// trade.go). Match processing now relies on wallet-imposed fee rate limits
	// rather than rejecting matches based on FeeRateBase vs MaxFeeRate. Also,
	// handleMatchRoute dispatches negotiateMatches asynchronously via
	// dc.dispatchTradeWork, so per-match errors no longer flow back through
	// its return value. The legacy "FeeRateBase > MaxFeeRate returns error"
	// assertion has been dropped.
	sign(tDexPriv, msgMatch)
	msg, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})

	// Handle new match as maker with a queued invalid DEX init ack.
	// handleMatchRoute should have no errors but trigger a match db update (status = NewlyMatched).
	// Maker's swap should be bcasted, triggering another match db update (NewlyMatched->MakerSwapCast).
	// sendInitAsync should fail because of invalid ack and produce a swap error note.
	testSwapRelatedAction(swapRelatedAction{
		name: "handleMatchRoute",
		fn: func() error {
			// queue an invalid DEX init ack
			rig.ws.queueResponse(msgjson.InitRoute, invalidAcker)
			return handleMatchRoute(tCore, rig.dc, msg)
		},
		expectError:          false,
		expectMatchDBUpdates: 2,
		expectSwapErrorNote:  true,
	})

	var found bool
	match, found = tracker.matches[mid]
	if !found {
		t.Fatalf("match not found")
	}

	// We're the maker, so the init transaction should be broadcast.
	checkStatus("maker swapped", order.MakerSwapCast)
	proof, auth := &match.MetaData.Proof, &match.MetaData.Proof.Auth
	if len(auth.MatchSig) == 0 {
		t.Fatalf("no match sig recorded")
	}
	if !bytes.Equal(proof.MakerSwap, counterSwapID) {
		t.Fatalf("receipt ID not recorded")
	}
	if len(proof.Secret) == 0 {
		t.Fatalf("secret not set")
	}
	if len(proof.SecretHash) == 0 {
		t.Fatalf("secret hash not set")
	}
	// auth.InitSig should be unset because our init request received
	// an invalid ack
	if len(auth.InitSig) != 0 {
		t.Fatalf("init sig recorded for invalid init ack")
	}

	// requeue an invalid DEX init ack and resend pending init request
	testSwapRelatedAction(swapRelatedAction{
		name: "resend pending init (invalid ack)",
		fn: func() error {
			rig.ws.queueResponse(msgjson.InitRoute, invalidAcker)
			tCore.resendPendingRequests(tracker)
			return nil
		},
		expectError:          false,
		expectMatchDBUpdates: 0,    // no db update for invalid init ack
		expectSwapErrorNote:  true, // expect swap error note for invalid init ack
	})
	// auth.InitSig should remain unset because our resent init request
	// received an invalid ack still
	if len(auth.InitSig) != 0 {
		t.Fatalf("init sig recorded for second invalid init ack")
	}

	// queue a valid DEX init ack and re-send pending init request
	// a valid ack should produce a db update otherwise it's an error
	testSwapRelatedAction(swapRelatedAction{
		name: "resend pending init (valid ack)",
		fn: func() error {
			rig.ws.queueResponse(msgjson.InitRoute, initAcker)
			tCore.resendPendingRequests(tracker)
			return nil
		},
		expectError:          false,
		expectMatchDBUpdates: 1,     // expect db update for valid init ack
		expectSwapErrorNote:  false, // no swap error note for valid init ack
	})
	// auth.InitSig should now be set because our init request received
	// a valid ack
	if len(auth.InitSig) == 0 {
		t.Fatalf("init sig not recorded for valid init ack")
	}

	// Send the counter-party's init info.
	auditQty := calc.BaseToQuote(rate, matchSize)
	audit, auditInfo := tMsgAudit(loid, mid, addr, auditQty, proof.SecretHash)
	auditInfo.Expiration = encode.DropMilliseconds(matchTime.Add(tracker.lockTimeTaker))
	tBtcWallet.auditInfo = auditInfo
	msg, _ = msgjson.NewRequest(1, msgjson.AuditRoute, audit)

	// Check audit errors.
	tBtcWallet.auditErr = tErr
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for AuditContract error")
	}

	// Check expiration error.
	match.MetaData.Proof.SelfRevoked = true // keeps trying unless revoked
	tBtcWallet.auditErr = asset.CoinNotFoundError
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for AuditContract expiration")
	}
	var expErr ExpirationErr
	if !errors.As(err, &expErr) {
		t.Fatalf("wrong error type. expecting ExpirationTimeout, got %T: %v", err, err)
	}
	tBtcWallet.auditErr = nil
	match.MetaData.Proof.SelfRevoked = false

	auditInfo.Coin.(*tCoin).val = auditQty - 1
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for low value")
	}
	auditInfo.Coin.(*tCoin).val = auditQty

	auditInfo.SecretHash = []byte{0x01}
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for wrong secret hash")
	}
	auditInfo.SecretHash = proof.SecretHash

	auditInfo.Recipient = "wrong address"
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for wrong address")
	}
	auditInfo.Recipient = addr

	auditInfo.Expiration = matchTime.Add(tracker.lockTimeTaker - time.Hour)
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for early lock time")
	}
	auditInfo.Expiration = matchTime.Add(tracker.lockTimeTaker)

	// success, full handleAuditRoute>processAuditMsg>auditContract
	rig.db.updateMatchChan = make(chan order.MatchStatus, 4)
	err = handleAuditRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("audit error: %v", err)
	}
	// let the async auditContract run
	newMatchStatus := <-rig.db.updateMatchChan
	if newMatchStatus != order.TakerSwapCast {
		t.Fatalf("wrong match status. wanted %v, got %v", order.TakerSwapCast, newMatchStatus)
	}
	if match.counterSwap == nil {
		t.Fatalf("counter-swap not set")
	}
	if !bytes.Equal(proof.CounterContract, audit.Contract) {
		t.Fatalf("counter-script not recorded")
	}
	if !bytes.Equal(proof.TakerSwap, audit.CoinID) {
		t.Fatalf("taker contract ID not set")
	}
	<-rig.db.updateMatchChan // AuditSig is set in a second match data update
	if !bytes.Equal(auth.AuditSig, audit.Sig) {
		t.Fatalf("audit sig not set")
	}
	if auth.AuditStamp != audit.Time {
		t.Fatalf("audit time not set")
	}

	// Confirming the counter-swap triggers a redemption.
	tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetB.SwapConf, nil)
	redeemCoin := encode.RandomBytes(36)
	//<-tBtcWallet.redeemErrChan
	tBtcWallet.redeemCoins = []dex.Bytes{redeemCoin}
	rig.ws.queueResponse(msgjson.RedeemRoute, redeemAcker)
	tCore.schedTradeTick(tracker)
	for atomic.LoadUint32(&tracker.tickRunning) != 0 {
		time.Sleep(time.Millisecond)
	}
	// TakerSwapCast -> MakerRedeemed after broadcast, before redeem request
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.MakerRedeemed {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MakerRedeemed, newMatchStatus)
	}
	// MakerRedeem -> MatchComplete after redeem request
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.MatchComplete {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MatchComplete, newMatchStatus)
	}
	if !bytes.Equal(proof.MakerRedeem, redeemCoin) {
		t.Fatalf("redeem coin ID not logged")
	}
	// No redemption request received as maker. Only taker gets a redemption
	// request following maker's redeem.

	// Check that fees were incremented appropriately.
	if tracker.metaData.SwapFeesPaid != tSwapFeesPaid {
		t.Fatalf("wrong fees recorded for swap. expected %d, got %d", tSwapFeesPaid, tracker.metaData.SwapFeesPaid)
	}
	// Check that fees were incremented appropriately.
	if tracker.metaData.RedemptionFeesPaid != tRedemptionFeesPaid {
		t.Fatalf("wrong fees recorded for redemption. expected %d, got %d", tRedemptionFeesPaid, tracker.metaData.SwapFeesPaid)
	}
	rig.db.updateMatchChan = nil

	// TAKER MATCH
	//
	mid = ordertest.RandomMatchID()
	msgMatch = &msgjson.Match{
		OrderID:     loid[:],
		MatchID:     mid[:],
		Quantity:    matchSize,
		Rate:        rate,
		Address:     "counterparty-address",
		Side:        uint8(order.Taker),
		ServerTime:  uint64(matchTime.UnixMilli()),
		FeeRateBase: tMaxFeeRate,
	}
	sign(tDexPriv, msgMatch)
	msg, _ = msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
	rig.db.updateMatchChan = make(chan order.MatchStatus, 16)
	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("match messages error: %v", err)
	}
	match, found = tracker.matches[mid]
	if !found {
		t.Fatalf("match not found")
	}
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.NewlyMatched {
		t.Fatalf("wrong match status. wanted %v, got %v", order.NewlyMatched, newMatchStatus)
	}
	proof, auth = &match.MetaData.Proof, &match.MetaData.Proof.Auth
	if len(auth.MatchSig) == 0 {
		t.Fatalf("no match sig recorded")
	}
	// Secret should not be set yet.
	if len(proof.Secret) != 0 {
		t.Fatalf("secret set for taker")
	}
	if len(proof.SecretHash) != 0 {
		t.Fatalf("secret hash set for taker")
	}

	// Now send through the audit request for the maker's init.
	audit, auditInfo = tMsgAudit(loid, mid, addr, matchSize, nil)
	tBtcWallet.auditInfo = auditInfo
	// early lock time
	auditInfo.Expiration = matchTime.Add(tracker.lockTimeMaker - time.Hour)
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no taker error for early lock time")
	}

	// success, full handleAuditRoute>processAuditMsg>auditContract
	auditInfo.Expiration = encode.DropMilliseconds(matchTime.Add(tracker.lockTimeMaker))
	msg, _ = msgjson.NewRequest(1, msgjson.AuditRoute, audit)
	err = handleAuditRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("taker's match message error: %v", err)
	}
	// let the async auditContract run, updating match status
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.MakerSwapCast {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MakerSwapCast, newMatchStatus)
	}
	if len(proof.SecretHash) == 0 {
		t.Fatalf("secret hash not set for taker")
	}
	if !bytes.Equal(proof.MakerSwap, audit.CoinID) {
		t.Fatalf("maker redeem coin not set")
	}
	<-rig.db.updateMatchChan // AuditSig is set in a second match data update
	if !bytes.Equal(auth.AuditSig, audit.Sig) {
		t.Fatalf("audit sig not set for taker")
	}
	if auth.AuditStamp != audit.Time {
		t.Fatalf("audit time not set for taker")
	}
	// The swap should not be sent, since the auditInfo coin doesn't have the
	// requisite confirmations.
	if len(proof.TakerSwap) != 0 {
		t.Fatalf("swap broadcast before confirmations")
	}
	// confirming maker's swap should trigger taker's swap bcast.
	// Set receipts and queue the response before setting confs, since
	// the afterAudit tick goroutine may read swapReceipts as soon as
	// confirmations are met. The confsMtx in setConfs/tConfirmations
	// provides the happens-before ordering.
	swapID := encode.RandomBytes(36)
	tDcrWallet.swapReceipts = []asset.Receipt{&tReceipt{coin: &tCoin{id: swapID}}}
	rig.ws.queueResponse(msgjson.InitRoute, initAcker)
	tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetB.SwapConf, nil)
	tCore.schedTradeTick(tracker)
	for atomic.LoadUint32(&tracker.tickRunning) != 0 {
		time.Sleep(time.Millisecond)
	}
	newMatchStatus = <-rig.db.updateMatchChan // MakerSwapCast->TakerSwapCast (after taker's swap bcast)
	if newMatchStatus != order.TakerSwapCast {
		t.Fatalf("wrong match status. wanted %v, got %v", order.TakerSwapCast, newMatchStatus)
	}
	if len(proof.TakerSwap) == 0 {
		t.Fatalf("swap not broadcast with confirmations")
	}
	<-rig.db.updateMatchChan // init ack sig is set in a second match data update
	if len(auth.InitSig) == 0 {
		t.Fatalf("init ack sig not set for taker")
	}

	// Receive the maker's redemption.
	redemptionCoin := encode.RandomBytes(36)
	redemption := &msgjson.Redemption{
		Redeem: msgjson.Redeem{
			OrderID: loid[:],
			MatchID: mid[:],
			CoinID:  redemptionCoin,
		},
	}
	sign(tDexPriv, redemption)
	redeemCoin = encode.RandomBytes(36)
	tBtcWallet.redeemCoins = []dex.Bytes{redeemCoin}
	msg, _ = msgjson.NewRequest(1, msgjson.RedemptionRoute, redemption)

	tBtcWallet.badSecret = true
	err = handleRedemptionRoute(tCore, rig.dc, msg)
	if err == nil {
		t.Fatalf("no error for wrong secret")
	}
	newMatchStatus = <-rig.db.updateMatchChan  // wrong secret still updates match
	if newMatchStatus != order.TakerSwapCast { // but status is same
		t.Fatalf("wrong match status. wanted %v, got %v", order.TakerSwapCast, newMatchStatus)
	}
	tBtcWallet.badSecret = false

	tBtcWallet.redeemErrChan = make(chan error, 1)
	rig.ws.queueResponse(msgjson.RedeemRoute, redeemAcker)
	err = handleRedemptionRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("redemption message error: %v", err)
	}
	err = <-tBtcWallet.redeemErrChan
	if err != nil {
		t.Fatalf("should have worked, got: %v", err)
	}
	// For taker, there's one status update to MakerRedeemed prior to bcasting taker's redemption
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.MakerRedeemed {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MakerRedeemed, newMatchStatus)
	}
	// and another status update to MatchComplete when taker's redemption is bcast
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus != order.MatchComplete {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MatchComplete, newMatchStatus)
	}
	if !bytes.Equal(proof.MakerRedeem, redemptionCoin) {
		t.Fatalf("redemption coin ID not logged")
	}
	if len(proof.TakerRedeem) == 0 {
		t.Fatalf("taker redemption not sent")
	}
	// Then a match update to set the redeem ack sig when the 'redeem' request back
	// to the server succeeds.
	<-rig.db.updateMatchChan
	if len(auth.RedeemSig) == 0 {
		t.Fatalf("redeem ack sig not set for taker")
	}
	rig.db.updateMatchChan = nil
	tBtcWallet.redeemErrChan = nil

	// CANCEL ORDER MATCH
	//
	tDcrWallet.returnedCoins = nil
	copy(mid[:], encode.RandomBytes(32))
	preImgC := newPreimage()
	co := &order.CancelOrder{
		P: order.Prefix{
			AccountID:  dc.acct.ID(),
			BaseAsset:  tUTXOAssetA.ID,
			QuoteAsset: tUTXOAssetB.ID,
			OrderType:  order.MarketOrderType,
			ClientTime: time.Now(),
			ServerTime: time.Now().Add(time.Millisecond),
			Commit:     preImgC.Commit(),
		},
	}
	tracker.cancel = &trackedCancel{CancelOrder: *co, epochLen: mkt.EpochLen}
	coid := co.ID()
	rig.dc.registerCancelLink(coid, tracker.ID())
	m1 := &msgjson.Match{
		OrderID:  loid[:],
		MatchID:  mid[:],
		Quantity: cancelledQty,
		Rate:     rate,
		Address:  "",
	}
	m2 := &msgjson.Match{
		OrderID:  coid[:],
		MatchID:  mid[:],
		Quantity: cancelledQty,
		Address:  "testaddr",
	}
	sign(tDexPriv, m1)
	sign(tDexPriv, m2)
	msg, _ = msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{m1, m2})
	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("handleMatchRoute error (cancel with swaps): %v", err)
	}
	if tracker.cancel.matches.maker == nil {
		t.Fatalf("cancelMatches.maker not set")
	}
	if tracker.Trade().Filled() != qty {
		t.Fatalf("fill not set. %d != %d", tracker.Trade().Filled(), qty)
	}
	if tracker.cancel.matches.taker == nil {
		t.Fatalf("cancelMatches.taker not set")
	}
	// Since there are no unswapped orders, the change coin should be returned.
	if len(tDcrWallet.returnedCoins) != 1 || !bytes.Equal(tDcrWallet.returnedCoins[0].ID(), tDcrWallet.changeCoin.id) {
		t.Fatalf("change coin not returned")
	}

	resetMatches := func() {
		tracker.mtx.Lock()
		tracker.matches = make(map[order.MatchID]*matchTracker)
		tracker.change = nil
		tracker.metaData.ChangeCoin = nil
		tracker.coinsLocked = true
		tracker.mtx.Unlock()
	}

	// If there is no change coin and no matches, the funding coin should be
	// returned instead.
	resetMatches()
	// The change coins would also have been added to the coins map, so delete
	// that too.
	delete(tracker.coins, tDcrWallet.changeCoin.String())
	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("handleMatchRoute error (cancel without swaps): %v", err)
	}
	if len(tDcrWallet.returnedCoins) != 1 || !bytes.Equal(tDcrWallet.returnedCoins[0].ID(), fundCoinDcrID) {
		t.Fatalf("change coin not returned (cancel without swaps)")
	}

	// If the order is an immediate order, the asset.Swaps.LockChange should be
	// false regardless of whether the order is filled.
	// Create a new order with ImmediateTiF for this test.
	tDcrWallet.lastSwapsMtx.Lock()
	tDcrWallet.lastSwaps = make([]*asset.Swaps, 0) // Clear previous swaps
	tDcrWallet.lastSwapsMtx.Unlock()
	rig.ws.queueResponse(msgjson.InitRoute, initAcker)

	loImm, dbOrderImm, preImgImm, _ := makeLimitOrder(dc, true, qty, dcrBtcRateStep) // ImmediateTiF by default
	newLoid := loImm.ID()
	fundingCoinsImm := asset.Coins{&tCoin{id: encode.RandomBytes(36)}}
	trackerImm := newTrackedTrade(dbOrderImm, preImgImm, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundingCoinsImm, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	trackerImm.coins = map[string]asset.Coin{
		hex.EncodeToString(fundingCoinsImm[0].ID()): fundingCoinsImm[0],
	}
	trackerImm.coinsLocked = true
	trackerImm.metaData.Status = order.OrderStatusEpoch
	rig.dc.tradeMtx.Lock()
	delete(rig.dc.trades, loid)
	rig.dc.trades[newLoid] = trackerImm
	rig.dc.tradeMtx.Unlock()

	msgMatch.OrderID = newLoid[:]
	msgMatch.Side = uint8(order.Maker)
	sign(tDexPriv, msgMatch)
	msg, _ = msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})

	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("handleMatchRoute error (immediate partial fill): %v", err)
	}
	// Wait for async tick to broadcast the swap
	var lastSwaps *asset.Swaps
	for i := 0; i < 100; i++ {
		tDcrWallet.lastSwapsMtx.Lock()
		if len(tDcrWallet.lastSwaps) > 0 {
			lastSwaps = tDcrWallet.lastSwaps[len(tDcrWallet.lastSwaps)-1]
		}
		tDcrWallet.lastSwapsMtx.Unlock()
		if lastSwaps != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if lastSwaps == nil {
		t.Fatalf("swap not broadcast for immediate partial fill")
	}
	if lastSwaps.LockChange != false {
		t.Fatalf("change locked for executed non-standing order (immediate partial fill)")
	}
}

func TestReconcileTrades(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc

	mkt := dc.marketConfig(tDcrBtcMktName)
	rig.core.wallets[mkt.Base], _ = newTWallet(mkt.Base)
	rig.core.wallets[mkt.Quote], _ = newTWallet(mkt.Quote)
	walletSet, _, _, err := rig.core.walletSet(dc, mkt.Base, mkt.Quote, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	type orderSet struct {
		epoch               *trackedTrade
		booked              *trackedTrade // standing limit orders only
		bookedPendingCancel *trackedTrade // standing limit orders only
		executed            *trackedTrade
	}
	makeOrderSet := func(force order.TimeInForce) *orderSet {
		orders := &orderSet{
			epoch:    makeTradeTracker(rig, walletSet, force, order.OrderStatusEpoch),
			executed: makeTradeTracker(rig, walletSet, force, order.OrderStatusExecuted),
		}
		if force == order.StandingTiF {
			orders.booked = makeTradeTracker(rig, walletSet, force, order.OrderStatusBooked)
			orders.bookedPendingCancel = makeTradeTracker(rig, walletSet, force, order.OrderStatusBooked)
			orders.bookedPendingCancel.cancel = &trackedCancel{
				CancelOrder: order.CancelOrder{
					P: order.Prefix{
						ServerTime: time.Now().UTC().Add(-16 * time.Minute),
					},
				},
				epochLen: mkt.EpochLen,
			}
		}
		return orders
	}

	standingOrders := makeOrderSet(order.StandingTiF)
	immediateOrders := makeOrderSet(order.ImmediateTiF)

	tests := []struct {
		name                string
		clientOrders        []*trackedTrade        // orders known to the client
		serverOrders        []*msgjson.OrderStatus // orders considered active by the server
		orderStatusRes      []*msgjson.OrderStatus // server's response to order_status requests
		expectOrderStatuses map[order.OrderID]order.OrderStatus
	}{
		{
			name:         "server orders unknown to client",
			clientOrders: []*trackedTrade{},
			serverOrders: []*msgjson.OrderStatus{
				{
					ID:     ordertest.RandomOrderID().Bytes(),
					Status: uint16(order.OrderStatusBooked),
				},
			},
			expectOrderStatuses: map[order.OrderID]order.OrderStatus{},
		},
		{
			name: "different server-client statuses",
			clientOrders: []*trackedTrade{
				standingOrders.epoch,
				standingOrders.booked,
				standingOrders.bookedPendingCancel,
				immediateOrders.epoch,
				immediateOrders.executed,
			},
			serverOrders: []*msgjson.OrderStatus{
				{
					ID:     standingOrders.epoch.ID().Bytes(),
					Status: uint16(order.OrderStatusBooked), // now booked
				},
				{
					ID:     standingOrders.booked.ID().Bytes(),
					Status: uint16(order.OrderStatusEpoch), // invald! booked orders cannot return to epoch!
				},
				{
					ID:     standingOrders.bookedPendingCancel.ID().Bytes(),
					Status: uint16(order.OrderStatusBooked), // still booked, cancel order should be deleted
				},
				{
					ID:     immediateOrders.epoch.ID().Bytes(),
					Status: uint16(order.OrderStatusBooked), // invalid, immediate orders cannot be booked!
				},
				{
					ID:     immediateOrders.executed.ID().Bytes(),
					Status: uint16(order.OrderStatusBooked), // invalid, inactive orders should not be returned by DEX!
				},
			},
			expectOrderStatuses: map[order.OrderID]order.OrderStatus{
				standingOrders.epoch.ID():               order.OrderStatusBooked,   // epoch => booked
				standingOrders.booked.ID():              order.OrderStatusBooked,   // should not change, cannot return to epoch
				standingOrders.bookedPendingCancel.ID(): order.OrderStatusBooked,   // no status change
				immediateOrders.epoch.ID():              order.OrderStatusEpoch,    // should not change, cannot be booked
				immediateOrders.executed.ID():           order.OrderStatusExecuted, // should not change, inactive cannot become active
			},
		},
		{
			name: "active becomes inactive",
			clientOrders: []*trackedTrade{
				standingOrders.epoch,
				standingOrders.booked,
				standingOrders.bookedPendingCancel,
				standingOrders.executed,
				immediateOrders.epoch,
				immediateOrders.executed,
			},
			serverOrders: []*msgjson.OrderStatus{}, // no active order reported by server
			orderStatusRes: []*msgjson.OrderStatus{
				{
					ID:     standingOrders.epoch.ID().Bytes(),
					Status: uint16(order.OrderStatusRevoked),
				},
				{
					ID:     standingOrders.booked.ID().Bytes(),
					Status: uint16(order.OrderStatusRevoked),
				},
				{
					ID:     standingOrders.bookedPendingCancel.ID().Bytes(),
					Status: uint16(order.OrderStatusCanceled),
				},
				{
					ID:     immediateOrders.epoch.ID().Bytes(),
					Status: uint16(order.OrderStatusExecuted),
				},
			},
			expectOrderStatuses: map[order.OrderID]order.OrderStatus{
				standingOrders.epoch.ID():               order.OrderStatusRevoked,  // preimage missed = revoked
				standingOrders.booked.ID():              order.OrderStatusRevoked,  // booked, not canceled = assume revoked (may actually be executed)
				standingOrders.bookedPendingCancel.ID(): order.OrderStatusCanceled, // booked pending canceled = assume canceled (may actually be revoked or executed)
				standingOrders.executed.ID():            order.OrderStatusExecuted, // should not change
				immediateOrders.epoch.ID():              order.OrderStatusExecuted, // preimage sent, not canceled = executed
				immediateOrders.executed.ID():           order.OrderStatusExecuted, // should not change
			},
		},
	}

	for _, tt := range tests {
		// Track client orders in dc.trades.
		dc.tradeMtx.Lock()
		var pendingCancel *trackedTrade
		dc.trades = make(map[order.OrderID]*trackedTrade)
		for _, tracker := range tt.clientOrders {
			dc.trades[tracker.ID()] = tracker
			if tracker.cancel != nil {
				pendingCancel = tracker
			}
		}
		dc.tradeMtx.Unlock()

		// Queue order_status response if required for reconciliation.
		if len(tt.orderStatusRes) > 0 {
			rig.ws.queueResponse(msgjson.OrderStatusRoute, func(msg *msgjson.Message, f msgFunc) error {
				resp, _ := msgjson.NewResponse(msg.ID, tt.orderStatusRes, nil)
				f(resp)
				return nil
			})
		}

		// Reconcile tracked orders with server orders.
		dc.reconcileTrades(tt.serverOrders)

		dc.tradeMtx.RLock()
		if len(dc.trades) != len(tt.expectOrderStatuses) {
			t.Fatalf("%s: post-reconcileTrades order count mismatch. expected %d, got %d",
				tt.name, len(tt.expectOrderStatuses), len(dc.trades))
		}
		for oid, tracker := range dc.trades {
			expectedStatus, expected := tt.expectOrderStatuses[oid]
			if !expected {
				t.Fatalf("%s: unexpected order %v tracked by client", tt.name, oid)
			}
			tracker.mtx.RLock()
			if tracker.metaData.Status != expectedStatus {
				t.Fatalf("%s: client reported wrong order status %v, expected %v",
					tt.name, tracker.metaData.Status, expectedStatus)
			}
			tracker.mtx.RUnlock()
		}
		dc.tradeMtx.RUnlock()

		// Check if a previously canceled order existed; if the order is still
		// active (Epoch/Booked status) and the cancel order is deleted, having
		// been there for over 15 minutes since the cancel order's epoch ended.
		if pendingCancel != nil {
			pendingCancel.mtx.RLock()
			status, stillHasCancelOrder := pendingCancel.metaData.Status, pendingCancel.cancel != nil
			pendingCancel.mtx.RUnlock()
			if status == order.OrderStatusBooked {
				if stillHasCancelOrder {
					t.Fatalf("%s: expected stale cancel order to be deleted for now-booked order", tt.name)
				}
				// Cancel order deleted. Canceling the order again should succeed.
				rig.queueCancel(nil)
				err = rig.core.Cancel(pendingCancel.ID().Bytes())
				if err != nil {
					t.Fatalf("cancel order error after deleting previous stale cancel: %v", err)
				}
			}
		}
	}
}

func TestRefunds(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	dc := rig.dc
	tCore := rig.core
	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	btcWallet.Unlock(rig.crypter)

	ethWallet, tEthWallet := newTAccountLocker(tACCTAsset.ID)
	tCore.wallets[tACCTAsset.ID] = ethWallet
	ethWallet.address = "18d65fb8d60c1199bb1ad381be47aa692b482605"
	ethWallet.Unlock(rig.crypter)
	tEthWallet.confirmTxResult = new(asset.ConfirmTxStatus)
	// Account-based wallet also needs to provide a local fee rate.
	tEthWallet.feeRate = tradeTestFeeRate

	checkStatus := func(tag string, match *matchTracker, wantStatus order.MatchStatus) {
		t.Helper()
		if match.Status != wantStatus {
			t.Fatalf("%s: wrong status wanted %v, got %v", tag, wantStatus, match.Status)
		}
	}
	checkRefund := func(tracker *trackedTrade, match *matchTracker, expectAmt uint64) {
		t.Helper()
		// Hold t.mtx for the duration since refundMatches and isRefundable
		// expect the caller to hold it (as tick() does), and background
		// goroutines (checkEpochResolution) read match state under RLock.
		tracker.mtx.Lock()
		defer tracker.mtx.Unlock()
		// Confirm that the status is SwapCast.
		if match.Side == order.Maker {
			if match.Status != order.MakerSwapCast {
				t.Fatalf("maker swapped: wrong status wanted %v, got %v", order.MakerSwapCast, match.Status)
			}
		} else {
			if match.Status != order.TakerSwapCast {
				t.Fatalf("taker swapped: wrong status wanted %v, got %v", order.TakerSwapCast, match.Status)
			}
		}
		// Confirm isRefundable = true.
		if !tracker.isRefundable(tCore.ctx, match) {
			t.Fatalf("%s's swap not refundable", match.Side)
		}
		// Check refund.
		amtRefunded, err := rig.core.refundMatches(tracker, []*matchTracker{match})
		if err != nil {
			t.Fatalf("unexpected refund error %v", err)
		}
		// Check refunded amount.
		if amtRefunded != expectAmt {
			t.Fatalf("expected %d refund amount, got %d", expectAmt, amtRefunded)
		}
		// Confirm isRefundable = false.
		if tracker.isRefundable(tCore.ctx, match) {
			t.Fatalf("%s's swap refundable after being refunded", match.Side)
		}
		// Expect refund re-attempt to not refund any coin.
		amtRefunded, err = rig.core.refundMatches(tracker, []*matchTracker{match})
		if err != nil {
			t.Fatalf("unexpected refund error %v", err)
		}
		if amtRefunded != 0 {
			t.Fatalf("expected 0 refund amount, got %d", amtRefunded)
		}
		// Confirm that the status is unchanged.
		if match.Side == order.Maker {
			if match.Status != order.MakerSwapCast {
				t.Fatalf("maker swapped: wrong status wanted %v, got %v", order.MakerSwapCast, match.Status)
			}
		} else {
			if match.Status != order.TakerSwapCast {
				t.Fatalf("taker swapped: wrong status wanted %v, got %v", order.TakerSwapCast, match.Status)
			}
		}

		if _, is := tracker.accountRefunder(); is {
			if tEthWallet.refundFeeSuggestion != tMaxFeeRate {
				t.Fatalf("refund suggestion for account asset %v != tMaxFeeRate %v",
					tEthWallet.refundFeeSuggestion, tMaxFeeRate)
			}
		}
	}

	matchSize := 4 * dcrBtcLotSize
	qty := 3 * matchSize
	rate := dcrBtcRateStep * 10
	lo, dbOrder, preImgL, addr := makeLimitOrder(dc, false, qty, dcrBtcRateStep)
	loid := lo.ID()
	mid := ordertest.RandomMatchID()
	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetB.ID, tACCTAsset.ID, false)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}
	fundCoinsETH := asset.Coins{&tCoin{id: encode.RandomBytes(36)}}
	tEthWallet.fundingCoins = fundCoinsETH
	tEthWallet.fundRedeemScripts = []dex.Bytes{nil}
	tracker := newTrackedTrade(dbOrder, preImgL, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundCoinsETH, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	rig.dc.trades[tracker.ID()] = tracker

	// Per-match addresses are required for swap negotiation.
	tBtcWallet.redemptionAddr = addr
	tBtcWallet.validAddr = true
	rig.db.updateMatchHook = func(m *db.MetaMatch) {
		if m.Status == order.NewlyMatched && m.MetaData.SwapAddr != "" && m.MetaData.CounterPartyAddr == "" {
			m.MetaData.CounterPartyAddr = m.Address
		}
	}

	// MAKER REFUND, INVALID TAKER COUNTERSWAP
	//

	matchTime := time.Now().Truncate(time.Millisecond).UTC()
	msgMatch := &msgjson.Match{
		OrderID:      loid[:],
		MatchID:      mid[:],
		Quantity:     matchSize,
		Rate:         rate,
		Address:      "counterparty-address",
		Side:         uint8(order.Maker),
		ServerTime:   uint64(matchTime.UnixMilli()),
		FeeRateQuote: tMaxFeeRate,
	}
	swapID := encode.RandomBytes(36)
	contract := encode.RandomBytes(36)
	tEthWallet.swapReceipts = []asset.Receipt{&tReceipt{coin: &tCoin{id: swapID}, contract: contract}}
	sign(tDexPriv, msgMatch)
	msg, _ := msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
	rig.ws.queueResponse(msgjson.InitRoute, initAcker)
	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("match messages error: %v", err)
	}
	tracker.mtx.RLock()
	match, found := tracker.matches[mid]
	tracker.mtx.RUnlock()
	if !found {
		t.Fatalf("match not found")
	}

	// We're the maker, so the init transaction should be broadcast.
	// Wait for async tick to broadcast the swap.
	for i := 0; i < 100; i++ {
		tracker.mtx.RLock()
		status := match.Status
		tracker.mtx.RUnlock()
		if status == order.MakerSwapCast {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	checkStatus("maker swapped", match, order.MakerSwapCast)
	tracker.mtx.RLock()
	proof := &match.MetaData.Proof
	if !bytes.Equal(proof.ContractData, contract) {
		tracker.mtx.RUnlock()
		t.Fatalf("invalid contract recorded for Maker swap")
	}
	secretHash := proof.SecretHash
	tracker.mtx.RUnlock()

	// Send the counter-party's init info.
	audit, auditInfo := tMsgAudit(loid, mid, addr, matchSize, secretHash)
	tBtcWallet.auditInfo = auditInfo
	auditInfo.Expiration = encode.DropMilliseconds(matchTime.Add(tracker.lockTimeMaker).UTC())

	// Check audit errors.
	tBtcWallet.auditErr = tErr
	err = tracker.auditContract(match, audit.CoinID, audit.Contract, nil)
	if err == nil {
		t.Fatalf("no maker error for AuditContract error")
	}

	// Attempt refund.
	tEthWallet.refundCoin = encode.RandomBytes(36)
	tEthWallet.refundErr = nil
	tBtcWallet.refundCoin = nil
	tBtcWallet.refundErr = fmt.Errorf("unexpected call to btcWallet.Refund")
	matchSizeQuoteUnits := calc.BaseToQuote(rate, matchSize)
	// Make the contract appear expired
	tEthWallet.contractExpired = true
	tEthWallet.contractLockTime = time.Now()
	checkRefund(tracker, match, matchSizeQuoteUnits)
	tEthWallet.contractExpired = false
	tEthWallet.contractLockTime = time.Now().Add(time.Minute)

	// TAKER REFUND, NO MAKER REDEEM
	//
	// Reset funding coins in the trackedTrade, wipe change coin.
	matchTime = time.Now().Truncate(time.Millisecond).UTC()
	tracker.mtx.Lock()
	tracker.coins = mapifyCoins(fundCoinsETH)
	tracker.coinsLocked = true
	tracker.changeLocked = false
	tracker.change = nil
	tracker.metaData.ChangeCoin = nil
	tracker.mtx.Unlock()
	mid = ordertest.RandomMatchID()
	msgMatch = &msgjson.Match{
		OrderID:      loid[:],
		MatchID:      mid[:],
		Quantity:     matchSize,
		Rate:         rate,
		Address:      "counterparty-address",
		Side:         uint8(order.Taker),
		ServerTime:   uint64(matchTime.UnixMilli()),
		FeeRateQuote: tMaxFeeRate,
	}
	sign(tDexPriv, msgMatch)
	msg, _ = msgjson.NewRequest(1, msgjson.MatchRoute, []*msgjson.Match{msgMatch})
	err = handleMatchRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("match messages error: %v", err)
	}
	tracker.mtx.RLock()
	match, found = tracker.matches[mid]
	tracker.mtx.RUnlock()
	if !found {
		t.Fatalf("match not found")
	}
	checkStatus("taker matched", match, order.NewlyMatched)
	// Wait for any in-flight schedTradeTick goroutine to finish before
	// setting up the channel, to avoid racing on rig.db.updateMatchChan.
	for atomic.LoadUint32(&tracker.tickRunning) != 0 {
		time.Sleep(time.Millisecond)
	}
	// Send through the audit request for the maker's init.
	rig.db.updateMatchChan = make(chan order.MatchStatus, 16)
	audit, auditInfo = tMsgAudit(loid, mid, addr, matchSize, nil)
	tBtcWallet.auditInfo = auditInfo
	auditInfo.Expiration = encode.DropMilliseconds(matchTime.Add(tracker.lockTimeMaker))
	tBtcWallet.auditErr = nil
	msg, _ = msgjson.NewRequest(1, msgjson.AuditRoute, audit)
	err = handleAuditRoute(tCore, rig.dc, msg)
	if err != nil {
		t.Fatalf("taker's match message error: %v", err)
	}
	// let the async auditContract run, updating match status
	newMatchStatus := <-rig.db.updateMatchChan
	if newMatchStatus != order.MakerSwapCast {
		t.Fatalf("wrong match status. wanted %v, got %v", order.MakerSwapCast, newMatchStatus)
	}
	<-rig.db.updateMatchChan // AuditSig set in second update to match data
	tracker.mtx.RLock()
	if !bytes.Equal(match.MetaData.Proof.Auth.AuditSig, audit.Sig) {
		t.Fatalf("audit sig not set for taker")
	}
	tracker.mtx.RUnlock()
	// maker's swap confirmation should trigger taker's swap bcast.
	// Set receipts and queue the response before setting confs to avoid
	// racing with the afterAudit tick goroutine.
	counterSwapID := encode.RandomBytes(36)
	counterScript := encode.RandomBytes(36)
	tEthWallet.swapReceipts = []asset.Receipt{&tReceipt{coin: &tCoin{id: counterSwapID}, contract: counterScript}}
	rig.ws.queueResponse(msgjson.InitRoute, initAcker)
	tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetB.SwapConf, nil)
	tCore.schedTradeTick(tracker)
	for atomic.LoadUint32(&tracker.tickRunning) != 0 {
		time.Sleep(time.Millisecond)
	}
	newMatchStatus = <-rig.db.updateMatchChan // MakerSwapCast->TakerSwapCast (after taker's swap bcast)
	if newMatchStatus != order.TakerSwapCast {
		t.Fatalf("wrong match status. wanted %v, got %v", order.TakerSwapCast, newMatchStatus)
	}
	tracker.mtx.RLock()
	if !bytes.Equal(match.MetaData.Proof.ContractData, counterScript) {
		t.Fatalf("invalid contract recorded for Taker swap")
	}
	tracker.mtx.RUnlock()
	// still takerswapcast, but with initsig (or status may have advanced due to async ticks)
	newMatchStatus = <-rig.db.updateMatchChan
	if newMatchStatus < order.TakerSwapCast {
		t.Fatalf("wrong match status wanted >= %v, got %v", order.TakerSwapCast, newMatchStatus)
	}
	// Wait for init sig to be set (may take time due to async processing)
	var authHasInitSig bool
	for i := 0; i < 100; i++ {
		tracker.mtx.RLock()
		auth := &match.MetaData.Proof.Auth
		authHasInitSig = len(auth.InitSig) > 0
		tracker.mtx.RUnlock()
		if authHasInitSig {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !authHasInitSig {
		t.Fatalf("init sig not recorded for valid init ack")
	}

	// Attempt refund.
	rig.db.updateMatchChan = nil
	tEthWallet.contractExpired = true
	tEthWallet.contractLockTime = time.Now()
	checkRefund(tracker, match, matchSizeQuoteUnits)
	tEthWallet.contractExpired = false
	tEthWallet.contractLockTime = time.Now().Add(time.Minute)
}

func TestReReserveFunding(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	auth(rig.acct) // Short path through initializeDEXConnections

	utxoAsset /* base */, acctAsset /* quote */ := tUTXOAssetB, tACCTAsset

	btcWallet, tBtcWallet := newTWallet(utxoAsset.ID)
	tCore.wallets[utxoAsset.ID] = btcWallet

	ethWallet, tEthWallet := newTAccountLocker(acctAsset.ID)
	tCore.wallets[acctAsset.ID] = ethWallet

	// Create an order
	qty, lo, dbOrder, match, changeCoin := generateMatch(rig, utxoAsset.ID, acctAsset.ID)
	redemptionReserves, refundReserves := dbOrder.MetaData.RedemptionReserves, dbOrder.MetaData.RefundReserves

	tBtcWallet.fundingCoins = asset.Coins{changeCoin}
	tEthWallet.fundingCoins = asset.Coins{changeCoin}

	oid := lo.ID()

	tracker := &trackedTrade{
		Order:    lo,
		dc:       rig.dc,
		metaData: dbOrder.MetaData,
		matches: map[order.MatchID]*matchTracker{
			match.MatchID: {
				MetaMatch: db.MetaMatch{
					MetaData: &db.MatchMetaData{},
					UserMatch: &order.UserMatch{
						OrderID:  lo.ID(),
						MatchID:  match.MatchID,
						Status:   order.NewlyMatched,
						Side:     order.Maker,
						Quantity: match.Quantity,
					},
				},
				prefix: lo.Prefix(),
				trade:  lo.Trade(),
				// counterConfirms: -1,
			},
		},
		coins:              map[string]asset.Coin{"changecoinid": changeCoin},
		redemptionReserves: redemptionReserves,
		refundReserves:     refundReserves,
	}

	rig.dc.trades = map[order.OrderID]*trackedTrade{
		oid: tracker,
	}

	// reset
	reset := func() {
		tEthWallet.reservedRedemption = 0
		tEthWallet.reservedRefund = 0
		tracker.redemptionLocked = 0
		tracker.refundLocked = 0
	}

	run := func(tag string) {
		t.Helper()
		description := fmt.Sprintf("%s: side = %s, order status = %s, match status = %s",
			tag, match.Side, dbOrder.MetaData.Status, match.Status)

		tCore.reReserveFunding(btcWallet)
		tCore.reReserveFunding(ethWallet)

		if lo.T.Sell && ((match.Side == order.Taker && match.Status < order.MatchComplete) ||
			(match.Side == order.Taker && match.Status < order.MakerRedeemed)) {
			var reReserveQty uint64 = redemptionReserves
			if dbOrder.MetaData.Status > order.OrderStatusBooked {
				reReserveQty = applyFraction(match.Quantity, qty, redemptionReserves)
			}

			if tEthWallet.reservedRedemption != reReserveQty {
				t.Fatalf("%s: redemption funds not reserved, %d != %d", description, tEthWallet.reservedRedemption, reReserveQty)
			}
		}

		if !lo.T.Sell && match.Status < order.MakerRedeemed {
			var reRefundQty uint64 = refundReserves
			if dbOrder.MetaData.Status > order.OrderStatusBooked {
				reRefundQty = applyFraction(match.Quantity, qty, refundReserves)
			}

			if tEthWallet.reservedRefund != reRefundQty {
				t.Fatalf("%s: refund funds not reserved, %d != %d", description, tEthWallet.reservedRefund, reRefundQty)
			}
		}

		reset()
	}

	for _, tt := range reservationTests {

		lo.T.Sell = tt.sell
		tracker.wallets, _, _, _ = tCore.walletSet(rig.dc, utxoAsset.ID, acctAsset.ID, tt.sell)
		if tt.sell {
			dbOrder.MetaData.RefundReserves = 0
			dbOrder.MetaData.RedemptionReserves = redemptionReserves
		} else {
			dbOrder.MetaData.RefundReserves = refundReserves
			dbOrder.MetaData.RedemptionReserves = 0
		}
		for _, side := range tt.side {
			match.Side = side
			for _, orderStatus := range tt.orderStatuses {
				dbOrder.MetaData.Status = orderStatus
				for _, matchStatus := range tt.matchStatuses {
					match.Status = matchStatus
					run(tt.name)
				}
			}
		}
	}

}

func TestCompareServerMatches(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	preImg := newPreimage()
	dc := rig.dc

	notes := make(map[string][]Notification)
	notify := func(note Notification) {
		notes[note.Type()] = append(notes[note.Type()], note)
	}

	lo := &order.LimitOrder{
		P: order.Prefix{
			// 	OrderType:  order.LimitOrderType,
			// 	BaseAsset:  tUTXOAssetA.ID,
			// 	QuoteAsset: tUTXOAssetB.ID,
			// 	ClientTime: time.Now(),
			ServerTime: time.Now(),
			// 	Commit:     preImg.Commit(),
		},
	}
	oid := lo.ID()
	dbOrder := &db.MetaOrder{
		MetaData: &db.OrderMetaData{},
		Order:    lo,
	}
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, nil, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)

	// Known trade, and known match
	knownID := ordertest.RandomMatchID()
	knownMatch := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: knownID},
			MetaData:  &db.MatchMetaData{},
		},
		counterConfirms: -1,
	}
	tracker.matches[knownID] = knownMatch
	knownMsgMatch := &msgjson.Match{OrderID: oid[:], MatchID: knownID[:]}

	// Known trade, but missing match
	missingID := ordertest.RandomMatchID()
	missingMatch := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: missingID},
			MetaData:  &db.MatchMetaData{},
		},
	}
	tracker.matches[missingID] = missingMatch

	// extra match
	extraID := ordertest.RandomMatchID()
	extraMsgMatch := &msgjson.Match{OrderID: oid[:], MatchID: extraID[:]}

	// Entirely missing order
	loMissing, dbOrderMissing, preImgMissing, _ := makeLimitOrder(dc, true, 3*dcrBtcLotSize, dcrBtcRateStep*10)
	trackerMissing := newTrackedTrade(dbOrderMissing, preImgMissing, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, nil, nil, notify, rig.core.formatDetails, &rig.core.wg)
	oidMissing := loMissing.ID()
	// an active match for the missing trade
	matchIDMissing := ordertest.RandomMatchID()
	missingTradeMatch := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: matchIDMissing},
			MetaData:  &db.MatchMetaData{},
		},
		counterConfirms: -1,
	}
	trackerMissing.matches[knownID] = missingTradeMatch
	// an inactive match for the missing trade
	matchIDMissingInactive := ordertest.RandomMatchID()
	missingTradeMatchInactive := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{
				MatchID: matchIDMissingInactive,
				Status:  order.MatchComplete,
			},
			MetaData: &db.MatchMetaData{
				Proof: db.MatchProof{
					Auth: db.MatchAuth{
						RedeemSig: []byte{1, 2, 3}, // won't be considered complete with out it
					},
				},
			},
		},
		counterConfirms: 1,
	}
	trackerMissing.matches[matchIDMissingInactive] = missingTradeMatchInactive

	srvMatches := map[order.OrderID]*serverMatches{
		oid: {
			tracker:    tracker,
			msgMatches: []*msgjson.Match{knownMsgMatch, extraMsgMatch},
		},
		// oidMissing not included (missing!)
	}

	dc.trades = map[order.OrderID]*trackedTrade{
		oid:        tracker,
		oidMissing: trackerMissing,
	}

	exceptions, _ := dc.compareServerMatches(srvMatches)
	if len(exceptions) != 2 {
		t.Fatalf("exceptions did not include both trades, just %d", len(exceptions))
	}

	exc, ok := exceptions[oid]
	if !ok {
		t.Fatalf("exceptions did not include trade %v", oid)
	}
	if exc.trade.ID() != oid {
		t.Fatalf("wrong trade ID, got %v, want %v", exc.trade.ID(), oid)
	}
	if len(exc.missing) != 1 {
		t.Fatalf("found %d missing matches for trade %v, expected 1", len(exc.missing), oid)
	}
	if exc.missing[0].MatchID != missingID {
		t.Fatalf("wrong missing match, got %v, expected %v", exc.missing[0].MatchID, missingID)
	}
	if len(exc.extra) != 1 {
		t.Fatalf("found %d extra matches for trade %v, expected 1", len(exc.extra), oid)
	}
	if !bytes.Equal(exc.extra[0].MatchID, extraID[:]) {
		t.Fatalf("wrong extra match, got %v, expected %v", exc.extra[0].MatchID, extraID)
	}

	exc, ok = exceptions[oidMissing]
	if !ok {
		t.Fatalf("exceptions did not include trade %v", oidMissing)
	}
	if exc.trade.ID() != oidMissing {
		t.Fatalf("wrong trade ID, got %v, want %v", exc.trade.ID(), oidMissing)
	}
	if len(exc.missing) != 1 { // no matchIDMissingInactive
		t.Fatalf("found %d missing matches for trade %v, expected 1", len(exc.missing), oid)
	}
	if exc.missing[0].MatchID != matchIDMissing {
		t.Fatalf("wrong missing match, got %v, expected %v", exc.missing[0].MatchID, matchIDMissing)
	}
	if len(exc.extra) != 0 {
		t.Fatalf("found %d extra matches for trade %v, expected 0", len(exc.extra), oid)
	}
}

func TestPreimageSync(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dcrWallet, tDcrWallet := newTradingTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.Unlock(rig.crypter)

	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.Unlock(rig.crypter)

	var lots uint64 = 10
	qty := dcrBtcLotSize * lots
	rate := dcrBtcRateStep * 1000

	form := &TradeForm{
		Host:    tDexHost,
		IsLimit: true,
		Sell:    true,
		Base:    tUTXOAssetA.ID,
		Quote:   tUTXOAssetB.ID,
		Qty:     qty,
		Rate:    rate,
		TifNow:  false,
	}

	dcrCoin := &tCoin{
		id:  encode.RandomBytes(36),
		val: qty * 2,
	}
	tDcrWallet.fundingCoins = asset.Coins{dcrCoin}
	tDcrWallet.fundRedeemScripts = []dex.Bytes{nil}

	btcVal := calc.BaseToQuote(rate, qty*2)
	btcCoin := &tCoin{
		id:  encode.RandomBytes(36),
		val: btcVal,
	}
	tBtcWallet.fundingCoins = asset.Coins{btcCoin}
	tBtcWallet.fundRedeemScripts = []dex.Bytes{nil}

	limitRouteProcessing := make(chan order.OrderID)
	var commit order.Commitment

	rig.ws.queueResponse(msgjson.LimitRoute, func(msg *msgjson.Message, f msgFunc) error {
		t.Helper()
		// Need to stamp and sign the message with the server's key.
		msgOrder := new(msgjson.LimitOrder)
		err := msg.Unmarshal(msgOrder)
		if err != nil {
			return fmt.Errorf("unmarshal error: %w", err)
		}
		lo := convertMsgLimitOrder(msgOrder)
		resp := orderResponse(msg.ID, msgOrder, lo, false, false, false)
		limitRouteProcessing <- lo.ID()
		commit = lo.Commit // accessed below only after errChan receive indicating Trade done
		f(resp)            // e.g. the UnmarshalJSON in sendRequest
		return nil
	})

	errChan := make(chan error, 1)
	// Run the trade in a goroutine.
	go func() {
		_, err := tCore.Trade(tPW, form)
		errChan <- err
	}()

	// Wait for the limit route to start processing. Then we have 100 ms to call
	// handlePreimageRequest to catch the early-preimage case.
	var oid order.OrderID
	select {
	case oid = <-limitRouteProcessing:
	case <-time.After(time.Second):
		t.Fatalf("limit route never hit")
	}

	err := <-errChan
	if err != nil {
		t.Fatalf("trade error: %v", err)
	}

	// So ideally, we're calling handlePreimageRequest about 100 ms before we
	// even have an order id back from the server. This shouldn't result in an
	// error.
	payload := &msgjson.PreimageRequest{
		OrderID:    oid[:],
		Commitment: commit[:],
	}
	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)
	err = handlePreimageRequest(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("early preimage request error: %v", err)
	}
}

func TestAccelerateOrder(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tDcrWallet.swapSize = tSwapSizeA
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tBtcWallet.swapSize = tSwapSizeB
	tCore.wallets[tUTXOAssetB.ID] = btcWallet

	buyWalletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, false)
	sellWalletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, false)

	var newBaseFeeRate uint64 = 55
	var newQuoteFeeRate uint64 = 65
	feeRateSource := func(msg *msgjson.Message, f msgFunc) error {
		var resp *msgjson.Message
		if string(msg.Payload) == "42" {
			resp, _ = msgjson.NewResponse(msg.ID, newBaseFeeRate, nil)
		} else {
			resp, _ = msgjson.NewResponse(msg.ID, newQuoteFeeRate, nil)
		}
		f(resp)
		return nil
	}

	type testMatch struct {
		status   order.MatchStatus
		quantity uint64
		rate     uint64
		side     order.MatchSide
	}

	tests := []struct {
		name                       string
		orderQuantity              uint64
		orderFilled                uint64
		orderStatus                order.OrderStatus
		rate                       uint64
		sell                       bool
		previousAccelerations      []order.CoinID
		matches                    []testMatch
		expectRequiredForRemaining uint64
		expectError                bool
		orderIDIncorrectLength     bool
		nonActiveOrderID           bool
		accelerateOrderError       bool
		nilChangeCoin              bool
		nilNewChangeCoin           bool
	}{
		{
			name:                  "ok",
			orderQuantity:         3 * dcrBtcLotSize,
			orderFilled:           dcrBtcLotSize,
			previousAccelerations: []order.CoinID{encode.RandomBytes(32)},
			orderStatus:           order.OrderStatusExecuted,
			rate:                  dcrBtcRateStep * 10,
			// Note: the upstream FeesForRemainingSwaps asset interface used
			// to take a feeRate arg (mock returned n * feeRate * swapSize).
			// The signature was simplified to drop feeRate (mock became
			// n * 1 * swapSize), but these expectations were never updated
			// and still carried a stale tMaxFeeRate factor. Removed here.
			expectRequiredForRemaining: 2*tSwapSizeB + calc.BaseToQuote(dcrBtcRateStep*10, 2*dcrBtcLotSize),
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
		},
		{
			name:                       "ok - unswapped match, buy",
			orderQuantity:              8 * dcrBtcLotSize,
			orderFilled:                5 * dcrBtcLotSize,
			orderStatus:                order.OrderStatusExecuted,
			previousAccelerations:      []order.CoinID{encode.RandomBytes(32), encode.RandomBytes(32)},
			rate:                       dcrBtcRateStep * 10,
			expectRequiredForRemaining: 4*tSwapSizeB + calc.BaseToQuote(dcrBtcRateStep*10, 5*dcrBtcLotSize),
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
				{
					side:     order.Taker,
					status:   order.TakerSwapCast,
					quantity: 2 * dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
				{
					side:     order.Taker,
					status:   order.MakerSwapCast,
					quantity: 2 * dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
		},
		{
			name:                       "ok - unswapped match, sell",
			sell:                       true,
			previousAccelerations:      []order.CoinID{encode.RandomBytes(32), encode.RandomBytes(32)},
			orderQuantity:              8 * dcrBtcLotSize,
			orderFilled:                5 * dcrBtcLotSize,
			orderStatus:                order.OrderStatusExecuted,
			rate:                       dcrBtcRateStep * 10,
			expectRequiredForRemaining: 4*tSwapSizeB + 5*dcrBtcLotSize,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
				{
					side:     order.Taker,
					status:   order.TakerSwapCast,
					quantity: 2 * dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
				{
					side:     order.Taker,
					status:   order.MakerSwapCast,
					quantity: 2 * dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
		},
		{
			name: "10 previous accelerations",
			sell: true,
			previousAccelerations: []order.CoinID{encode.RandomBytes(32), encode.RandomBytes(32),
				encode.RandomBytes(32), encode.RandomBytes(32),
				encode.RandomBytes(32), encode.RandomBytes(32),
				encode.RandomBytes(32), encode.RandomBytes(32),
				encode.RandomBytes(32), encode.RandomBytes(32)},
			orderQuantity: 8 * dcrBtcLotSize,
			orderFilled:   5 * dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			expectError: true,
		},
		{
			name:          "no matches",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches:       []testMatch{},
			expectError:   true,
		},
		{
			name:          "no swap coins",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{{
				side:     order.Taker,
				status:   order.MakerSwapCast,
				quantity: 2 * dcrBtcLotSize,
				rate:     dcrBtcRateStep * 10,
			}},
			expectError: true,
		},
		{
			name:          "incorrect length order id",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			orderIDIncorrectLength: true,
			expectError:            true,
		},
		{
			name:          "incorrect length order id",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			nonActiveOrderID: true,
			expectError:      true,
		},
		{
			name:          "accelerate order err",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			accelerateOrderError: true,
			expectError:          true,
		},
		{
			name:          "nil change coin",
			orderQuantity: 3 * dcrBtcLotSize,
			orderFilled:   dcrBtcLotSize,
			orderStatus:   order.OrderStatusExecuted,
			rate:          dcrBtcRateStep * 10,
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			nilChangeCoin: true,
			expectError:   true,
		},
		{
			name:                       "nil new change coin",
			orderQuantity:              3 * dcrBtcLotSize,
			orderFilled:                dcrBtcLotSize,
			orderStatus:                order.OrderStatusExecuted,
			rate:                       dcrBtcRateStep * 10,
			expectRequiredForRemaining: 2*tSwapSizeB + calc.BaseToQuote(dcrBtcRateStep*10, 2*dcrBtcLotSize),
			matches: []testMatch{
				{
					side:     order.Maker,
					status:   order.TakerSwapCast,
					quantity: dcrBtcLotSize,
					rate:     dcrBtcRateStep * 10,
				},
			},
			nilNewChangeCoin: true,
		},
	}

	for _, test := range tests {
		tBtcWallet.accelerateOrderErr = nil
		lo, dbOrder, preImg, addr := makeLimitOrder(dc, test.sell, test.orderQuantity, test.rate)
		dbOrder.MetaData.Status = test.orderStatus // so there is no order_status request for this
		oid := lo.ID()
		var walletSet *walletSet
		if test.sell {
			walletSet = sellWalletSet
		} else {
			walletSet = buyWalletSet
		}
		trade := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
			rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
		dc.trades[trade.ID()] = trade
		trade.Trade().AddFill(test.orderFilled)

		trade.metaData.ChangeCoin = encode.RandomBytes(32)
		originalChangeCoin := trade.metaData.ChangeCoin
		trade.metaData.AccelerationCoins = test.previousAccelerations
		newChangeCoinID := dex.Bytes(encode.RandomBytes(32))
		if test.nilNewChangeCoin {
			tBtcWallet.newChangeCoinID = nil
		} else {
			tBtcWallet.newChangeCoinID = &newChangeCoinID
		}
		tBtcWallet.newAccelerationTxID = hex.EncodeToString(encode.RandomBytes(32))
		trade.matches = make(map[order.MatchID]*matchTracker)
		expectedSwapCoins := make([]order.CoinID, 0, len(test.matches))
		for _, testMatch := range test.matches {
			matchID := ordertest.RandomMatchID()
			match := &matchTracker{
				MetaMatch: db.MetaMatch{
					MetaData: &db.MatchMetaData{
						Proof: db.MatchProof{
							MakerSwap: encode.RandomBytes(32),
							TakerSwap: encode.RandomBytes(32),
						},
					},
					UserMatch: &order.UserMatch{
						MatchID:  matchID,
						Address:  addr,
						Side:     testMatch.side,
						Status:   testMatch.status,
						Quantity: testMatch.quantity,
						Rate:     testMatch.rate,
					},
				},
			}
			if testMatch.side == order.Maker && testMatch.status >= order.MakerSwapCast {
				expectedSwapCoins = append(expectedSwapCoins, match.MetaData.Proof.MakerSwap)
			}
			if testMatch.side == order.Taker && testMatch.status >= order.TakerSwapCast {
				expectedSwapCoins = append(expectedSwapCoins, match.MetaData.Proof.TakerSwap)
			}
			trade.matches[matchID] = match
		}
		orderIDBytes := oid.Bytes()
		if test.orderIDIncorrectLength {
			orderIDBytes = encode.RandomBytes(31)
		}
		if test.nonActiveOrderID {
			orderIDBytes = encode.RandomBytes(32)
		}
		if test.accelerateOrderError {
			tBtcWallet.accelerateOrderErr = errors.New("")
		}
		if test.nilChangeCoin {
			trade.metaData.ChangeCoin = nil
		}

		checkCommonCallValues := func() {
			t.Helper()
			swapCoins := tBtcWallet.accelerationParams.swapCoins
			if len(swapCoins) != len(expectedSwapCoins) {
				t.Fatalf("expected %d swap coins but got %d", len(expectedSwapCoins), len(swapCoins))
			}

			sort.Slice(swapCoins, func(i, j int) bool { return bytes.Compare(swapCoins[i], swapCoins[j]) > 0 })
			sort.Slice(expectedSwapCoins, func(i, j int) bool { return bytes.Compare(expectedSwapCoins[i], expectedSwapCoins[j]) > 0 })

			for i := range swapCoins {
				if !bytes.Equal(swapCoins[i], expectedSwapCoins[i]) {
					t.Fatalf("expected swap coins not the same as actual")
				}
			}

			changeCoin := tBtcWallet.accelerationParams.changeCoin
			if !bytes.Equal(changeCoin, originalChangeCoin) {
				t.Fatalf("change coin not same as expected %x - %x", changeCoin, trade.metaData.ChangeCoin)
			}

			accelerationCoins := tBtcWallet.accelerationParams.accelerationCoins
			if len(accelerationCoins) != len(test.previousAccelerations) {
				t.Fatalf("expected 1 acceleration tx but got %v", len(accelerationCoins))
			}
			for i := range accelerationCoins {
				if !bytes.Equal(accelerationCoins[i], test.previousAccelerations[i]) {
					t.Fatalf("expected acceleration coin not the same as actual")
				}
			}
		}

		checkRequiredForRemainingSwaps := func() {
			t.Helper()
			if tBtcWallet.accelerationParams.requiredForRemainingSwaps != test.expectRequiredForRemaining {
				t.Fatalf("expected requiredForRemainingSwaps %d, but got %d", test.expectRequiredForRemaining,
					tBtcWallet.accelerationParams.requiredForRemainingSwaps)
			}
		}

		testAccelerateOrder := func() {
			newFeeRate := rand.Uint64()
			txID, err := tCore.AccelerateOrder(tPW, orderIDBytes, newFeeRate)
			if test.expectError {
				if err == nil {
					t.Fatalf("expected error, but did not get")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			checkCommonCallValues()
			checkRequiredForRemainingSwaps()

			if test.nilNewChangeCoin {
				if tBtcWallet.newChangeCoinID != nil {
					t.Fatalf("expected coin on order to be nil, but got %x", tBtcWallet.newChangeCoinID)
				}
			} else {
				if !bytes.Equal(trade.metaData.ChangeCoin, *tBtcWallet.newChangeCoinID) {
					t.Fatalf("change coin on trade was not updated to return value from AccelerateOrder")
				}
				if !bytes.Equal(trade.metaData.AccelerationCoins[len(trade.metaData.AccelerationCoins)-1], *tBtcWallet.newChangeCoinID) {
					t.Fatalf("new acceleration transaction id was not added to the trade")
				}

				var inCoinsList bool
				for _, coin := range trade.coins {
					if bytes.Equal(coin.ID(), *tBtcWallet.newChangeCoinID) {
						inCoinsList = true
					}
				}
				if !inCoinsList {
					t.Fatalf("new change coin must be added to the trade.coins slice")
				}
			}
			if txID != tBtcWallet.newAccelerationTxID {
				t.Fatalf("new acceleration transaction id was not returned from AccelerateOrder")
			}
			if newFeeRate != tBtcWallet.accelerationParams.newFeeRate {
				t.Fatalf("%s: expected new fee rate %d, but got %d", test.name,
					newFeeRate, tBtcWallet.accelerationParams.newFeeRate)
			}
		}

		testPreAccelerate := func() {
			rig.ws.queueResponse(msgjson.FeeRateRoute, feeRateSource)
			tBtcWallet.preAccelerateSwapRate = rand.Uint64()
			tBtcWallet.preAccelerateSuggestedRange = asset.XYRange{
				Start: asset.XYRangePoint{
					Label: "startLabel",
					X:     rand.Float64(),
					Y:     rand.Float64(),
				},
				End: asset.XYRangePoint{
					Label: "endLabel",
					X:     rand.Float64(),
					Y:     rand.Float64(),
				},
				XUnit: "x",
				YUnit: "y",
			}

			preAccelerate, err := tCore.PreAccelerateOrder(orderIDBytes)
			if test.expectError {
				if err == nil {
					t.Fatalf("expected error, but did not get")
				}
				return
			}
			if err != nil {
				t.Fatalf("%s: unexpected error: %v", test.name, err)
			}

			checkCommonCallValues()
			checkRequiredForRemainingSwaps()

			if !test.sell && preAccelerate.SuggestedRate != newQuoteFeeRate {
				t.Fatalf("%s: expected fee suggestion to be %d, but got %d",
					test.name, newQuoteFeeRate, preAccelerate.SuggestedRate)
			}
			if test.sell && preAccelerate.SuggestedRate != newBaseFeeRate {
				t.Fatalf("%s: expected fee suggestion to be %d, but got %d",
					test.name, newBaseFeeRate, preAccelerate.SuggestedRate)
			}
			if preAccelerate.SwapRate != tBtcWallet.preAccelerateSwapRate {
				t.Fatalf("%s: expected pre accelerate swap rate %d, but got %d",
					test.name, tBtcWallet.preAccelerateSwapRate, preAccelerate.SwapRate)
			}
			if !reflect.DeepEqual(preAccelerate.SuggestedRange,
				tBtcWallet.preAccelerateSuggestedRange) {
				t.Fatalf("%s: PreAccelerate suggested range not same as expected",
					test.name)
			}
		}

		testMaxAcceleration := func() {
			t.Helper()
			tBtcWallet.accelerationEstimate = rand.Uint64()
			newFeeRate := rand.Uint64()
			estimate, err := tCore.AccelerationEstimate(orderIDBytes, newFeeRate)
			if test.expectError {
				if err == nil {
					t.Fatalf("expected error, but did not get")
				}
				return
			}
			if err != nil {
				t.Fatalf("%s: unexpected error: %v", test.name, err)
			}

			checkCommonCallValues()
			checkRequiredForRemainingSwaps()

			if newFeeRate != tBtcWallet.accelerationParams.newFeeRate {
				t.Fatalf("%s: expected new fee rate %d, but got %d", test.name,
					newFeeRate, tBtcWallet.accelerationParams.newFeeRate)
			}
			if estimate != tBtcWallet.accelerationEstimate {
				t.Fatalf("%s: expected acceleration estimate %d, but got %d",
					test.name, tBtcWallet.accelerationEstimate, estimate)
			}
		}

		testPreAccelerate()
		testMaxAcceleration()
		testAccelerateOrder()
	}
}

func TestMaxSwapsRedeemsInTx(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	dcrWallet, tDcrWallet := newTradingTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tDcrWallet.maxSwaps = 4
	tDcrWallet.maxRedeems = 4

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, 0, 0)
	oid := lo.ID()
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	newMatch := func(side order.MatchSide, status order.MatchStatus) *matchTracker {
		matchAddr := ordertest.RandomAddress()
		return &matchTracker{
			prefix: lo.Prefix(),
			trade:  lo.Trade(),
			MetaMatch: db.MetaMatch{
				MetaData: &db.MatchMetaData{
					Proof: db.MatchProof{
						Auth: db.MatchAuth{
							MatchStamp: uint64(time.Now().UnixMilli()),
							AuditStamp: uint64(time.Now().UnixMilli()),
						},
					},
					CounterPartyAddr: matchAddr,
				},
				UserMatch: &order.UserMatch{
					MatchID:     ordertest.RandomMatchID(),
					Side:        side,
					Address:     matchAddr,
					Status:      status,
					FeeRateSwap: tMaxFeeRate,
				},
			},
		}
	}

	swapabbleMatches := func(num int) map[order.MatchID]*matchTracker {
		matches := make(map[order.MatchID]*matchTracker, num)
		for i := 0; i < num; i++ {
			m := newMatch(order.Maker, order.NewlyMatched)
			matches[m.MatchID] = m
		}
		return matches
	}

	redeemableMatches := func(num int) map[order.MatchID]*matchTracker {
		matches := make(map[order.MatchID]*matchTracker, num)
		for i := 0; i < num; i++ {
			m := newMatch(order.Taker, order.MakerRedeemed)
			matches[m.MatchID] = m
			rig.ws.queueResponse(msgjson.RedeemRoute, redeemAcker)
		}
		return matches
	}

	checkNumSwaps := func(expected []int, wallet *TXCWallet) {
		t.Helper()
		for i := range expected {
			if expected[i] != len(wallet.lastSwaps[i].Contracts) {
				t.Fatalf("expected %d swaps but got %d", expected[i], len(wallet.lastSwaps[i].Contracts))
			}
		}
	}

	checkNumRedeems := func(expected []int, wallet *TXCWallet) {
		t.Helper()
		for i := range expected {
			if expected[i] != len(wallet.lastRedeems[i].Redemptions) {
				t.Fatalf("expected %d redeems but got %d", expected[i], len(wallet.lastRedeems[i].Redemptions))
			}
		}
	}

	populateRedeemCoins := func(num int, wallet *TXCWallet) {
		wallet.redeemCoins = make([]dex.Bytes, num)
		for i := 0; i < num; i++ {
			wallet.redeemCoins = append(wallet.redeemCoins, encode.RandomBytes(32))
		}
	}

	// Test Swaps
	expected := []int{4, 4, 4, 4, 4, 2}
	tracker.matches = swapabbleMatches(22)
	tCore.tick(tracker)
	checkNumSwaps(expected, tDcrWallet)

	tDcrWallet.lastSwaps = make([]*asset.Swaps, 0)
	expected = []int{3}
	tracker.matches = swapabbleMatches(3)
	tCore.tick(tracker)
	checkNumSwaps(expected, tDcrWallet)

	tDcrWallet.lastSwaps = make([]*asset.Swaps, 0)
	expected = []int{4}
	tracker.matches = swapabbleMatches(4)
	tCore.tick(tracker)
	checkNumSwaps(expected, tDcrWallet)

	// Test Redeems
	expected = []int{4, 4, 4, 4, 4, 2}
	tracker.matches = redeemableMatches(22)
	populateRedeemCoins(22, tBtcWallet)
	tCore.tick(tracker)
	checkNumRedeems(expected, tBtcWallet)

	tBtcWallet.lastRedeems = make([]*asset.RedeemForm, 0)
	expected = []int{3}
	tracker.matches = redeemableMatches(3)
	populateRedeemCoins(3, tBtcWallet)
	tCore.tick(tracker)
	checkNumRedeems(expected, tBtcWallet)

	tBtcWallet.lastRedeems = make([]*asset.RedeemForm, 0)
	expected = []int{4}
	tracker.matches = redeemableMatches(4)
	populateRedeemCoins(4, tBtcWallet)
	tCore.tick(tracker)
	checkNumRedeems(expected, tBtcWallet)
}

func TestSuspectTrades(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	dcrWallet, tDcrWallet := newTradingTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	lo, dbOrder, preImg, addr := makeLimitOrder(dc, true, 0, 0)
	oid := lo.ID()
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	newMatch := func(side order.MatchSide, status order.MatchStatus) *matchTracker {
		matchAddr := ordertest.RandomAddress()
		return &matchTracker{
			prefix: lo.Prefix(),
			trade:  lo.Trade(),
			MetaMatch: db.MetaMatch{
				MetaData: &db.MatchMetaData{
					Proof: db.MatchProof{
						Auth: db.MatchAuth{
							MatchStamp: uint64(time.Now().UnixMilli()),
							AuditStamp: uint64(time.Now().UnixMilli()),
						},
					},
					CounterPartyAddr: matchAddr,
				},
				UserMatch: &order.UserMatch{
					MatchID:     ordertest.RandomMatchID(),
					Side:        side,
					Address:     matchAddr,
					Status:      status,
					FeeRateSwap: tMaxFeeRate,
				},
			},
		}
	}

	var swappableMatch1, swappableMatch2 *matchTracker
	setSwaps := func() {
		swappableMatch1 = newMatch(order.Maker, order.NewlyMatched)
		swappableMatch2 = newMatch(order.Taker, order.MakerSwapCast)

		// Set counterswaps for both swaps.
		// Set valid wallet auditInfo for swappableMatch2, taker will repeat audit before swapping.
		auditQty := calc.BaseToQuote(swappableMatch2.Rate, swappableMatch2.Quantity)
		_, auditInfo := tMsgAudit(oid, swappableMatch2.MatchID, addr, auditQty, encode.RandomBytes(32))
		auditInfo.Expiration = encode.DropMilliseconds(swappableMatch2.matchTime().Add(tracker.lockTimeMaker))
		tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetA.SwapConf, nil)
		tBtcWallet.auditInfo = auditInfo
		swappableMatch2.counterSwap = auditInfo

		_, auditInfo = tMsgAudit(oid, swappableMatch1.MatchID, ordertest.RandomAddress(), 1, encode.RandomBytes(32))
		tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetA.SwapConf, nil)
		swappableMatch1.counterSwap = auditInfo

		tDcrWallet.swapCounter = 0
		tracker.matches = map[order.MatchID]*matchTracker{
			swappableMatch1.MatchID: swappableMatch1,
			swappableMatch2.MatchID: swappableMatch2,
		}
	}
	setSwaps()

	// Initial success
	_, err := tCore.tick(tracker)
	if err != nil {
		t.Fatalf("swap tick error: %v", err)
	}

	setSwaps()
	tDcrWallet.swapErr = tErr
	_, err = tCore.tick(tracker)
	if err == nil || !strings.Contains(err.Error(), "error sending dcr swap transaction") {
		t.Fatalf("swap error not propagated, err = %v", err)
	}
	if tDcrWallet.swapCounter != 1 {
		t.Fatalf("never swapped")
	}

	// Both matches should be marked as suspect and have tickGovernors in place.
	tracker.mtx.Lock()
	for i, m := range []*matchTracker{swappableMatch1, swappableMatch2} {
		if !m.suspectSwap {
			t.Fatalf("swappable match %d not suspect after failed swap", i+1)
		}
		if m.tickGovernor == nil {
			t.Fatalf("swappable match %d has no tick meterer set", i+1)
		}
	}
	tracker.mtx.Unlock()

	// Ticking right away again should do nothing.
	tDcrWallet.swapErr = nil
	_, err = tCore.tick(tracker)
	if err != nil {
		t.Fatalf("tick error during metered swap tick: %v", err)
	}
	if tDcrWallet.swapCounter != 1 {
		t.Fatalf("swapped during metered tick")
	}

	// But once the tickGovernors expire, we should succeed with two separate
	// requests.
	tracker.mtx.Lock()
	swappableMatch1.tickGovernor = nil
	swappableMatch2.tickGovernor = nil
	tracker.mtx.Unlock()
	_, err = tCore.tick(tracker)
	if err != nil {
		t.Fatalf("tick error while swapping suspect matches: %v", err)
	}
	if tDcrWallet.swapCounter != 3 {
		t.Fatalf("suspect swap matches not run or not run separately. expected 2 new calls to Swap, got %d", tDcrWallet.swapCounter-1)
	}

	var redeemableMatch1, redeemableMatch2 *matchTracker
	setRedeems := func() {
		redeemableMatch1 = newMatch(order.Maker, order.TakerSwapCast)
		redeemableMatch2 = newMatch(order.Taker, order.MakerRedeemed)

		// Set valid wallet auditInfo for redeemableMatch1, maker will repeat audit before redeeming.
		auditQty := calc.BaseToQuote(redeemableMatch1.Rate, redeemableMatch1.Quantity)
		_, auditInfo := tMsgAudit(oid, redeemableMatch1.MatchID, addr, auditQty, encode.RandomBytes(32))
		auditInfo.Expiration = encode.DropMilliseconds(redeemableMatch1.matchTime().Add(tracker.lockTimeTaker))
		tBtcWallet.setConfs(auditInfo.Coin.ID(), tUTXOAssetB.SwapConf, nil)
		tBtcWallet.auditInfo = auditInfo
		redeemableMatch1.counterSwap = auditInfo
		redeemableMatch1.MetaData.Proof.SecretHash = auditInfo.SecretHash

		tBtcWallet.redeemCounter = 0
		tracker.matches = map[order.MatchID]*matchTracker{
			redeemableMatch1.MatchID: redeemableMatch1,
			redeemableMatch2.MatchID: redeemableMatch2,
		}
		rig.ws.queueResponse(msgjson.RedeemRoute, redeemAcker)
		rig.ws.queueResponse(msgjson.RedeemRoute, redeemAcker)
	}
	setRedeems()

	// Initial success
	tBtcWallet.redeemCoins = []dex.Bytes{encode.RandomBytes(36), encode.RandomBytes(36)}
	_, err = tCore.tick(tracker)
	if err != nil {
		t.Fatalf("redeem tick error: %v", err)
	}
	if tBtcWallet.redeemCounter != 1 {
		t.Fatalf("never redeemed")
	}

	setRedeems()
	tBtcWallet.redeemErr = tErr
	_, err = tCore.tick(tracker)
	if err == nil || !strings.Contains(err.Error(), "error sending redeem transaction") {
		t.Fatalf("redeem error not propagated. err = %v", err)
	}
	if tBtcWallet.redeemCounter != 1 {
		t.Fatalf("never redeemed")
	}

	// Both matches should be marked as suspect and have tickGovernors in place.
	tracker.mtx.Lock()
	for i, m := range []*matchTracker{redeemableMatch1, redeemableMatch2} {
		if !m.suspectRedeem {
			t.Fatalf("redeemable match %d not suspect after failed swap", i+1)
		}
		if m.tickGovernor == nil {
			t.Fatalf("redeemable match %d has no tick meterer set", i+1)
		}
	}
	tracker.mtx.Unlock()

	// Ticking right away again should do nothing.
	tBtcWallet.redeemErr = nil
	_, err = tCore.tick(tracker)
	if err != nil {
		t.Fatalf("tick error during metered redeem tick: %v", err)
	}
	if tBtcWallet.redeemCounter != 1 {
		t.Fatalf("redeemed during metered tick %d", tBtcWallet.redeemCounter)
	}

	// But once the tickGovernors expire, we should succeed with two separate
	// requests.
	tracker.mtx.Lock()
	redeemableMatch1.tickGovernor = nil
	redeemableMatch2.tickGovernor = nil
	tracker.mtx.Unlock()
	_, err = tCore.tick(tracker)
	if err != nil {
		t.Fatalf("tick error while redeeming suspect matches: %v", err)
	}
	if tBtcWallet.redeemCounter != 3 {
		t.Fatalf("suspect redeem matches not run or not run separately. expected 2 new calls to Redeem, got %d", tBtcWallet.redeemCounter-1)
	}
}

func TestPreOrder(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet

	var rate uint64 = 1e8
	quoteConvertedLotSize := calc.BaseToQuote(rate, dcrBtcLotSize)

	book := newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)
	dc.books[tDcrBtcMktName] = book

	sellNote := &msgjson.BookOrderNote{
		OrderNote: msgjson.OrderNote{
			OrderID: encode.RandomBytes(32),
		},
		TradeNote: msgjson.TradeNote{
			Side:     msgjson.SellOrderNum,
			Quantity: quoteConvertedLotSize * 10,
			Time:     uint64(time.Now().Unix()),
			Rate:     rate,
		},
	}

	buyNote := *sellNote
	buyNote.TradeNote.Quantity = dcrBtcLotSize * 10
	buyNote.TradeNote.Side = msgjson.BuyOrderNum

	var baseFeeRate uint64 = 5
	var quoteFeeRate uint64 = 10

	err := book.Sync(&msgjson.OrderBook{
		MarketID:     tDcrBtcMktName,
		Seq:          1,
		Epoch:        1,
		Orders:       []*msgjson.BookOrderNote{sellNote, &buyNote},
		BaseFeeRate:  baseFeeRate,
		QuoteFeeRate: quoteFeeRate,
	})
	if err != nil {
		t.Fatalf("Sync error: %v", err)
	}

	preSwap := &asset.PreSwap{
		Estimate: &asset.SwapEstimate{
			MaxFees:            1001,
			Lots:               5,
			RealisticBestCase:  15,
			RealisticWorstCase: 20,
		},
	}

	tBtcWallet.preSwap = preSwap

	preRedeem := &asset.PreRedeem{
		Estimate: &asset.RedeemEstimate{
			RealisticBestCase:  15,
			RealisticWorstCase: 20,
		},
	}

	tDcrWallet.preRedeem = preRedeem

	form := &TradeForm{
		Host: tDexHost,
		Sell: false,
		// IsLimit: true,
		Base:  tUTXOAssetA.ID,
		Quote: tUTXOAssetB.ID,
		Qty:   quoteConvertedLotSize * 5,
		Rate:  rate,
	}
	preOrder, err := tCore.PreOrder(form)
	if err != nil {
		t.Fatalf("PreOrder market buy error: %v", err)
	}

	compUint64 := func(tag string, a, b uint64) {
		t.Helper()
		if a != b {
			t.Fatalf("%s: %d != %d", tag, a, b)
		}
	}

	est1, est2 := preSwap.Estimate, preOrder.Swap.Estimate
	compUint64("MaxFees", est1.MaxFees, est2.MaxFees)
	compUint64("RealisticWorstCase", est1.RealisticWorstCase, est2.RealisticWorstCase)
	compUint64("RealisticBestCase", est1.RealisticBestCase, est2.RealisticBestCase)
	// This is a buy order, so the from asset is the quote asset.
	compUint64("PreOrder.FeeSuggestion.quote", quoteFeeRate, tBtcWallet.preSwapForm.FeeSuggestion)
	compUint64("PreOrder.FeeSuggestion.base", baseFeeRate, tDcrWallet.preRedeemForm.FeeSuggestion)

	// Missing book is an error
	delete(dc.books, tDcrBtcMktName)
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for market order with missing book")
	}
	dc.books[tDcrBtcMktName] = book

	// Exercise the market sell path too.
	form.Sell = true
	_, err = tCore.PreOrder(form)
	if err != nil {
		t.Fatalf("PreOrder market sell error: %v", err)
	}

	// Market orders have to have a market to make estimates.
	book.Unbook(&msgjson.UnbookOrderNote{
		MarketID: tDcrBtcMktName,
		OrderID:  sellNote.OrderID,
	})
	book.Unbook(&msgjson.UnbookOrderNote{
		MarketID: tDcrBtcMktName,
		OrderID:  buyNote.OrderID,
	})
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for market order with empty market")
	}

	// Limit orders have no such restriction.
	form.IsLimit = true
	_, err = tCore.PreOrder(form)
	if err != nil {
		t.Fatalf("PreOrder limit sell error: %v", err)
	}

	var newBaseFeeRate uint64 = 55
	var newQuoteFeeRate uint64 = 65
	feeRateSource := func(msg *msgjson.Message, f msgFunc) error {
		var resp *msgjson.Message
		if string(msg.Payload) == "42" {
			resp, _ = msgjson.NewResponse(msg.ID, newBaseFeeRate, nil)
		} else {
			resp, _ = msgjson.NewResponse(msg.ID, newQuoteFeeRate, nil)
		}
		f(resp)
		return nil
	}

	// Removing the book should cause us to
	delete(dc.books, tDcrBtcMktName)
	rig.ws.queueResponse(msgjson.FeeRateRoute, feeRateSource)
	rig.ws.queueResponse(msgjson.FeeRateRoute, feeRateSource)

	_, err = tCore.PreOrder(form)
	if err != nil {
		t.Fatalf("PreOrder limit sell error #2: %v", err)
	}
	// sell order now, so from asset is base asset
	compUint64("PreOrder.FeeSuggestion quote asset from server", newQuoteFeeRate, tBtcWallet.preRedeemForm.FeeSuggestion)
	compUint64("PreOrder.FeeSuggestion base asset from server", newBaseFeeRate, tDcrWallet.preSwapForm.FeeSuggestion)
	dc.books[tDcrBtcMktName] = book

	// no DEX
	delete(tCore.conns, dc.acct.host)
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for unknown DEX")
	}
	tCore.conns[dc.acct.host] = dc

	// no wallet
	delete(tCore.wallets, tUTXOAssetA.ID)
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for missing wallet")
	}
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet

	// base wallet not connected
	dcrWallet.hookedUp = false
	tDcrWallet.connectErr = tErr
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for unconnected base wallet")
	}
	dcrWallet.hookedUp = true
	tDcrWallet.connectErr = nil

	// quote wallet not connected
	btcWallet.hookedUp = false
	tBtcWallet.connectErr = tErr
	_, err = tCore.PreOrder(form)
	if err == nil {
		t.Fatalf("no error for unconnected quote wallet")
	}
	btcWallet.hookedUp = true
	tBtcWallet.connectErr = nil

	// success again
	_, err = tCore.PreOrder(form)
	if err != nil {
		t.Fatalf("PreOrder error after fixing everything: %v", err)
	}
}

func TestUpdateFeesPaid(t *testing.T) {
	ctx := t.Context()
	tests := []struct {
		name                   string
		paid                   uint64
		init, swapWallets      bool
		tfpErr, updateOrderErr error
	}{{
		name: "ok init",
		paid: 1,
		init: true,
	}, {
		name:        "ok redeem",
		paid:        1,
		swapWallets: true,
	}, {
		name: "not dynamic",
	}, {
		name:   "TransactionFeesPaid error other than coin not found",
		init:   true,
		tfpErr: errors.New("other error"),
	}}
	for _, test := range tests {
		acctWallet, tWallet := newTWallet(tACCTAsset.ID)
		dynamicFeeChecker := &TDynamicSwapper{TXCWallet: tWallet}
		acctWallet.Wallet = dynamicFeeChecker
		tWallet.confs["00"] = 10

		utxoWallet, _ := newTWallet(tUTXOAssetA.ID)

		wallets := &walletSet{
			fromWallet:  acctWallet,
			toWallet:    utxoWallet,
			baseWallet:  acctWallet,
			quoteWallet: utxoWallet,
		}
		if test.swapWallets {
			wallets.fromWallet, wallets.toWallet = wallets.toWallet, wallets.fromWallet
			wallets.baseWallet, wallets.quoteWallet = wallets.quoteWallet, wallets.baseWallet
		}

		dc := &dexConnection{
			acct: tNewAccount(&tCrypter{}),
			log:  tLogger,
		}
		lo, _, _, _ := makeLimitOrder(dc, true, 0, 0)
		tracker := &trackedTrade{
			wallets:  wallets,
			dc:       dc,
			metaData: new(db.OrderMetaData),
			db:       new(TDB),
			Order:    lo,
			notify:   func(Notification) {},
		}
		tracker.SetTime(time.Now())
		dynamicFeeChecker.tfpPaid = 1
		dynamicFeeChecker.tfpErr = test.tfpErr
		dynamicFeeChecker.tfpSecretHashes = [][]byte{{0}}
		matchID := ordertest.RandomMatchID()
		match := &matchTracker{
			MetaMatch: db.MetaMatch{
				UserMatch: &order.UserMatch{MatchID: matchID},
				MetaData: &db.MatchMetaData{
					Proof: db.MatchProof{
						TakerSwap:   []byte{0},
						MakerSwap:   []byte{0},
						MakerRedeem: []byte{0},
						TakerRedeem: []byte{0},
						SecretHash:  []byte{0},
					},
				},
			},
		}
		tracker.updateDynamicSwapOrRedemptionFeesPaid(ctx, match, test.init)
		got := tracker.metaData.SwapFeesPaid
		if !test.init {
			got = tracker.metaData.RedemptionFeesPaid
		}
		if got != test.paid {
			t.Fatalf("%s: want %d but got %d fees paid", test.name, test.paid, got)
		}
	}
}

// TestDynamicSwapperGasFeeLimit was removed: it exercised the
// `GasFeeLimit() > MaxFeeRate` check that upstream commit 2081f743 added in
// prepareTradeRequest / prepareMultiTradeRequests. Bison-dev3 replaced that
// check with a wallet-provided swapFeeSuggestion via feeSuggestionSwapAny
// (which refuses to fall back to any non-wallet rate, so the wallet's fee
// rate limit is effectively honored as MaxFeeRate). The dedicated
// DynamicSwapper gas-fee-limit check no longer exists, so the test had
// nothing valid to exercise. Removed along with the TDynamicAccountLocker
// helper that was only used here.

func TestTradingLimits(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	checkTradingLimits := func(expectedUserParcels, expectedParcelLimit uint32) {
		t.Helper()

		userParcels, parcelLimit, err := rig.core.TradingLimits(tDexHost)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if userParcels != expectedUserParcels {
			t.Fatalf("expected user parcels %d, got %d", expectedUserParcels, userParcels)
		}

		if parcelLimit != expectedParcelLimit {
			t.Fatalf("expected parcel limit %d, got %d", expectedParcelLimit, parcelLimit)
		}
	}

	rig.dc.acct.rep.BondedTier = 10
	book := newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)
	rig.dc.books[tDcrBtcMktName] = book
	checkTradingLimits(0, 20)

	oids := []order.OrderID{
		{0x01}, {0x02}, {0x03}, {0x04}, {0x05},
	}

	// Add an epoch order, 2 lots not likely taker
	ord := &order.LimitOrder{
		Force: order.StandingTiF,
		P:     order.Prefix{ServerTime: time.Now()},
		T: order.Trade{
			Sell:     true,
			Quantity: dcrBtcLotSize * 2,
		},
	}
	tracker := &trackedTrade{
		Order:  ord,
		preImg: newPreimage(),
		mktID:  tDcrBtcMktName,
		db:     rig.db,
		dc:     rig.dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusEpoch,
		},
	}
	rig.dc.trades[oids[0]] = tracker
	checkTradingLimits(2, 20)

	// Add another epoch order, 2 lots, likely taker, so 2x
	ord = &order.LimitOrder{
		Force: order.ImmediateTiF,
		P:     order.Prefix{ServerTime: time.Now()},
		T: order.Trade{
			Sell:     true,
			Quantity: dcrBtcLotSize * 2,
		},
	}
	tracker = &trackedTrade{
		Order:  ord,
		preImg: newPreimage(),
		mktID:  tDcrBtcMktName,
		db:     rig.db,
		dc:     rig.dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusEpoch,
		},
	}
	rig.dc.trades[oids[1]] = tracker
	checkTradingLimits(6, 20)

	// Add partially filled booked order
	ord = &order.LimitOrder{
		P: order.Prefix{ServerTime: time.Now()},
		T: order.Trade{
			Sell:     true,
			Quantity: dcrBtcLotSize * 2,
			FillAmt:  dcrBtcLotSize,
		},
	}
	tracker = &trackedTrade{
		Order:  ord,
		preImg: newPreimage(),
		mktID:  tDcrBtcMktName,
		db:     rig.db,
		dc:     rig.dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusBooked,
		},
	}
	rig.dc.trades[oids[2]] = tracker
	checkTradingLimits(7, 20)

	// Add settling match to the booked order
	tracker.matches = map[order.MatchID]*matchTracker{
		{0x01}: {
			MetaMatch: db.MetaMatch{
				UserMatch: &order.UserMatch{
					Quantity: dcrBtcLotSize,
				},
				MetaData: &db.MatchMetaData{
					Proof: db.MatchProof{},
				},
			},
		},
	}
	checkTradingLimits(8, 20)
}

func TestTakeAction(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	coinID := encode.RandomBytes(32)
	uniqueID := dex.Bytes(coinID).String()

	newMatch := func() *matchTracker {
		var matchID order.MatchID
		copy(matchID[:], encode.RandomBytes(32))
		return &matchTracker{
			MetaMatch: db.MetaMatch{
				UserMatch: &order.UserMatch{
					Status:  order.MatchComplete,
					MatchID: matchID,
					Side:    order.Taker,
				},
				MetaData: &db.MatchMetaData{},
			},
		}
	}
	rightMatch := newMatch()
	rightMatch.MetaData.Proof.TakerRedeem = coinID
	rightMatch.redemptionRejected = true

	wrongMatch := newMatch()
	wrongMatch.MetaData.Proof.TakerRedeem = encode.RandomBytes(31)

	makerMatch := newMatch()
	makerMatch.Status = order.MakerRedeemed
	makerMatch.MetaData.Proof.MakerRedeem = coinID
	makerMatch.Side = order.Maker

	tracker := &trackedTrade{
		matches: map[order.MatchID]*matchTracker{
			rightMatch.MatchID: rightMatch,
			wrongMatch.MatchID: wrongMatch,
			makerMatch.MatchID: makerMatch,
		},
	}

	var oid order.OrderID
	copy(oid[:], encode.RandomBytes(32))

	rig.dc.trades[oid] = tracker

	requestData := []byte(fmt.Sprintf(`{"orderID":"abcd","coinID":"%s","retry":true}`, dex.Bytes(coinID)))

	err := rig.core.TakeAction(0, ActionIDRedeemRejected, requestData)
	if err == nil {
		t.Fatalf("expected error for wrong order ID but got nothing")
	}

	rig.core.requestedActions[uniqueID] = nil
	requestData = []byte(fmt.Sprintf(`{"orderID":"%s","coinID":"%s","retry":false}`, oid, dex.Bytes(coinID)))

	err = rig.core.TakeAction(0, ActionIDRedeemRejected, requestData)
	if err != nil {
		t.Fatalf("error for retry=false: %v", err)
	}
	if len(rig.core.requestedActions) != 0 {
		t.Fatal("requested action not removed")
	}

	requestData = []byte(fmt.Sprintf(`{"orderID":"%s","coinID":"%s","retry":true}`, oid, dex.Bytes(coinID)))
	err = rig.core.TakeAction(0, ActionIDRedeemRejected, requestData)
	if err != nil {
		t.Fatalf("error for taker retry=true: %v", err)
	}

	if len(rightMatch.MetaData.Proof.TakerRedeem) != 0 {
		t.Fatalf("taker redemption not cleared")
	}
	if len(wrongMatch.MetaData.Proof.TakerRedeem) == 0 {
		t.Fatalf("wrong taker redemption cleared")
	}

	makerMatch.redemptionRejected = true
	err = rig.core.TakeAction(0, ActionIDRedeemRejected, requestData)
	if err != nil {
		t.Fatalf("error for maker retry=true: %v", err)
	}
	if len(makerMatch.MetaData.Proof.MakerRedeem) != 0 {
		t.Fatalf("maker redemption not cleared")
	}

}

func TestAuditContractCrossMatchDedup(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	lo, dbOrder, preImg, addr := makeLimitOrder(dc, true, 3*dcrBtcLotSize, dcrBtcRateStep*10)
	oid := lo.ID()

	dcrWallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	matchTime := time.Now()

	// Create two matches for the same order, each with a per-match swap address.
	mid1 := ordertest.RandomMatchID()
	secretHash1 := encode.RandomBytes(32)
	match1 := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{
				MatchID:  mid1,
				Side:     order.Maker,
				Address:  "counterparty1",
				Quantity: dcrBtcLotSize,
				Rate:     dcrBtcRateStep * 10,
				Status:   order.MakerSwapCast,
			},
			MetaData: &db.MatchMetaData{
				Proof: db.MatchProof{
					SecretHash: secretHash1,
					Secret:     encode.RandomBytes(32),
				},
				SwapAddr: addr,
			},
		},
		prefix: &lo.P,
		trade:  &lo.T,
	}
	tracker.matches[mid1] = match1

	mid2 := ordertest.RandomMatchID()
	secretHash2 := encode.RandomBytes(32)
	match2 := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{
				MatchID:  mid2,
				Side:     order.Maker,
				Address:  "counterparty2",
				Quantity: dcrBtcLotSize,
				Rate:     dcrBtcRateStep * 10,
				Status:   order.MakerSwapCast,
			},
			MetaData: &db.MatchMetaData{
				Proof: db.MatchProof{
					SecretHash: secretHash2,
					Secret:     encode.RandomBytes(32),
				},
				SwapAddr: addr,
			},
		},
		prefix: &lo.P,
		trade:  &lo.T,
	}
	tracker.matches[mid2] = match2

	auditQty := calc.BaseToQuote(dcrBtcRateStep*10, dcrBtcLotSize)
	coinID1 := encode.RandomBytes(36)
	contract1 := encode.RandomBytes(75)

	// Clear dedup maps.
	dc.activeContractsMtx.Lock()
	dc.activeCoinIDs = make(map[string]order.MatchID)
	dc.activeSecretHashes = make(map[string]order.MatchID)
	dc.matchCoinIDs = make(map[order.MatchID][]string)
	dc.matchSecretHashes = make(map[order.MatchID][]string)
	dc.activeContractsMtx.Unlock()

	// Audit match1 successfully.
	auditInfo1 := &asset.AuditInfo{
		Recipient:  addr,
		Coin:       &tCoin{id: coinID1, val: auditQty},
		Contract:   contract1,
		SecretHash: secretHash1,
		Expiration: matchTime.Add(tracker.lockTimeTaker),
	}
	tBtcWallet.auditInfo = auditInfo1

	err := tracker.auditContract(match1, coinID1, contract1, nil)
	if err != nil {
		t.Fatalf("match1 audit failed: %v", err)
	}

	// Try to audit match2 with the SAME CoinID AND contract - should fail.
	auditInfo2 := &asset.AuditInfo{
		Recipient:  addr,
		Coin:       &tCoin{id: coinID1, val: auditQty}, // same CoinID!
		Contract:   contract1,                          // same contract!
		SecretHash: secretHash2,
		Expiration: matchTime.Add(tracker.lockTimeTaker),
	}
	tBtcWallet.auditInfo = auditInfo2

	err = tracker.auditContract(match2, coinID1, contract1, nil)
	if err == nil {
		t.Fatal("expected error for duplicate contract across matches")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("expected 'already in use' error, got: %v", err)
	}

	// Same CoinID but different contract (EVM batch case) - should succeed.
	contract2 := encode.RandomBytes(75)
	auditInfo2b := &asset.AuditInfo{
		Recipient:  addr,
		Coin:       &tCoin{id: coinID1, val: auditQty}, // same CoinID
		Contract:   contract2,                          // different contract
		SecretHash: secretHash2,
		Expiration: matchTime.Add(tracker.lockTimeTaker),
	}
	tBtcWallet.auditInfo = auditInfo2b

	err = tracker.auditContract(match2, coinID1, contract2, nil)
	if err != nil {
		t.Fatalf("same CoinID with different contract (EVM batch) should succeed: %v", err)
	}

	// Clean up match2's dedup entries for subsequent tests.
	dc.releaseMatchCoinID(mid2)

	// Try match2 with same secret hash as match1 - should fail.
	coinID2 := encode.RandomBytes(36)
	auditInfo3 := &asset.AuditInfo{
		Recipient:  addr,
		Coin:       &tCoin{id: coinID2, val: auditQty},
		Contract:   encode.RandomBytes(75),
		SecretHash: secretHash1, // same secret hash!
		Expiration: matchTime.Add(tracker.lockTimeTaker),
	}
	tBtcWallet.auditInfo = auditInfo3

	err = tracker.auditContract(match2, coinID2, auditInfo3.Contract, nil)
	if err == nil {
		t.Fatal("expected error for duplicate secret hash across matches")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("expected 'already in use' error, got: %v", err)
	}

	// Same CoinID retried for same match (match1) - should succeed since
	// existingMatch == match.MatchID.
	auditInfo4 := &asset.AuditInfo{
		Recipient:  addr,
		Coin:       &tCoin{id: coinID1, val: auditQty},
		Contract:   contract1,
		SecretHash: secretHash1,
		Expiration: matchTime.Add(tracker.lockTimeTaker),
	}
	tBtcWallet.auditInfo = auditInfo4

	err = tracker.auditContract(match1, coinID1, contract1, nil)
	if err != nil {
		t.Fatalf("retry same CoinID for same match should succeed: %v", err)
	}
}

func TestReleaseMatchCoinID(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc

	mid1 := ordertest.RandomMatchID()
	mid2 := ordertest.RandomMatchID()

	// Register some CoinIDs and secret hashes.
	dc.activeContractsMtx.Lock()
	dc.activeCoinIDs["coinA"] = mid1
	dc.activeCoinIDs["coinB"] = mid1
	dc.activeCoinIDs["coinC"] = mid2
	dc.activeSecretHashes["hashA"] = mid1
	dc.activeSecretHashes["hashC"] = mid2
	dc.matchCoinIDs[mid1] = []string{"coinA", "coinB"}
	dc.matchCoinIDs[mid2] = []string{"coinC"}
	dc.matchSecretHashes[mid1] = []string{"hashA"}
	dc.matchSecretHashes[mid2] = []string{"hashC"}
	dc.activeContractsMtx.Unlock()

	// Release match1.
	dc.releaseMatchCoinID(mid1)

	dc.activeContractsMtx.Lock()
	// match1 entries should be gone.
	if _, exists := dc.activeCoinIDs["coinA"]; exists {
		t.Fatal("coinA not cleaned up")
	}
	if _, exists := dc.activeCoinIDs["coinB"]; exists {
		t.Fatal("coinB not cleaned up")
	}
	if _, exists := dc.activeSecretHashes["hashA"]; exists {
		t.Fatal("hashA not cleaned up")
	}
	if _, exists := dc.matchCoinIDs[mid1]; exists {
		t.Fatal("matchCoinIDs[mid1] not cleaned up")
	}
	if _, exists := dc.matchSecretHashes[mid1]; exists {
		t.Fatal("matchSecretHashes[mid1] not cleaned up")
	}
	// match2 entries should still exist.
	if _, exists := dc.activeCoinIDs["coinC"]; !exists {
		t.Fatal("coinC incorrectly removed")
	}
	if _, exists := dc.activeSecretHashes["hashC"]; !exists {
		t.Fatal("hashC incorrectly removed")
	}
	dc.activeContractsMtx.Unlock()
}

func TestIsSwappableGatedOnCounterPartyAddr(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, dcrBtcLotSize, dcrBtcRateStep*10)
	oid := lo.ID()

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	mid := ordertest.RandomMatchID()
	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{
				MatchID:  mid,
				Side:     order.Maker,
				Address:  "counterparty-addr",
				Quantity: dcrBtcLotSize,
				Rate:     dcrBtcRateStep * 10,
				Status:   order.NewlyMatched,
			},
			MetaData: &db.MatchMetaData{
				Proof: db.MatchProof{
					Secret:     encode.RandomBytes(32),
					SecretHash: encode.RandomBytes(32),
					Auth: db.MatchAuth{
						MatchStamp: uint64(time.Now().UnixMilli()),
					},
				},
				// SwapAddr is set (we sent per-match addr) but
				// CounterPartyAddr not yet received.
				SwapAddr: "our-per-match-addr",
			},
		},
		prefix:        &lo.P,
		trade:         &lo.T,
		lastExpireDur: 365 * 24 * time.Hour,
	}
	tracker.matches[mid] = match

	// Fund the wallet so we don't fail on funding checks.
	tDcrWallet.bal = &asset.Balance{Available: 1e16}

	ready, retry := tracker.isSwappable(tCore.ctx, match)
	if ready {
		t.Fatal("isSwappable should return false when CounterPartyAddr is empty")
	}
	if retry {
		t.Fatal("retry should be false")
	}

	// Now set the counterparty address.
	match.MetaData.CounterPartyAddr = "counterparty-per-match-addr"

	// With the counterparty address set, the gate should no longer block.
	ready, _ = tracker.isSwappable(tCore.ctx, match)
	if !ready {
		t.Fatal("isSwappable should return true after CounterPartyAddr is set")
	}
}

func TestParseMatchesPerMatchAddr(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, 3*dcrBtcLotSize, dcrBtcRateStep*10)
	oid := lo.ID()

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	// Make TXCWallet.RedemptionAddress return a known address.
	tBtcWallet.redemptionAddr = "per-match-addr-1"
	tBtcWallet.validAddr = true
	tBtcWallet.addrErr = nil

	matchTime := time.Now()
	mid := ordertest.RandomMatchID()
	msgMatch := &msgjson.Match{
		OrderID:    oid[:],
		MatchID:    mid[:],
		Quantity:   dcrBtcLotSize,
		Rate:       dcrBtcRateStep * 10,
		Address:    "counterparty-address",
		Side:       uint8(order.Maker),
		ServerTime: uint64(matchTime.UnixMilli()),
	}
	sign(tDexPriv, msgMatch)

	matches, acks, err := dc.parseMatches([]*msgjson.Match{msgMatch}, true)
	if err != nil {
		t.Fatalf("parseMatches error: %v", err)
	}
	if len(acks) != 1 {
		t.Fatalf("expected 1 ack, got %d", len(acks))
	}

	// The ack should contain the per-match address.
	if acks[0].Address == "" {
		t.Fatal("expected per-match address in ack, got empty")
	}

	// The serverMatches should have the per-match address stored.
	for _, sm := range matches {
		if len(sm.perMatchAddrs) == 0 {
			t.Fatal("perMatchAddrs not populated")
		}
		var matchID order.MatchID
		copy(matchID[:], mid[:])
		if sm.perMatchAddrs[matchID.String()] == "" {
			t.Fatal("per-match addr not stored for match")
		}
	}

	// Test RedemptionAddress error.
	tBtcWallet.addrErr = tErr
	_, _, err = dc.parseMatches([]*msgjson.Match{msgMatch}, true)
	// parseMatches returns errors as a joined string, not as an error return.
	// But the match should be skipped and not appear in the acks.
	// Actually, parseMatches returns the error string. Let me check the
	// actual behavior.
	if err == nil {
		t.Fatal("expected error when RedemptionAddress fails")
	}

	_ = tDcrWallet // silence unused
}

// TestTradePerMatchAddr exercises the per-match address flow end-to-end:
// 1. handleMatchRoute generates per-match addresses
// 2. handleCounterPartyAddressMsg delivers the counterparty's per-match address
// 3. isSwappable gates on the counterparty address
// 4. The swap contract uses the counterparty's per-match address
func TestTradePerMatchAddr(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, dcrBtcLotSize, dcrBtcRateStep*10)
	oid := lo.ID()

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tDcrWallet.validAddr = true // fromWallet validates counterparty addresses
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker
	tracker.coinsLocked = true

	// Set the wallet to return per-match addresses.
	tBtcWallet.redemptionAddr = "our-per-match-addr"
	tBtcWallet.validAddr = true
	tBtcWallet.addrErr = nil

	// Step 1: Call parseMatches to generate per-match addresses.
	matchTime := time.Now()
	mid := ordertest.RandomMatchID()
	msgMatch := &msgjson.Match{
		OrderID:    oid[:],
		MatchID:    mid[:],
		Quantity:   dcrBtcLotSize,
		Rate:       dcrBtcRateStep * 10,
		Address:    "counterparty-order-level-addr",
		Side:       uint8(order.Maker),
		ServerTime: uint64(matchTime.UnixMilli()),
	}
	sign(tDexPriv, msgMatch)

	matches, acks, err := dc.parseMatches([]*msgjson.Match{msgMatch}, true)
	if err != nil {
		t.Fatalf("parseMatches error: %v", err)
	}
	if acks[0].Address != "our-per-match-addr" {
		t.Fatalf("expected per-match addr %q in ack, got %q",
			"our-per-match-addr", acks[0].Address)
	}

	// Step 2: Call negotiate to store the match with per-match address.
	for _, sm := range matches {
		tracker.negotiate(sm.msgMatches, sm.perMatchAddrs)
	}

	tracker.mtx.RLock()
	match := tracker.matches[mid]
	tracker.mtx.RUnlock()
	if match == nil {
		t.Fatal("match not found after negotiate")
	}
	if match.MetaData.SwapAddr != "our-per-match-addr" {
		t.Fatalf("expected SwapAddr %q, got %q",
			"our-per-match-addr", match.MetaData.SwapAddr)
	}

	// Step 3: Verify isSwappable blocks before counterparty address arrives.
	tDcrWallet.bal = &asset.Balance{Available: 1e16}
	ready, _ := tracker.isSwappable(tCore.ctx, match)
	if ready {
		t.Fatal("isSwappable should block when CounterPartyAddr is empty")
	}

	// Step 4: Deliver counterparty's per-match address.
	cpa := &msgjson.CounterPartyAddress{
		OrderID: oid[:],
		MatchID: mid[:],
		Address: "counterparty-per-match-addr",
	}
	sign(tDexPriv, cpa)
	cpaMsg, _ := msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa)
	if err := handleCounterPartyAddressMsg(tCore, dc, cpaMsg); err != nil {
		t.Fatalf("handleCounterPartyAddressMsg error: %v", err)
	}

	tracker.mtx.RLock()
	gotAddr := match.MetaData.CounterPartyAddr
	tracker.mtx.RUnlock()
	if gotAddr != "counterparty-per-match-addr" {
		t.Fatalf("expected CounterPartyAddr %q, got %q",
			"counterparty-per-match-addr", gotAddr)
	}

	// Step 5: isSwappable should no longer be blocked by the address gate.
	// (It may still return false for other reasons like wallet state, but
	// the per-match address gate should not be the blocker.)
	ready, _ = tracker.isSwappable(tCore.ctx, match)
	// With a funded maker at NewlyMatched status, isSwappable should now
	// return true since the address gate is satisfied.
	if !ready {
		t.Fatal("isSwappable should pass after CounterPartyAddr is set")
	}

	_ = tBtcWallet
}
