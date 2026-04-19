//go:build !harness && !botlive

package core

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/server/account"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

func TestPostBond(t *testing.T) {
	// This test takes a little longer because the key is decrypted every time
	// Register is called.
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc
	clearConn := func() {
		tCore.connMtx.Lock()
		delete(tCore.conns, tDexHost)
		tCore.connMtx.Unlock()
	}
	clearConn()

	wallet, tWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = wallet
	tWallet.bal = &asset.Balance{
		Available: 4e9,
	}

	// When registering, successfully retrieving *db.AccountInfo from the DB is
	// an error (no dupes). Initial state is to return an error.
	rig.db.acctErr = tErr

	_ = tCore.Login(tPW)
	// Drain the Login background goroutine before subscribing to the
	// notification feed below — otherwise the LoginNote stream
	// ("Resuming active trades...", "Connecting to DEX servers...")
	// leaks into the feed and trips the bond/balance note matcher.
	tCore.loginWG.Wait()

	// (*Core).Register does setupCryptoV2 to make the dc.acct.privKey etc., so
	// we don't know the ClientPubKey here. It must be set in the request
	// handler configured by queueRegister.
	rig.ws.liveBondExpiry = uint64(time.Now().Add(time.Duration(pendingBuffer(dex.Simnet)) * 2 * time.Second).Unix())
	postBondResult := &msgjson.PostBondResult{
		AccountID:  rig.acct.id[:],
		AssetID:    dcrBondAsset.ID,
		Amount:     dcrBondAsset.Amt,
		Expiry:     rig.ws.liveBondExpiry,
		Reputation: &account.Reputation{BondedTier: 1},
	}

	var wg sync.WaitGroup
	defer wg.Wait() // don't allow fail after TestRegister return

	queueTipChange := func() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			timeout := time.NewTimer(time.Second * 2)
			defer timeout.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					tCore.waiterMtx.Lock()
					waiterCount := len(tCore.blockWaiters)
					tCore.waiterMtx.Unlock()

					// Every tick, increase the bond tx confirmation count.
					if waiterCount > 0 { // when verifyRegistrationFee adds a waiter, then we can trigger tip change
						confs, found := tWallet.confs[dex.Bytes(tWallet.bondTxCoinID).String()]
						if !found {
							tWallet.setConfs(tWallet.bondTxCoinID, 0, nil)
						} else {
							tWallet.setConfs(tWallet.bondTxCoinID, confs+1, nil)
						}

						tCore.tipChange(tUTXOAssetA.ID, 100)
						return
					}
				case <-timeout.C:
					t.Errorf("failed to find waiter before timeout")
					return
				}
			}
		}()
	}

	accountNotFoundError := msgjson.NewError(msgjson.AccountNotFoundError, "test account not found error")

	queueConfigAndConnectUnknownAcct := func() {
		rig.ws.submittedBond = nil
		rig.queueConfig()
		rig.queueConnect(accountNotFoundError, nil, nil) // for discoverAccount
		rig.ws.queueResponse(msgjson.FeeRateRoute, func(msg *msgjson.Message, f msgFunc) error {
			const feeRate = 50
			resp, _ := msgjson.NewResponse(msg.ID, feeRate, nil)
			f(resp)
			return nil
		})
	}

	queuePostBondSequence := func() {
		rig.queuePrevalidateBond()
		rig.queuePostBond(postBondResult)
		queueTipChange()
		rig.queueConnect(nil, nil, nil)
	}

	queueResponses := func() {
		queueConfigAndConnectUnknownAcct()
		queuePostBondSequence()
	}

	form := &PostBondForm{
		Addr:    tDexHost,
		AppPass: tPW,
		Asset:   &dcrBondAsset.ID,
		Bond:    dcrBondAsset.Amt,
		Cert:    []byte{0x1}, // not empty signals TLS, otherwise no TLS allowed hidden services
	}

	// Suppress warnings about SendTransaction returning a mismatching ID.
	tWallet.feeCoinSent = tWallet.bondTxCoinID

	ch := tCore.NotificationFeed()

	var err error
	run := func() {
		// Register method will error if url is already in conns map.
		clearConn()

		tWallet.setConfs(tWallet.bondTxCoinID, 0, nil)
		// Skip finding bonds.
		tWallet.findBondErr = errors.New("purposeful error")
		_, err = tCore.PostBond(form)
	}

	getNotification := func(tag string) any {
		t.Helper()
		select {
		case n := <-ch.C:
			return n
			// When it works, it should be virtually instant, but I have seen it fail
			// at 1 millisecond.
		case <-time.NewTimer(time.Second * 2).C:
			t.Fatalf("timed out waiting for %s notification", tag)
		}
		return nil
	}

	// The feepayment note for mined fee payment txn notification to server, and
	// the balance note from tip change are concurrent and thus come in no
	// guaranteed order.
	getBondAndBalanceNote := func() {
		t.Helper()
		var bondNote *BondPostNote
		var balanceNotes uint8
		// For a normal PostBond, there are three balance updates.
		// 1) makeAndPostBond, 2) monitorBondConfs.trigger, and 3) tipChange.
		for bondNote == nil || balanceNotes < 3 {
			ntfn := getNotification("bond posted or balance")
			switch note := ntfn.(type) {
			case *BondPostNote:
				if note.TopicID == TopicAccountRegistered {
					bondNote = note
				}
			case *BalanceNote:
				balanceNotes++
			case *ReputationNote: // ignore
			default:
				t.Fatalf("wrong notification (%T). Expected FeePaymentNote or BalanceNote", ntfn)
			}
		}
	}

	queueResponses()
	run()
	if err != nil {
		t.Fatalf("postbond error: %v", err)
	}

	// Should be two success notifications. One for fee paid on-chain, one for
	// fee notification sent, each along with a balance note.
	getBondAndBalanceNote()

	// password error
	rig.crypter.(*tCrypter).recryptErr = tErr
	run()
	if !errorHasCode(err, passwordErr) {
		t.Fatalf("wrong password error: %v", err)
	}
	rig.crypter.(*tCrypter).recryptErr = nil

	// no host error
	form.Addr = ""
	run()
	if !errorHasCode(err, emptyHostErr) {
		t.Fatalf("wrong empty host error: %v", err)
	}
	form.Addr = tDexHost

	// wallet not found
	delete(tCore.wallets, tUTXOAssetA.ID)
	run()
	if !errorHasCode(err, missingWalletErr) {
		t.Fatalf("wrong missing wallet error: %v", err)
	}
	tCore.wallets[tUTXOAssetA.ID] = wallet

	// Unlock wallet error
	tWallet.unlockErr = tErr
	tWallet.locked = true
	run()
	if !errorHasCode(err, walletAuthErr) {
		t.Fatalf("wrong wallet auth error: %v", err)
	}
	tWallet.unlockErr = nil
	tWallet.locked = false

	// connectDEX error
	form.Addr = tUnparseableHost
	run()
	if !errorHasCode(err, connectionErr) {
		t.Fatalf("wrong connectDEX error: %v", err)
	}
	form.Addr = tDexHost

	// fee asset not found, no cfg.Fee fallback
	bondAssets := dc.cfg.BondAssets
	dc.cfg.BondAssets = nil
	queueConfigAndConnectUnknownAcct()
	run()
	if !errorHasCode(err, assetSupportErr) {
		t.Fatalf("wrong error for missing asset: %v", err)
	}
	dc.cfg.BondAssets = bondAssets

	// error creating signing key
	rig.crypter.(*tCrypter).encryptErr = tErr
	rig.queueConfig()
	run()
	if !errorHasCode(err, acctKeyErr) {
		t.Fatalf("wrong account key error: %v", err)
	}
	rig.crypter.(*tCrypter).encryptErr = nil

	bal0 := tWallet.bal.Available
	tWallet.bal.Available = 0
	run()
	if !errorHasCode(err, walletBalanceErr) {
		t.Fatalf("expected low balance error, got: %v", err)
	}
	tWallet.bal.Available = bal0

	// signature error
	queueConfigAndConnectUnknownAcct()
	rig.ws.queueResponse(msgjson.PreValidateBondRoute, func(msg *msgjson.Message, f msgFunc) error {
		preEval := new(msgjson.PreValidateBond)
		msg.Unmarshal(preEval)

		preEvalResult := &msgjson.PreValidateBondResult{
			Signature: msgjson.Signature{
				Sig: []byte{0xb, 0xa, 0xd},
			},
		}
		resp, _ := msgjson.NewResponse(msg.ID, preEvalResult, nil)
		f(resp)
		return nil
	})
	run()
	if !errorHasCode(err, signatureErr) {
		t.Fatalf("wrong error for bad signature on prevalidate response: %v", err)
	}

	// Wrong bond size on form
	goodAmt := form.Bond
	form.Bond = goodAmt + 1
	queueConfigAndConnectUnknownAcct()
	run()
	if !errorHasCode(err, bondAmtErr) {
		t.Fatalf("wrong error for wrong fee in form: %v", err)
	}
	form.Bond = goodAmt

	// MakeBondTx error
	queueConfigAndConnectUnknownAcct()
	tWallet.makeBondTxErr = tErr
	run()
	if !errorHasCode(err, bondPostErr) {
		t.Fatalf("wrong error for bondPostErr: %v", err)
	}
	tWallet.makeBondTxErr = nil

	// Make sure it's good again.
	queueResponses()
	run()
	if err != nil {
		t.Fatalf("error after regaining valid state: %v", err)
	}
	getBondAndBalanceNote()

	// Test the account recovery path.
	rig.queueConfig()
	rig.queueConnect(nil, nil, nil) // account exists
	run()
	if err != nil {
		t.Fatalf("Paid account error: %v", err)
	}

	// Account suspended should derive new HD credentials.
	rig.queueConnect(nil, nil, nil, true) // first try exists but suspended
	queueResponses()
	run()
	if err != nil {
		t.Fatalf("Suspension recovery error: %v", err)
	}
	getBondAndBalanceNote()
}

