//go:build !harness && !botlive

package core

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/comms"
	"decred.org/dcrdex/client/db"
	"decred.org/dcrdex/dex/encode"
	"decred.org/dcrdex/dex/encrypt"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
	"decred.org/dcrdex/server/account"
)

func TestCredentialsUpgrade(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.db.legacyKeyErr = nil

	clearUpgrade := func() {
		rig.db.creds.EncInnerKey = nil
		tCore.credentials.EncInnerKey = nil
	}

	clearUpgrade()

	// initial success
	err := tCore.Login(tPW)
	if err != nil {
		t.Fatalf("initial Login error: %v", err)
	}

	clearUpgrade()

	// Recrypt error
	rig.db.recryptErr = tErr
	err = tCore.Login(tPW)
	if err == nil {
		t.Fatalf("no error for recryptErr")
	}
	rig.db.recryptErr = nil

	// final success
	err = tCore.Login(tPW)
	if err != nil {
		t.Fatalf("final Login error: %v", err)
	}
}

func TestLogin(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.acct.rep = account.Reputation{BondedTier: 1}

	rig.queueConnect(nil, nil, nil)
	err := tCore.Login(tPW)
	// Login spawns a background goroutine (LI-ASYNC) that runs
	// initializeDEXConnections + resolveActiveTrades. Wait for it to
	// finish before asserting on post-auth state.
	tCore.loginWG.Wait()
	if err != nil || !rig.acct.authed() {
		t.Fatalf("initial Login error: %v", err)
	}

	// No encryption key.
	unauth(rig.acct)
	creds := tCore.credentials
	tCore.credentials = nil
	err = tCore.Login(tPW)
	tCore.loginWG.Wait()
	if err == nil || rig.acct.authed() {
		t.Fatalf("no error for missing app key")
	}
	tCore.credentials = creds

	// Account not Paid. No error, and account should be unlocked.
	// (Second Login when already `loggedIn=true` is a no-op; the
	// background goroutine is NOT re-spawned, so authed stays false
	// from the preceding unauth. loginWG.Wait() is still cheap.)
	rig.acct.rep = account.Reputation{BondedTier: 0}
	rig.queueConnect(nil, nil, nil)
	err = tCore.Login(tPW)
	tCore.loginWG.Wait()
	if err != nil || rig.acct.authed() {
		t.Fatalf("error for unpaid account: %v", err)
	}
	if rig.acct.locked() {
		t.Fatalf("unpaid account is locked")
	}
	rig.acct.rep = account.Reputation{BondedTier: 1}

	// 'connect' route error.
	rig = newTestRig()
	defer rig.shutdown()
	tCore = rig.core
	unauth(rig.acct)
	rig.ws.queueResponse(msgjson.ConnectRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, nil, msgjson.NewError(1, "test error"))
		f(resp)
		return nil
	})
	err = tCore.Login(tPW)
	tCore.loginWG.Wait()
	// Should be no error, but also not authed. Error is sent and logged
	// as a notification.
	if err != nil || rig.acct.authed() {
		t.Fatalf("account authed after 'connect' error")
	}

	// Success with some matches in the response.
	rig = newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	qty := 3 * dcrBtcLotSize
	lo, dbOrder, preImg, addr := makeLimitOrder(dc, true, qty, dcrBtcRateStep*10)
	lo.Force = order.StandingTiF
	dbOrder.MetaData.Status = order.OrderStatusBooked // leave unfunded to have it canceled on auth/'connect'
	oid := lo.ID()
	dcrWallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	tBtcWallet.redemptionAddr = addr
	tBtcWallet.validAddr = true
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg) // nil means no funding coins
	matchID := ordertest.RandomMatchID()
	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: matchID},
			MetaData:  &db.MatchMetaData{},
		},
	}
	tracker.matches[matchID] = match
	knownMsgMatch := &msgjson.Match{OrderID: oid[:], MatchID: matchID[:]}

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
	matchTime := time.Now()
	extraMsgMatch := &msgjson.Match{
		OrderID:    oid[:],
		MatchID:    extraID[:],
		Side:       uint8(order.Taker),
		Status:     uint8(order.MakerSwapCast),
		ServerTime: uint64(matchTime.UnixMilli()),
	}

	// The extra match is already at MakerSwapCast, and we're the taker, which
	// will invoke match status conflict resolution and a contract audit.
	_, auditInfo := tMsgAudit(oid, extraID, addr, qty, encode.RandomBytes(32))
	auditInfo.Expiration = encode.DropMilliseconds(matchTime.Add(tracker.lockTimeMaker))
	tBtcWallet.auditInfo = auditInfo
	missedContract := encode.RandomBytes(50)
	rig.ws.queueResponse(msgjson.MatchStatusRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, []*msgjson.MatchStatusResult{{
			MatchID:       extraID[:],
			Status:        uint8(order.MakerSwapCast),
			MakerContract: missedContract,
			MakerSwap:     auditInfo.Coin.ID(),
			Active:        true,
			MakerTxData:   []byte{0x01},
		}}, nil)
		f(resp)
		return nil
	})

	dc.trades = map[order.OrderID]*trackedTrade{
		oid: tracker,
	}

	tCore = rig.core
	rig.queueConnect(nil, []*msgjson.Match{knownMsgMatch /* missing missingMatch! */, extraMsgMatch}, nil)
	rig.queueCancel(nil) // for the unfunded order that gets canceled in authDEX
	// Login>authDEX will do 4 match DB updates for these two matches:
	// missing -> revoke -> update match
	// extra -> negotiate -> newTrackers -> update match
	// matchConflicts (from extras) -> resolveMatchConflicts -> resolveConflictWithServerData
	// 	-> update match after spawning auditContract
	// 	-> update match in auditContract (second because of lock) ** the ASYNC one we have to wait for **
	rig.db.updateMatchChan = make(chan order.MatchStatus, 4)
	err = tCore.Login(tPW) // authDEX -> async contract audit for the extra match
	// Wait for the outer Login goroutine (Phase 1 auth + resolveActiveTrades)
	// before checking authed; the deferred Phase 2 `authDEXTail` goroutines
	// that produce the 4 match DB updates below are tracked by c.wg instead
	// and the channel reads serve as their sync point.
	tCore.loginWG.Wait()
	if err != nil || !rig.acct.authed() {
		t.Fatalf("final Login error: %v", err)
	}
	// Wait for expected db updates.
	for i := 0; i < 4; i++ {
		<-rig.db.updateMatchChan
	}

	// check t.metaData.LinkedOrder or for db.LinkOrder call, then db.UpdateOrder call
	if tracker.metaData.LinkedOrder.IsZero() {
		t.Errorf("cancel order not set")
	}
	if rig.db.linkedFromID != oid || rig.db.linkedToID.IsZero() {
		t.Errorf("automatic cancel order not linked")
	}

	if !tracker.matches[missingID].MetaData.Proof.SelfRevoked {
		t.Errorf("SelfRevoked not true for missing match tracker")
	}
	if tracker.matches[matchID].swapErr != nil {
		t.Errorf("swapErr set for non-missing match tracker")
	}
	if tracker.matches[matchID].MetaData.Proof.IsRevoked() {
		t.Errorf("IsRevoked true for non-missing match tracker")
	}
	// Conflict resolution will have run negotiate on the extra match from the
	// connect response, bringing our match count up to 3.
	if len(tracker.matches) != 3 {
		t.Errorf("Extra trade not accepted into matches")
	}
	tracker.mtx.Lock()
	defer tracker.mtx.Unlock()
	match = tracker.matches[extraID]
	if !bytes.Equal(match.MetaData.Proof.CounterContract, missedContract) {
		t.Errorf("Missed maker contract not retrieved, %s, %s", match, hex.EncodeToString(match.MetaData.Proof.CounterContract))
	}
}

func TestAccountNotFoundError(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.acct.rep = account.Reputation{BondedTier: 1}

	const expectedErrorMessage = "test account not found error"
	accountNotFoundError := msgjson.NewError(msgjson.AccountNotFoundError, expectedErrorMessage)
	rig.queueConnect(accountNotFoundError, nil, nil)
	rig.queueConnect(accountNotFoundError, nil, nil)

	wallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = wallet
	rig.queueConnect(nil, nil, nil)

	feed := tCore.NotificationFeed()

	tCore.initializeDEXConnections(rig.crypter, nil)

	// Make sure that the connections did not get authenticated
	for _, dc := range tCore.dexConnections() {
		if dc.acct.authed() {
			t.Fatalf("dex connection should not have been authenticated")
		}
	}

	// Make sure that an error notification was sent
	for {
		select {
		case note := <-feed.C:
			if note.Topic() == TopicDexAuthError && strings.Contains(note.Details(), expectedErrorMessage) {
				return
			}
		case <-time.After(1 * time.Second):
			t.Fatalf("error notification could not be found")
		}
	}
}

func TestInitializeDEXConnectionsSuccess(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.acct.rep = account.Reputation{BondedTier: 1}
	rig.queueConnect(nil, nil, nil)

	// Make sure that the connections got authenticated
	tCore.initializeDEXConnections(rig.crypter, nil)
	for _, dc := range tCore.dexConnections() {
		if !dc.acct.authed() {
			t.Fatalf("dex connection was not authenticated")
		}
	}
}