func TestUpdateBondOptions(t *testing.T) {
	const feeRate = 50

	rig := newTestRig()
	defer rig.shutdown()
	acct := rig.dc.acct
	acct.isAuthed = true

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	dcrWallet.Wallet = &TFeeRater{tDcrWallet, feeRate}
	rig.core.wallets[tUTXOAssetA.ID] = dcrWallet
	bondFeeBuffer := tDcrWallet.BondsFeeBuffer(feeRate)

	bondAsset := dcrBondAsset
	var wrongBondAssetID uint32 = 0
	var targetTier uint64 = 1
	var targetTierZero uint64 = 0
	defaultMaxBondedAmt := maxBondedMult * bondAsset.Amt * targetTier
	tooLowMaxBonded := defaultMaxBondedAmt - 1
	// Double because we will reserve for the bond that's about to be posted
	// in rotateBonds too.
	singlyBondedReserves := bondAsset.Amt*targetTier*2 + bondFeeBuffer

	type acctState struct {
		targetTier   uint64
		maxBondedAmt uint64
	}

	for _, tt := range []struct {
		name        string
		bal         uint64
		form        BondOptionsForm
		before      acctState
		after       acctState
		expReserves uint64
		addOtherDC  bool
		wantErr     bool
	}{
		{
			name: "set target tier to 1",
			bal:  singlyBondedReserves,
			form: BondOptionsForm{
				Host:        acct.host,
				TargetTier:  &targetTier,
				BondAssetID: &bondAsset.ID,
			},
			after: acctState{
				targetTier:   1,
				maxBondedAmt: defaultMaxBondedAmt,
			},
			expReserves: singlyBondedReserves,
		},
		{
			name: "low balance",
			bal:  singlyBondedReserves - 1,
			form: BondOptionsForm{
				Host:        acct.host,
				TargetTier:  &targetTier,
				BondAssetID: &bondAsset.ID,
			},
			wantErr: true,
		},
		{
			name: "max-bonded too low",
			bal:  singlyBondedReserves,
			form: BondOptionsForm{
				Host:         acct.host,
				TargetTier:   &targetTier,
				BondAssetID:  &bondAsset.ID,
				MaxBondedAmt: &tooLowMaxBonded,
			},
			wantErr: true,
		},
		{
			name: "unsupported bond asset",
			form: BondOptionsForm{
				Host:        acct.host,
				TargetTier:  &targetTier,
				BondAssetID: &wrongBondAssetID,
			},
			wantErr: true,
		},
		{
			name: "lower target tier with zero balance OK",
			bal:  0,
			form: BondOptionsForm{
				Host:        acct.host,
				TargetTier:  &targetTierZero,
				BondAssetID: &bondAsset.ID,
			},
			before: acctState{
				targetTier:   1,
				maxBondedAmt: defaultMaxBondedAmt,
			},
			after:       acctState{},
			expReserves: 0,
		},
		{
			name: "lower target tier to zero with other exchanges still keeps reserves",
			bal:  0,
			form: BondOptionsForm{
				Host:        acct.host,
				TargetTier:  &targetTierZero,
				BondAssetID: &bondAsset.ID,
			},
			before: acctState{
				targetTier:   1,
				maxBondedAmt: defaultMaxBondedAmt,
			},
			addOtherDC:  true,
			after:       acctState{},
			expReserves: bondFeeBuffer,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before, after := tt.before, tt.after
			acct.targetTier = before.targetTier
			acct.maxBondedAmt = before.maxBondedAmt
			tDcrWallet.bal = &asset.Balance{Available: tt.bal}

			if tt.addOtherDC {
				dc, _, acct := testDexConnection(rig.core.ctx, rig.crypter.(*tCrypter))
				acct.host = "someotherhost.com"
				rig.core.conns[acct.host] = dc
				defer delete(rig.core.conns, acct.host)
				acct.bondAsset = bondAsset.ID
				acct.targetTier = 1
			}

			if err := rig.core.UpdateBondOptions(&tt.form); err != nil {
				if tt.wantErr {
					return
				}
				t.Fatalf("UpdateBondOptions error: %v", err)
			}
			if tt.wantErr {
				t.Fatalf("No error when one was expected")
			}

			if acct.targetTier != after.targetTier {
				t.Fatalf("Wrong targetTier. %d != %d", acct.targetTier, after.targetTier)
			}
			if acct.maxBondedAmt != after.maxBondedAmt {
				t.Fatalf("Wrong maxBondedAmt. %d != %d", acct.maxBondedAmt, after.maxBondedAmt)
			}
			if tDcrWallet.reserves.Load() != tt.expReserves {
				t.Fatalf("Wrong reserves. %d != %d", tDcrWallet.reserves.Load(), tt.expReserves)
			}
		})
	}
}