func TestConnectDEX(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	ai := &db.AccountInfo{
		Host: "somedex.com",
	}

	_, err := tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("expected error for no TLS plain internet DEX host")
	}

	ai.Host = "somedex13254214214.onion" // not a valid onion host in case we decide to validate them
	// No onion proxy set => error
	_, err = tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("expected error with no onion proxy set")
	}

	rig.queueConfig()
	tCore.cfg.Onion = "127.0.0.1:9050"
	dc, err := tCore.connectDEX(ai)
	if err != nil {
		t.Fatalf("error connecting to onion host with an onion proxy configured: %v", err)
	}
	dc.connMaster.Disconnect()

	rig.queueConfig()
	ai.Host = "somedex.com"
	ai.Cert = []byte{0x1}
	dc, err = tCore.connectDEX(ai)
	if err != nil {
		t.Fatalf("initial connectDEX error: %v", err)
	}
	dc.connMaster.Disconnect()

	// Bad URL.
	ai.Host = tUnparseableHost // Illegal ASCII control character
	_, err = tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("no error for bad URL")
	}
	ai.Host = "someotherdex.org"

	// Constructor error.
	ogConstructor := tCore.wsConstructor
	tCore.wsConstructor = func(*comms.WsCfg) (comms.WsConn, error) {
		return nil, tErr
	}
	_, err = tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("no error for WsConn constructor error")
	}
	tCore.wsConstructor = ogConstructor

	// WsConn.Connect error.
	rig.ws.connectErr = tErr
	_, err = tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("no error for WsConn.Connect error")
	}

	rig.ws.connectErr = nil

	// 'config' route error.
	rig.ws.queueResponse(msgjson.ConfigRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, nil, msgjson.NewError(1, "test error"))
		f(resp)
		return nil
	})
	_, err = tCore.connectDEX(ai)
	if err == nil {
		t.Fatalf("no error for 'config' route error")
	}

	// Success again.
	rig.queueConfig()
	dc, err = tCore.connectDEX(ai)
	if err != nil {
		t.Fatalf("final connectDEX error: %v", err)
	}
	dc.connMaster.Disconnect()

	// TODO: test temporary, ensure listen isn't running, somehow
}

func TestInitializeClient(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	clearCreds := func() {
		tCore.credentials = nil
		rig.db.creds = nil
	}

	clearCreds()

	_, err := tCore.InitializeClient(tPW, nil)
	if err != nil {
		t.Fatalf("InitializeClient error: %v", err)
	}

	clearCreds()

	// Empty password.
	emptyPass := []byte("")
	_, err = tCore.InitializeClient(emptyPass, nil)
	if err == nil {
		t.Fatalf("no error for empty password")
	}

	// Store error. Use a non-empty password to pass empty password check.
	rig.db.setCredsErr = tErr
	_, err = tCore.InitializeClient(tPW, nil)
	if err == nil {
		t.Fatalf("no error for StoreEncryptedKey error")
	}
	rig.db.setCredsErr = nil

	// Success again
	_, err = tCore.InitializeClient(tPW, nil)
	if err != nil {
		t.Fatalf("final InitializeClient error: %v", err)
	}
}

func TestResolveActiveTrades(t *testing.T) {
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

	// reset
	reset := func() {
		rig.acct.lock()
		btcWallet.Lock(time.Second)
		ethWallet.Lock(time.Second)
		tEthWallet.reservedRedemption = 0
		tEthWallet.reservedRefund = 0

		rig.dc.trades = make(map[order.OrderID]*trackedTrade)
	}

	// Ensure the order is good, and reset the state.
	runTest := func(tag string, expAddedToTradesMap, expReadyToTick, expBTCUnlocked, expETHUnlocked bool, expCoinsLoaded int) {
		t.Helper()
		defer reset()

		description := fmt.Sprintf("%s: side = %s, order status = %s, match status = %s",
			tag, match.Side, dbOrder.MetaData.Status, match.Status)
		tCore.loginMtx.Lock()
		tCore.loggedIn = false
		tCore.loginMtx.Unlock()
		err := tCore.Login(tPW)
		if err != nil {
			t.Fatalf("%s: login error: %v", description, err)
		}
		// Login's background goroutine populates dc.trades via
		// resolveActiveTrades; wait for it before inspecting the map.
		tCore.loginWG.Wait()

		trade, found := rig.dc.trades[lo.ID()]
		if expAddedToTradesMap != found {
			t.Fatalf("%s: expected added to trades map = %v, but got %v. len(trades) = %d", description, expAddedToTradesMap, found, len(rig.dc.trades))
		}
		if !expAddedToTradesMap {
			return
		}

		if expBTCUnlocked != btcWallet.unlocked() {
			t.Fatalf("%s: btc wallet unlocked = %v but got %v", description, expBTCUnlocked, btcWallet.unlocked())
		}

		if expETHUnlocked != ethWallet.unlocked() {
			t.Fatalf("%s: eth wallet unlocked = %v but got %v", description, expETHUnlocked, ethWallet.unlocked())
		}

		_, found = trade.matches[match.MatchID]
		if !found {
			t.Fatalf("%s: trade with expected order id not found. len(matches) = %d", description, len(trade.matches))
		}

		if len(trade.coins) != expCoinsLoaded {
			t.Fatalf("%s: expected %d coin loaded, got %d", description, expCoinsLoaded, len(trade.coins))
		}

		if found && expReadyToTick != trade.readyToTick {
			t.Fatalf("%s: expected ready to tick = %v, but got %v", description, expReadyToTick, trade.readyToTick)
		}
		if !expReadyToTick {
			return
		}

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

	}

	runTest("initial", true, true, true, true, 1)

	// No base wallet. Trade will not be in the map.
	delete(tCore.wallets, utxoAsset.ID)
	runTest("no base wallet", false, false, false, false, 0)
	tCore.wallets[utxoAsset.ID] = btcWallet

	// Base wallet unlock errors. Trade will be in map, but it will not be
	// ready to tick.
	tBtcWallet.unlockErr = tErr
	tBtcWallet.locked = true
	runTest("base unlock", true, false, false, false, 0)
	tBtcWallet.unlockErr = nil
	tBtcWallet.locked = false

	// No quote wallet. Trade will not be in the map.
	delete(tCore.wallets, acctAsset.ID)
	runTest("missing quote", false, false, false, false, 0)
	tCore.wallets[acctAsset.ID] = ethWallet

	// Quote wallet unlock errors. Trade will be in map, but it will not be
	// ready to tick.
	tEthWallet.unlockErr = tErr
	tEthWallet.locked = true
	runTest("quote unlock", true, false, true, false, 0)
	tEthWallet.unlockErr = nil
	tEthWallet.locked = false

	// Funding coin error still puts it in the trades map, and sets ready to tick,
	// just with no coins locked.
	tBtcWallet.fundingCoinErr = tErr
	runTest("funding coin", true, true, true, true, 0)
	tBtcWallet.fundingCoinErr = nil

	// No matches
	rig.db.activeMatchOIDSErr = tErr
	runTest("matches error", false, false, false, false, 0)
	rig.db.activeMatchOIDSErr = nil

	for _, tt := range reservationTests {
		lo.T.Sell = tt.sell
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
					runTest(tt.name, true, true, true, true, tt.expectedCoins)
				}
			}
		}
	}
}