func TestRotateBonds(t *testing.T) {
	const feeRate = 50

	rig := newTestRig()
	defer rig.shutdown()
	rig.core.Login(tPW)

	acct := rig.dc.acct
	acct.isAuthed = true

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	dcrWallet.Wallet = &TFeeRater{tDcrWallet, feeRate}
	rig.core.wallets[tUTXOAssetA.ID] = dcrWallet
	bondAsset := dcrBondAsset
	bondFeeBuffer := tDcrWallet.BondsFeeBuffer(feeRate)
	maxBondedPerTier := maxBondedMult * bondAsset.Amt

	now := uint64(time.Now().Unix())
	bondExpiry := rig.dc.config().BondExpiry
	// bondDuration := minBondLifetime(rig.core.net, bondExpiry)
	locktimeThresh := now + bondExpiry
	pBuffer := uint64(pendingBuffer(rig.core.net))
	mergeableLocktimeThresh := locktimeThresh + bondExpiry/4 + pBuffer
	// unexpired := locktimeThresh + 1
	locktimeExpired := locktimeThresh - 1
	locktimeRefundable := now - 1
	weakTimeThresh := locktimeThresh + pBuffer

	run := func(wantPending, wantExpired int, expectedReserves uint64) {
		ctx, cancel := context.WithTimeout(rig.core.ctx, time.Second)
		rig.core.rotateBonds(ctx)
		cancel()

		t.Helper()
		if len(acct.pendingBonds) != wantPending {
			t.Fatalf("wanted %d pending bonds, got %d", wantPending, len(acct.pendingBonds))
		}
		if len(acct.expiredBonds) != wantExpired {
			t.Fatalf("wanted %d expired bonds, got %d", wantExpired, len(acct.expiredBonds))
		}
		if tDcrWallet.reserves.Load() != expectedReserves {
			t.Fatalf("wrong reserves. expected %d, got %d", expectedReserves, tDcrWallet.reserves.Load())
		}
	}

	// No bonds, target tier 1. Should create a new bond and add it to pending.
	var targetTier uint64 = 1
	acct.targetTier = targetTier
	acct.maxBondedAmt = maxBondedPerTier * targetTier
	acct.bondAsset = bondAsset.ID
	tDcrWallet.bal = &asset.Balance{Available: bondAsset.Amt*targetTier + bondFeeBuffer}
	rig.queuePrevalidateBond()
	run(1, 0, bondAsset.Amt+bondFeeBuffer)

	// Post and then expire the bond. This first bond should move to expired and we
	// should create another bond.
	acct.bonds, acct.pendingBonds = acct.pendingBonds, nil
	acct.bonds[0].LockTime = locktimeExpired
	rig.queuePrevalidateBond()
	// The newly expired bond will be refunded in time to fund our next round,
	// so we only need fees reserved.
	run(1, 1, bondFeeBuffer)

	// If the live bond is closer to expiration, the expired bond won't be
	// ready in time, so we'll need more reserves.
	acct.bonds, acct.pendingBonds = acct.pendingBonds, nil
	acct.bonds[0].LockTime = weakTimeThresh + 1
	run(0, 1, bondAsset.Amt+bondFeeBuffer)

	// Make the live bond weak. Should get a pending bond. Only fees reserves,
	// because we still have an expired bond.
	acct.bonds[0].LockTime = weakTimeThresh - 1
	rig.queuePrevalidateBond()
	run(1, 1, bondFeeBuffer)

	// Refund the expired bond
	acct.expiredBonds[0].LockTime = locktimeRefundable
	tDcrWallet.contractExpired = true
	tDcrWallet.refundBondCoin = &tCoin{}
	run(1, 0, bondAsset.Amt+bondFeeBuffer)

	acct.targetTier = 2
	acct.bonds = nil
	rig.queuePrevalidateBond()
	run(2, 0, bondAsset.Amt*2+bondFeeBuffer)

	// Check that a new bond will be scheduled for merge with an existing bond
	// if the locktime is not too soon.
	acct.bonds = append(acct.bonds, acct.pendingBonds[0])
	acct.pendingBonds = nil
	acct.bonds[0].LockTime = mergeableLocktimeThresh + 5
	rig.queuePrevalidateBond()
	run(1, 0, 2*bondAsset.Amt+bondFeeBuffer)
	mergingBond := acct.pendingBonds[0]
	if mergingBond.LockTime != acct.bonds[0].LockTime {
		t.Fatalf("Mergeable bond was not merged")
	}

	// Same thing, but without the merge, just to check our threshold calc.
	acct.pendingBonds = nil
	acct.bonds[0].LockTime = mergeableLocktimeThresh - 1
	rig.queuePrevalidateBond()
	run(1, 0, 2*bondAsset.Amt+bondFeeBuffer)
	unmergingBond := acct.pendingBonds[0]
	if unmergingBond.LockTime == acct.bonds[0].LockTime {
		t.Fatalf("Unmergeable bond was scheduled for merged")
	}
}