func TestLogout(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	dcrWallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet

	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet

	ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
	tracker := &trackedTrade{
		Order:  ord,
		preImg: newPreimage(),
		dc:     rig.dc,
		metaData: &db.OrderMetaData{
			Status: order.OrderStatusBooked,
		},
		matches: make(map[order.MatchID]*matchTracker),
	}
	rig.dc.trades[ord.ID()] = tracker

	ensureErr := func(tag string) {
		t.Helper()

		tCore.loginMtx.Lock()
		tCore.loggedIn = true
		tCore.loginMtx.Unlock()

		err := tCore.Logout(false)
		if err == nil {
			t.Fatalf("%s: no error", tag)
		}
	}

	// Active orders error.
	ensureErr("active orders")

	tracker.metaData = &db.OrderMetaData{
		Status: order.OrderStatusExecuted,
	}
	mid := ordertest.RandomMatchID()
	tracker.matches[mid] = &matchTracker{
		MetaMatch: db.MetaMatch{
			MetaData: &db.MatchMetaData{},
			UserMatch: &order.UserMatch{
				OrderID: ord.ID(),
				MatchID: mid,
				Status:  order.NewlyMatched,
				Side:    order.Maker,
			},
		},
		prefix:          ord.Prefix(),
		trade:           ord.Trade(),
		counterConfirms: -1,
	}
	// Active orders with matches error.
	ensureErr("active orders matches")
	rig.dc.trades = nil
}

func TestChangeAppPass(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	// Use the smarter crypter.
	smartCrypter := newTCrypterSmart()
	rig.crypter = smartCrypter
	rig.core.newCrypter = func([]byte) encrypt.Crypter { return newTCrypterSmart() }
	rig.core.reCrypter = func([]byte, []byte) (encrypt.Crypter, error) { return rig.crypter, smartCrypter.recryptErr }

	tCore := rig.core
	newTPW := []byte("apppass")

	// App Password error
	rig.crypter.(*tCrypterSmart).recryptErr = tErr
	err := tCore.ChangeAppPass(tPW, newTPW)
	if !errorHasCode(err, authErr) {
		t.Fatalf("wrong error for password error: %v", err)
	}
	rig.crypter.(*tCrypterSmart).recryptErr = nil

	oldCreds := tCore.credentials

	rig.db.creds = nil
	err = tCore.ChangeAppPass(tPW, newTPW)
	if err != nil {
		t.Fatal(err)
	}

	if bytes.Equal(oldCreds.OuterKeyParams, tCore.credentials.OuterKeyParams) {
		t.Fatalf("credentials not updated in Core")
	}

	if rig.db.creds == nil || !bytes.Equal(tCore.credentials.OuterKeyParams, rig.db.creds.OuterKeyParams) {
		t.Fatalf("credentials not updated in DB")
	}
}

func TestResetAppPass(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	crypter := newTCrypterSmart()
	rig.crypter = crypter
	rig.core.newCrypter = func([]byte) encrypt.Crypter { return crypter }
	rig.core.reCrypter = func([]byte, []byte) (encrypt.Crypter, error) { return rig.crypter, crypter.recryptErr }

	rig.core.credentials = nil
	rig.core.InitializeClient(tPW, nil)

	tCore := rig.core
	seed, err := tCore.ExportSeed(tPW)
	if err != nil {
		t.Fatalf("seed export failed: %v", err)
	}

	// Invalid seed error
	invalidSeed := seed[:24]
	err = tCore.ResetAppPass(tPW, invalidSeed)
	if !strings.Contains(err.Error(), "unabled to decode provided seed") {
		t.Fatalf("wrong error for invalid seed length: %v", err)
	}

	// Want incorrect seed error.
	rig.crypter.(*tCrypterSmart).recryptErr = tErr
	// tCrypter is used to encode the orginal seed but we don't need it here, so
	// we need to add 8 bytes to commplete the expected seed lenght(64).
	err = tCore.ResetAppPass(tPW, seed+"blah")
	if !strings.Contains(err.Error(), "unabled to decode provided seed") {
		t.Fatalf("wrong error for incorrect seed: %v", err)
	}

	// ok, no crypter error.
	rig.crypter.(*tCrypterSmart).recryptErr = nil
	err = tCore.ResetAppPass(tPW, seed)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRefreshServerConfig(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	// Add an API version to supportedAPIVers to use in tests.
	const newAPIVer = ^uint16(0) - 1
	supportedAPIVers = append(supportedAPIVers, int32(newAPIVer))

	queueConfig := func(err *msgjson.Error, apiVer uint16) {
		rig.ws.queueResponse(msgjson.ConfigRoute, func(msg *msgjson.Message, f msgFunc) error {
			cfg := *rig.dc.cfg
			cfg.APIVersion = apiVer
			resp, _ := msgjson.NewResponse(msg.ID, cfg, err)
			f(resp)
			return nil
		})
	}
	tests := []struct {
		name       string
		configErr  *msgjson.Error
		gotAPIVer  uint16
		marketBase uint32
		wantErr    bool
	}{{
		name:       "ok",
		marketBase: tUTXOAssetA.ID,
		gotAPIVer:  newAPIVer,
	}, {
		name:      "unable to fetch config",
		configErr: new(msgjson.Error),
		wantErr:   true,
	}, {
		name:       "api not in wanted versions",
		gotAPIVer:  ^uint16(0),
		marketBase: tUTXOAssetA.ID,
		wantErr:    true,
	}, {
		name:       "generate maps failure",
		marketBase: ^uint32(0),
		gotAPIVer:  newAPIVer,
		wantErr:    true,
	}}

	for _, test := range tests {
		rig.dc.cfg.Markets[0].Base = test.marketBase
		queueConfig(test.configErr, test.gotAPIVer)
		_, err := rig.dc.refreshServerConfig()
		if test.wantErr {
			if err == nil {
				t.Fatalf("expected error for test %q", test.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("unexpected error for test %q: %v", test.name, err)
		}
	}
}

func TestCredentialHandling(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	clearCreds := func() {
		tCore.credentials = nil
		rig.db.creds = nil
	}

	clearCreds()
	tCore.newCrypter = encrypt.NewCrypter
	tCore.reCrypter = encrypt.Deserialize

	_, err := tCore.InitializeClient(tPW, nil)
	if err != nil {
		t.Fatalf("InitializeClient error: %v", err)
	}

	// Since the actual encrypt package crypter is now used instead of the dummy
	// tCrypter, the acct.encKey should be updated to reflect acct.privKey.
	// Although the test does not rely on this, we should keep the dexAccount
	// self-consistent and avoid confusing messages in the test log.
	err = rig.resetAcctEncKey(tPW)
	if err != nil {
		t.Fatalf("InitializeClient error: %v", err)
	}

	tCore.Logout(false)

	err = tCore.Login(tPW)
	if err != nil {
		t.Fatalf("Login error: %v", err)
	}
	// NOTE: a warning note is expected. "Wallet connection warning - Incomplete
	// registration detected for somedex.tld:7232, but failed to connect to the
	// Decred wallet"
}