func TestFindBondKeyIdx(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	rig.core.Login(tPW)

	pkhEqualFnFn := func(find bool) func(bondKey *secp256k1.PrivateKey) bool {
		return func(bondKey *secp256k1.PrivateKey) bool {
			return find
		}
	}
	tests := []struct {
		name       string
		pkhEqualFn func(bondKey *secp256k1.PrivateKey) bool
		wantErr    bool
	}{{
		name:       "ok",
		pkhEqualFn: pkhEqualFnFn(true),
	}, {
		name:       "cant find",
		pkhEqualFn: pkhEqualFnFn(false),
		wantErr:    true,
	}}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := rig.core.findBondKeyIdx(test.pkhEqualFn, 0)
			if test.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestFindBond(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	rig.core.wallets[tUTXOAssetA.ID] = dcrWallet
	rig.core.Login(tPW)

	bd := &asset.BondDetails{
		Bond: &asset.Bond{
			Amount:  tFee,
			AssetID: tUTXOAssetA.ID,
		},
		LockTime: time.Now(),
		CheckPrivKey: func(bondKey *secp256k1.PrivateKey) bool {
			return true
		},
	}
	msgBond := &msgjson.Bond{
		Version: 0,
		AssetID: tUTXOAssetA.ID,
	}

	tests := []struct {
		name        string
		findBond    *asset.BondDetails
		findBondErr error
		wantStr     uint32
	}{{
		name:     "ok",
		findBond: bd,
		wantStr:  1,
	}, {
		name:        "find bond error",
		findBondErr: errors.New("some error"),
	}}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tDcrWallet.findBond = test.findBond
			tDcrWallet.findBondErr = test.findBondErr
			str, _ := rig.core.findBond(rig.dc, msgBond)
			if str != test.wantStr {
				t.Fatalf("wanted str %d but got %d", test.wantStr, str)
			}
		})
	}
}

func TestNetworkFeeRate(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	assetID := tUTXOAssetA.ID
	wallet, tWallet := newTWallet(assetID)
	rig.core.wallets[assetID] = wallet

	const feeRaterRate = 50
	dumbWallet := wallet.Wallet
	wallet.Wallet = &TFeeRater{
		TXCWallet: tWallet,
		feeRate:   feeRaterRate,
	}
	if r := rig.core.NetworkFeeRate(assetID); r != feeRaterRate {
		t.Fatalf("FeeRater not working. %d != %d", r, feeRaterRate)
	}
	wallet.Wallet = dumbWallet

	const bookFeedFeeRate = 60
	book := newBookie(rig.dc, assetID, tUTXOAssetB.ID, nil, tLogger)
	rig.dc.books[tDcrBtcMktName] = book
	book.logEpochReport(&msgjson.EpochReportNote{BaseFeeRate: bookFeedFeeRate})
	if r := rig.core.NetworkFeeRate(assetID); r != bookFeedFeeRate {
		t.Fatalf("Book feed fee rate not working. %d != %d", r, bookFeedFeeRate)
	}
	delete(rig.dc.books, tDcrBtcMktName)

	const serverFeeRate = 70
	rig.ws.queueResponse(msgjson.FeeRateRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, serverFeeRate, nil)
		f(resp)
		return nil
	})
	if r := rig.core.NetworkFeeRate(assetID); r != serverFeeRate {
		t.Fatalf("Server fee rate not working. %d != %d", r, serverFeeRate)
	}
}
