//go:build !harness && !botlive

package core

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/db"
	dbtest "decred.org/dcrdex/client/db/test"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/encode"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
)

func TestCreateWallet(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Create a new asset.
	a := *tUTXOAssetA
	tILT := &a
	tILT.Symbol = "ilt"
	tILT.ID, _ = dex.BipSymbolID(tILT.Symbol)
	// This test Register's tILT below. Without unregistering on
	// teardown the registry leaks into the next -count=N iteration,
	// tripping the "unregistered asset" pre-condition assertion
	// further down.
	t.Cleanup(func() { asset.Unregister(tILT.ID) })

	// Create registration form.
	form := &WalletForm{
		AssetID: tILT.ID,
		Config: map[string]string{
			"rpclisten": "localhost",
		},
		Type: "type",
	}

	ensureErr := func(tag string) {
		t.Helper()
		err := tCore.CreateWallet(tPW, wPW, form)
		if err == nil {
			t.Fatalf("no %s error", tag)
		}
	}

	// Try to add an existing wallet.
	wallet, tWallet := newTWallet(tILT.ID)
	tCore.wallets[tILT.ID] = wallet
	ensureErr("existing wallet")
	delete(tCore.wallets, tILT.ID)

	// Failure to retrieve encryption key params.
	creds := tCore.credentials
	tCore.credentials = nil
	ensureErr("db.Get")
	tCore.credentials = creds

	// Crypter error.
	rig.crypter.(*tCrypter).encryptErr = tErr
	ensureErr("Encrypt")
	rig.crypter.(*tCrypter).encryptErr = nil

	// Try an unknown wallet (not yet asset.Register'ed).
	ensureErr("unregistered asset")

	// Register the asset.
	asset.Register(tILT.ID, &tDriver{
		wallet:        wallet.Wallet,
		decodedCoinID: "ilt-coin",
		winfo:         tWalletInfo,
	}, true)

	// Connection error.
	tWallet.connectErr = tErr
	ensureErr("Connect")
	tWallet.connectErr = nil

	// Unlock error.
	tWallet.unlockErr = tErr
	ensureErr("Unlock")
	tWallet.unlockErr = nil

	// Address error.
	tWallet.addrErr = tErr
	ensureErr("Address")
	tWallet.addrErr = nil

	// Balance error.
	tWallet.balErr = tErr
	ensureErr("Balance")
	tWallet.balErr = nil

	// Database error.
	rig.db.updateWalletErr = tErr
	ensureErr("db.UpdateWallet")
	rig.db.updateWalletErr = nil

	// Success
	delete(tCore.wallets, tILT.ID)
	err := tCore.CreateWallet(tPW, wPW, form)
	if err != nil {
		t.Fatalf("error when should be no error: %v", err)
	}
}

func TestSend(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	wallet, tWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = wallet
	tWallet.sendCoin = &tCoin{id: encode.RandomBytes(36)}
	address := "addr"

	// Successful
	coin, err := tCore.Send(tPW, tUTXOAssetA.ID, 1e8, address, false)
	if err != nil {
		t.Fatalf("Send error: %v", err)
	}
	if coin.Value() != 1e8 {
		t.Fatalf("Expected sent value to be %v, got %v", 1e8, coin.Value())
	}

	// 0 value
	_, err = tCore.Send(tPW, tUTXOAssetA.ID, 0, address, false)
	if err == nil {
		t.Fatalf("no error for zero value send")
	}

	// no wallet
	_, err = tCore.Send(tPW, 12345, 1e8, address, false)
	if err == nil {
		t.Fatalf("no error for unknown wallet")
	}

	// connect error
	wallet.hookedUp = false
	tWallet.connectErr = tErr
	_, err = tCore.Send(tPW, tUTXOAssetA.ID, 1e8, address, false)
	if err == nil {
		t.Fatalf("no error for wallet connect error")
	}
	tWallet.connectErr = nil
	// The previous sub-test drove ConnectionMaster.ConnectOnce to an
	// error, which advanced this connector's connectState to
	// Started/Finished. ConnectionMaster enforces a single-use
	// invariant via a CAS from Unset (see runner.go), so any
	// subsequent xcWallet.Connect() would panic. Mint a fresh
	// connector for the next sub-test and restore hookedUp so Send's
	// retry path sees a connected wallet.
	wallet.connector.Store(dex.NewConnectionMaster(tWallet))
	wallet.hookedUp = true

	// Send error
	tWallet.sendErr = tErr
	_, err = tCore.Send(tPW, tUTXOAssetA.ID, 1e8, address, false)
	if err == nil {
		t.Fatalf("no error for wallet send error")
	}
	tWallet.sendErr = nil

	// Check the coin.
	tWallet.sendCoin = &tCoin{id: []byte{'a'}}
	coin, err = tCore.Send(tPW, tUTXOAssetA.ID, 3e8, address, false)
	if err != nil {
		t.Fatalf("coin check error: %v", err)
	}
	coinID := coin.ID()
	if len(coinID) != 1 || coinID[0] != 'a' {
		t.Fatalf("coin ID not propagated")
	}
	if coin.Value() != 3e8 {
		t.Fatalf("Expected sent value to be %v, got %v", 3e8, coin.Value())
	}

	// So far, the fee suggestion should have always been zero.
	if tWallet.sendFeeSuggestion != 0 {
		t.Fatalf("unexpected non-zero fee rate when no books or responses prepared")
	}

	const feeRate = 54321

	feeRater := &TFeeRater{
		TXCWallet: tWallet,
		feeRate:   feeRate,
	}

	wallet.Wallet = feeRater

	coin, err = tCore.Send(tPW, tUTXOAssetA.ID, 2e8, address, false)
	if err != nil {
		t.Fatalf("FeeRater Withdraw/send error: %v", err)
	}
	if coin.Value() != 2e8 {
		t.Fatalf("Expected sent value to be %v, got %v", 2e8, coin.Value())
	}

	if tWallet.sendFeeSuggestion != feeRate {
		t.Fatalf("unexpected fee rate from FeeRater. wanted %d, got %d", feeRate, tWallet.sendFeeSuggestion)
	}

	// wallet is not synced
	wallet.syncStatus.Synced = false
	_, err = tCore.Send(tPW, tUTXOAssetA.ID, 1e8, address, false)
	if err == nil {
		t.Fatalf("Expected error for a non-synchronized wallet")
	}
}

// TestXCWalletConnectRetry verifies that a failed first Connect() can be
// retried without panicking. dex.ConnectionMaster is strictly single-use
// — after its Connect/ConnectOnce is invoked, the next invocation panics
// (dex/runner.go ~132-134). xcWallet.Connect() historically reused the
// same ConnectionMaster across calls, so any wallet whose first connect
// attempt failed (either ConnectOnce itself or a downstream validation)
// was permanently stuck until the whole app was reloaded. The fix
// (commit bcbd6d95) replaces w.connector with a fresh instance on each
// error path inside xcWallet.Connect(). This test covers both error
// paths directly.
func TestXCWalletConnectRetry(t *testing.T) {
	// Path (a): ConnectOnce itself fails, Connect returns early before
	// the `!ready` defer is registered. The reset happens inline right
	// before the return.
	t.Run("retry after ConnectOnce failure", func(t *testing.T) {
		wallet, tWallet := newTWalletDisconnected(tUTXOAssetA.ID)

		// First attempt: drive ConnectOnce to an error.
		tWallet.connectErr = tErr
		if err := wallet.Connect(); err == nil {
			t.Fatalf("expected error on first Connect, got nil")
		}

		// Retry: without the prod fix, this panics on the ConnectionMaster
		// single-use guard. With the fix, w.connector was replaced with a
		// fresh instance and the retry proceeds normally.
		tWallet.connectErr = nil
		if err := wallet.Connect(); err != nil {
			t.Fatalf("retry Connect failed: %v", err)
		}
		if !wallet.connected() {
			t.Fatalf("wallet reports not connected after successful retry")
		}
	})

	// Path (b): ConnectOnce succeeds, but a post-connect validation
	// (SyncStatus) fails. The `!ready` defer runs Disconnect() on the
	// used-up connector and THEN replaces it with a fresh instance.
	t.Run("retry after post-connect validation failure", func(t *testing.T) {
		wallet, tWallet := newTWalletDisconnected(tUTXOAssetA.ID)

		// First attempt: ConnectOnce succeeds, but the SyncStatus call
		// that follows returns an error. This triggers the defer-path
		// reset (Disconnect + mint fresh connector).
		tWallet.syncStatus = func() (synced bool, progress float32, err error) {
			return false, 0, tErr
		}
		if err := wallet.Connect(); err == nil {
			t.Fatalf("expected error on first Connect, got nil")
		}

		// Retry with SyncStatus fixed. Without the defer-path reset the
		// second ConnectOnce would panic on the single-use guard.
		tWallet.syncStatus = func() (synced bool, progress float32, err error) {
			return true, 1, nil
		}
		if err := wallet.Connect(); err != nil {
			t.Fatalf("retry Connect failed: %v", err)
		}
		if !wallet.connected() {
			t.Fatalf("wallet reports not connected after successful retry")
		}
	})
}

func TestAssetBalance(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	wallet, tWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = wallet
	bal := &asset.Balance{
		Available: 4e7,
		Immature:  6e7,
		Locked:    2e8,
	}
	tWallet.bal = bal
	walletBal, err := tCore.AssetBalance(tUTXOAssetA.ID)
	if err != nil {
		t.Fatalf("error retrieving asset balance: %v", err)
	}
	dbtest.MustCompareAssetBalances(t, "zero-conf", bal, &walletBal.Balance.Balance)
	if walletBal.ContractLocked != 0 {
		t.Fatalf("contractlocked balance %d > expected value 0", walletBal.ContractLocked)
	}
}

func TestAssetCounter(t *testing.T) {
	assets := make(assetMap)
	assets.count(1)
	if len(assets) != 1 {
		t.Fatalf("count not added")
	}

	newCounts := assetMap{
		1: struct{}{},
		2: struct{}{},
	}
	assets.merge(newCounts)
	if len(assets) != 2 {
		t.Fatalf("counts not absorbed properly")
	}
}

func TestWalletSettings(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.db.wallet = &db.Wallet{
		Settings: map[string]string{
			"abc":                            "123",
			asset.SpecialSettingActivelyUsed: "true",
		},
	}
	var assetID uint32 = 54321

	// wallet not found
	_, err := tCore.WalletSettings(assetID)
	if !errorHasCode(err, missingWalletErr) {
		t.Fatalf("wrong error for missing wallet: %v", err)
	}

	tCore.wallets[assetID] = &xcWallet{}

	// db error
	rig.db.walletErr = tErr
	_, err = tCore.WalletSettings(assetID)
	if !errorHasCode(err, dbErr) {
		t.Fatalf("wrong error when expected db error: %v", err)
	}
	rig.db.walletErr = nil

	// success — user-facing settings pass through, internally-injected
	// special_* flags are filtered out.
	returnedSettings, err := tCore.WalletSettings(assetID)
	if err != nil {
		t.Fatalf("WalletSettings error: %v", err)
	}

	if len(returnedSettings) != 1 || returnedSettings["abc"] != "123" {
		t.Fatalf("returned wallet settings are not correct: %v", returnedSettings)
	}
	if _, leaked := returnedSettings[asset.SpecialSettingActivelyUsed]; leaked {
		t.Fatalf("special_ flag leaked into WalletSettings output: %v", returnedSettings)
	}
}

func TestReconfigureWallet(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.db.wallet = &db.Wallet{
		Settings: map[string]string{
			"abc": "123",
		},
	}
	const assetID uint32 = 54321
	// This test Register's assetID below. Without unregistering on
	// teardown the registry leaks into the next -count=N iteration,
	// tripping the "wrong error for missing wallet definition"
	// pre-condition assertion further down.
	t.Cleanup(func() { asset.Unregister(assetID) })
	xyzWallet, tXyzWallet := newTWallet(assetID)
	newSettings := map[string]string{
		"def": "456",
	}

	form := &WalletForm{
		AssetID: assetID,
		Config:  newSettings,
		Type:    "type",
	}
	xyzWallet.walletType = "type"

	// App Password error
	rig.crypter.(*tCrypter).recryptErr = tErr
	err := tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, authErr) {
		t.Fatalf("wrong error for password error: %v", err)
	}
	rig.crypter.(*tCrypter).recryptErr = nil

	// Missing wallet error
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, assetSupportErr) {
		t.Fatalf("wrong error for missing wallet definition: %v", err)
	}

	walletDef := &asset.WalletDefinition{
		Type:   "type",
		Seeded: true,
	}
	winfo := *tWalletInfo
	winfo.AvailableWallets = []*asset.WalletDefinition{walletDef}

	assetDriver := &tCreator{
		tDriver: &tDriver{
			wallet: xyzWallet.Wallet,
			winfo:  &winfo,
		},
	}
	asset.Register(assetID, assetDriver)
	// Reset the default hookedUp=true so Connect actually drives the
	// ConnectionMaster through a real Connect → connectState=Finished
	// cycle. Otherwise the deferred Disconnect below panics
	// (ConnectionMaster.Disconnect refuses to run before the connect
	// attempt has finished).
	xyzWallet.hookedUp = false
	if err = xyzWallet.Connect(); err != nil {
		t.Fatal(err)
	}
	defer xyzWallet.Disconnect()

	// Missing wallet error
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, missingWalletErr) {
		t.Fatalf("wrong error for missing wallet: %v", err)
	}

	tCore.wallets[assetID] = xyzWallet

	// Errors for seeded wallets.
	walletDef.Seeded = true
	// Exists error
	assetDriver.existsErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, existenceCheckErr) {
		t.Fatalf("wrong error when expecting existence check error: %v", err)
	}
	assetDriver.existsErr = nil
	// Create error
	assetDriver.doesntExist = true
	assetDriver.createErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, createWalletErr) {
		t.Fatalf("wrong error when expecting wallet creation error error: %v", err)
	}
	assetDriver.createErr = nil
	walletDef.Seeded = false

	// Connect error
	tXyzWallet.connectErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, connectWalletErr) {
		t.Fatalf("wrong error when expecting connection error: %v", err)
	}
	tXyzWallet.connectErr = nil

	// Unlock error
	tXyzWallet.Unlock(wPW)
	tXyzWallet.unlockErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, walletAuthErr) {
		t.Fatalf("wrong error when expecting auth error: %v", err)
	}
	tXyzWallet.unlockErr = nil

	// For the last success, make sure that we also clear any related
	// tickGovernors.
	abcWallet, _ := newTWallet(tUTXOAssetA.ID) // for to/baseWallet
	matchID := ordertest.RandomMatchID()
	match := &matchTracker{
		suspectSwap:  true,
		tickGovernor: time.NewTimer(time.Hour),
		MetaMatch: db.MetaMatch{
			MetaData: &db.MatchMetaData{
				Proof: db.MatchProof{
					ContractData: dex.Bytes{0},
				},
			},
			UserMatch: &order.UserMatch{
				MatchID: matchID,
			},
		},
	}
	tCore.conns[tDexHost].tradeMtx.Lock()
	tCore.conns[tDexHost].trades[order.OrderID{}] = &trackedTrade{
		Order: &order.LimitOrder{
			P: order.Prefix{
				BaseAsset:  assetID,
				ServerTime: time.Now(),
			},
		},
		wallets: &walletSet{
			fromWallet:  xyzWallet,
			quoteWallet: xyzWallet, // sell=false
			toWallet:    abcWallet,
			baseWallet:  abcWallet,
		},
		matches: map[order.MatchID]*matchTracker{
			{}: match,
		},
		metaData:    &db.OrderMetaData{},
		dc:          rig.dc,
		readyToTick: true, // prevent resume path
	}
	tCore.conns[tDexHost].tradeMtx.Unlock()

	// Error checking if wallet owns address.
	tXyzWallet.ownsAddressErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, walletErr) {
		t.Fatalf("wrong error when expecting ownsAddress wallet error: %v", err)
	}
	tXyzWallet.ownsAddressErr = nil

	// Wallet doesn't own address.
	tXyzWallet.ownsAddress = false
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, walletErr) {
		t.Fatalf("wrong error when expecting not owned wallet error: %v", err)
	}

	// Leave the ownsAddress false, but swap out a LiveReconfigurer and ensure
	// the restart = false path passes.
	liveReconfigurer := &TLiveReconfigurer{TXCWallet: tXyzWallet}
	xyzWallet.Wallet = liveReconfigurer
	if err = tCore.ReconfigureWallet(tPW, nil, form); err != nil {
		t.Fatalf("ReconfigureWallet error for short path: %v", err)
	}

	// But restart = true should still fail for live orders.
	liveReconfigurer.restart = true
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, walletErr) {
		t.Fatalf("wrong error when expecting not owned wallet error: %v", err)
	}
	liveReconfigurer.restart = false

	// OwnsAddress error
	liveReconfigurer.ownsAddressErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, walletErr) {
		t.Fatalf("wrong error when expecting ownsAddress wallet error without restart: %v", err)
	}
	liveReconfigurer.ownsAddressErr = nil

	// Refresh address error
	liveReconfigurer.addrErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, newAddrErr) {
		t.Fatalf("wrong error when expecting address refresh error without restart: %v", err)
	}
	liveReconfigurer.addrErr = nil

	// Password error for non-seeded wallet with password.
	// from above: walletDef.Seeded = false
	liveReconfigurer.unlockErr = tErr
	err = tCore.ReconfigureWallet(tPW, append(tPW, 5), form)
	if !errorHasCode(err, walletAuthErr) {
		t.Fatalf("wrong error when expecting new password error without restart: %v", err)
	}
	liveReconfigurer.unlockErr = nil

	// DB error for restartless path.
	rig.db.updateWalletErr = tErr
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if !errorHasCode(err, dbErr) {
		t.Fatalf("wrong error when db update error without restart: %v", err)
	}
	rig.db.updateWalletErr = nil

	// End LiveReconfigurer tests.
	xyzWallet.Wallet = tXyzWallet
	tXyzWallet.ownsAddress = true

	// Success updating settings.
	err = tCore.ReconfigureWallet(tPW, nil, form)
	if err != nil {
		t.Fatalf("ReconfigureWallet error: %v", err)
	}

	settings := rig.db.wallet.Settings
	if len(settings) != 1 || settings["def"] != "456" {
		t.Fatalf("settings not stored")
	}

	if match.tickGovernor != nil {
		t.Fatalf("tickGovernor not removed")
	}

	// Success updating wallet PW.
	newWalletPW := []byte("password")
	err = tCore.ReconfigureWallet(tPW, newWalletPW, form)
	if err != nil {
		t.Fatalf("ReconfigureWallet error: %v", err)
	}

	// Check that the xcWallet was updated.
	xyzWallet = tCore.wallets[assetID]
	decNewPW, _ := rig.crypter.Decrypt(xyzWallet.encPW())
	if !bytes.Equal(decNewPW, newWalletPW) {
		t.Fatalf("xcWallet encPW field not updated want: %x got: %x",
			newWalletPW, decNewPW)
	}
}

func TestSetWalletPassword(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	rig.db.wallet = &db.Wallet{
		EncryptedPW: []byte("abc"),
	}
	newPW := []byte("def")
	var assetID uint32 = 54321
	// SetWalletPassword's internal call to asset.WalletDef requires
	// assetID to be registered. Historically this test relied on
	// TestReconfigureWallet's registration leaking forward via test
	// source order — with TestReconfigureWallet now cleaning up after
	// itself this test must register its own driver.
	walletDef := &asset.WalletDefinition{Type: "type"}
	winfo := *tWalletInfo
	winfo.AvailableWallets = []*asset.WalletDefinition{walletDef}
	asset.Register(assetID, &tDriver{winfo: &winfo}, true)
	t.Cleanup(func() { asset.Unregister(assetID) })

	// Nil password error
	err := tCore.SetWalletPassword(tPW, assetID, nil)
	if !errorHasCode(err, passwordErr) {
		t.Fatalf("wrong error for nil password error: %v", err)
	}

	// Auth error
	rig.crypter.(*tCrypter).recryptErr = tErr
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if !errorHasCode(err, authErr) {
		t.Fatalf("wrong error for auth error: %v", err)
	}
	rig.crypter.(*tCrypter).recryptErr = nil

	// Missing wallet error
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if !errorHasCode(err, missingWalletErr) {
		t.Fatalf("wrong error for missing wallet: %v", err)
	}

	xyzWallet, tXyzWallet := newTWallet(assetID)
	tCore.wallets[assetID] = xyzWallet

	// Connection error
	xyzWallet.hookedUp = false
	tXyzWallet.connectErr = tErr
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if !errorHasCode(err, connectionErr) {
		t.Fatalf("wrong error for connection error: %v", err)
	}
	xyzWallet.hookedUp = true
	tXyzWallet.connectErr = nil

	// Unlock error
	tXyzWallet.unlockErr = tErr
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if !errorHasCode(err, authErr) {
		t.Fatalf("wrong error for auth error: %v", err)
	}
	tXyzWallet.unlockErr = nil

	// SetWalletPassword db error
	rig.db.setWalletPwErr = tErr
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if !errorHasCode(err, dbErr) {
		t.Fatalf("wrong error for missing wallet: %v", err)
	}
	rig.db.setWalletPwErr = nil

	// Success
	err = tCore.SetWalletPassword(tPW, assetID, newPW)
	if err != nil {
		t.Fatalf("SetWalletPassword error: %v", err)
	}

	// Check that the xcWallet was updated.
	decNewPW, _ := rig.crypter.Decrypt(xyzWallet.encPW())
	if !bytes.Equal(decNewPW, newPW) {
		t.Fatalf("xcWallet encPW field not updated")
	}
}

func TestConfirmTransaction(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	lo, dbOrder, preImg, addr := makeLimitOrder(dc, true, 0, 0)
	oid := lo.ID()
	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	tBytes := encode.RandomBytes(2)
	tCoinID := encode.RandomBytes(36)
	tUpdatedCoinID := encode.RandomBytes(36)
	secret := encode.RandomBytes(32)
	secretHash := sha256.Sum256(secret)

	var match *matchTracker

	tBtcWallet.redeemCoins = []dex.Bytes{tUpdatedCoinID}

	ourContract := encode.RandomBytes(90)
	setupMatch := func(status order.MatchStatus, side order.MatchSide, isRefunded bool) {
		matchID := ordertest.RandomMatchID()
		_, auditInfo := tMsgAudit(oid, matchID, addr, 0, secretHash[:])
		matchTime := time.Now()
		match = &matchTracker{
			counterSwap: auditInfo,
			MetaMatch: db.MetaMatch{
				MetaData: &db.MatchMetaData{},
				UserMatch: &order.UserMatch{
					MatchID: matchID,
					Address: addr,
					Side:    side,
					Status:  status,
				},
			},
		}
		tracker.matches = map[order.MatchID]*matchTracker{matchID: match}

		isMaker := match.Side == order.Maker
		proof := &match.MetaData.Proof
		proof.Auth.InitSig = []byte{1, 2, 3, 4}
		// Assume our redeem was accepted, if we sent one.
		if isMaker {
			auditInfo.Expiration = matchTime.Add(tracker.lockTimeTaker)
			if status >= order.MakerRedeemed {
				match.MetaData.Proof.Auth.RedeemSig = []byte{0}
			}
		} else {
			auditInfo.Expiration = matchTime.Add(tracker.lockTimeMaker)
			if status >= order.MatchComplete {
				match.MetaData.Proof.Auth.RedeemSig = []byte{0}
			}
		}

		if status >= order.MakerSwapCast {
			proof.MakerSwap = tCoinID
			proof.SecretHash = secretHash[:]
			if isMaker {
				proof.ContractData = ourContract
				proof.Secret = secret
			} else {
				proof.CounterContract = tBytes
			}
		}
		if status >= order.TakerSwapCast {
			proof.TakerSwap = tCoinID
			if isMaker {
				proof.CounterContract = tBytes
			} else {
				proof.ContractData = ourContract
			}
		}
		if status >= order.MakerRedeemed {
			proof.MakerRedeem = tCoinID
			if !isMaker {
				proof.Secret = secret
			}
		}
		if status == order.MatchComplete {
			proof.TakerRedeem = tCoinID
		}
		if status >= order.MatchComplete {
			proof.TakerRedeem = tCoinID
		}
		if isRefunded {
			proof.RefundCoin = tCoinID
		} else {
			proof.RefundCoin = nil
		}
	}

	type note struct {
		severity db.Severity
		topic    db.Topic
	}

	tests := []struct {
		name                                   string
		matchStatus                            order.MatchStatus
		matchSide                              order.MatchSide
		expectedNotifications                  []*note
		confirmTxResult, refundConfirmTxResult *asset.ConfirmTxStatus
		confirmTxErr, refundConfirmTxErr       error

		expectConfirmTxCalled, expectRefundConfirmTxCalled bool
		expectedStatus                                     order.MatchStatus
		expectTicksDelayed                                 bool

		isRefund bool
	}{
		{
			name:        "maker, makerRedeemed, confirmedTx",
			matchStatus: order.MakerRedeemed,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.Success,
					topic:    TopicRedemptionConfirmed,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  10,
				Req:    10,
				CoinID: tCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MatchConfirmed,
		},
		{
			name:        "maker, makerRedeemed, confirmedRedemption, more confs than required",
			matchStatus: order.MakerRedeemed,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.Success,
					topic:    TopicRedemptionConfirmed,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  15,
				Req:    10,
				CoinID: tCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MatchConfirmed,
		},
		{
			name:        "taker, matchComplete, confirmedRedemption",
			matchStatus: order.MatchComplete,
			matchSide:   order.Taker,
			expectedNotifications: []*note{
				{
					severity: db.Success,
					topic:    TopicRedemptionConfirmed,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  10,
				Req:    10,
				CoinID: tCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MatchConfirmed,
		},
		{
			name:        "maker, makerRedeemed, incomplete",
			matchStatus: order.MakerRedeemed,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.Data,
					topic:    TopicConfirms,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  5,
				Req:    10,
				CoinID: tCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MakerRedeemed,
		},
		{
			name:        "maker, makerRedeemed, replacedTx",
			matchStatus: order.MakerRedeemed,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.WarningLevel,
					topic:    TopicRedemptionResubmitted,
				},
				{
					severity: db.Data,
					topic:    TopicConfirms,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  0,
				Req:    10,
				CoinID: tUpdatedCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MakerRedeemed,
		},
		{
			name:        "taker, matchComplete, replacedTx",
			matchStatus: order.MatchComplete,
			matchSide:   order.Taker,
			expectedNotifications: []*note{
				{
					severity: db.WarningLevel,
					topic:    TopicRedemptionResubmitted,
				},
				{
					severity: db.Data,
					topic:    TopicConfirms,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  0,
				Req:    10,
				CoinID: tUpdatedCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MatchComplete,
		},
		{
			// This case could happen if the dex was shut down right after
			// a resubmission.
			name:        "taker, matchComplete, replacedTx and already confirmed",
			matchStatus: order.MatchComplete,
			matchSide:   order.Taker,
			expectedNotifications: []*note{
				{
					severity: db.WarningLevel,
					topic:    TopicRedemptionResubmitted,
				},
				{
					severity: db.Success,
					topic:    TopicRedemptionConfirmed,
				},
			},
			confirmTxResult: &asset.ConfirmTxStatus{
				Confs:  10,
				Req:    10,
				CoinID: tUpdatedCoinID,
			},
			expectConfirmTxCalled: true,
			expectedStatus:        order.MatchConfirmed,
		},
		{
			name:                  "maker, makerRedeemed, error",
			matchStatus:           order.MakerRedeemed,
			matchSide:             order.Maker,
			confirmTxErr:          errors.New("err"),
			expectedStatus:        order.MakerRedeemed,
			expectTicksDelayed:    true,
			expectConfirmTxCalled: true,
		},
		{
			name:           "maker, makerRedeemed, swap refunded error",
			matchStatus:    order.MakerRedeemed,
			matchSide:      order.Maker,
			confirmTxErr:   asset.ErrSwapRefunded,
			expectedStatus: order.MatchConfirmed,
			expectedNotifications: []*note{
				{
					severity: db.ErrorLevel,
					topic:    TopicSwapRefunded,
				},
			},
			expectConfirmTxCalled: true,
		},
		{
			name:           "taker, takerRedeemed, redemption tx rejected error",
			matchStatus:    order.MatchComplete,
			matchSide:      order.Taker,
			confirmTxErr:   asset.ErrTxRejected,
			expectedStatus: order.MatchComplete,
			expectedNotifications: []*note{
				{
					severity: db.Data,
					topic:    TopicRedeemRejected,
				},
			},
			expectConfirmTxCalled: true,
		},
		{
			name:                  "maker, makerRedeemed, redemption tx lost",
			matchStatus:           order.MakerRedeemed,
			matchSide:             order.Maker,
			confirmTxErr:          asset.ErrTxLost,
			expectedStatus:        order.TakerSwapCast,
			expectConfirmTxCalled: true,
		},
		{
			name:                  "taker, takerRedeemed, redemption tx lost",
			matchStatus:           order.MatchComplete,
			matchSide:             order.Taker,
			confirmTxErr:          asset.ErrTxLost,
			expectedStatus:        order.MakerRedeemed,
			expectConfirmTxCalled: true,
		},
		{
			name:                  "maker, matchConfirmed",
			matchStatus:           order.MatchConfirmed,
			matchSide:             order.Maker,
			expectedStatus:        order.MatchConfirmed,
			expectedNotifications: []*note{},
			expectConfirmTxCalled: false,
		},
		{
			name:                  "maker, TakerSwapCast",
			matchStatus:           order.TakerSwapCast,
			matchSide:             order.Maker,
			expectedStatus:        order.TakerSwapCast,
			expectedNotifications: []*note{},
			expectConfirmTxCalled: false,
		},
		{
			name:                  "taker, TakerSwapCast",
			matchStatus:           order.TakerSwapCast,
			matchSide:             order.Taker,
			expectedStatus:        order.TakerSwapCast,
			expectedNotifications: []*note{},
			expectConfirmTxCalled: false,
		},
		{
			name:        "maker, taker swap cast, confirmedTx, refund",
			matchStatus: order.MakerSwapCast,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.Success,
					topic:    TopicRefundConfirmed,
				},
			},
			refundConfirmTxResult: &asset.ConfirmTxStatus{
				Confs:  10,
				Req:    10,
				CoinID: tCoinID,
			},
			expectRefundConfirmTxCalled: true,
			expectedStatus:              order.MatchConfirmed,
			isRefund:                    true,
		},
		{
			name:        "taker, takerSwapCast, confirmedTx, refund",
			matchStatus: order.TakerSwapCast,
			matchSide:   order.Taker,
			expectedNotifications: []*note{
				{
					severity: db.Success,
					topic:    TopicRefundConfirmed,
				},
			},
			refundConfirmTxResult: &asset.ConfirmTxStatus{
				Confs:  10,
				Req:    10,
				CoinID: tCoinID,
			},
			expectRefundConfirmTxCalled: true,
			expectedStatus:              order.MatchConfirmed,
			isRefund:                    true,
		},
		{
			name:        "maker, makerSwapCast, incomplete, refund",
			matchStatus: order.MakerSwapCast,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.Data,
					topic:    TopicConfirms,
				},
			},
			refundConfirmTxResult: &asset.ConfirmTxStatus{
				Confs:  5,
				Req:    10,
				CoinID: tCoinID,
			},
			expectRefundConfirmTxCalled: true,
			expectedStatus:              order.MakerSwapCast,
			isRefund:                    true,
		},
		{
			name:        "taker, takerSwapCast, replacedTx, refund",
			matchStatus: order.TakerSwapCast,
			matchSide:   order.Taker,
			expectedNotifications: []*note{
				{
					severity: db.WarningLevel,
					topic:    TopicRefundResubmitted,
				},
				{
					severity: db.Data,
					topic:    TopicConfirms,
				},
			},
			refundConfirmTxResult: &asset.ConfirmTxStatus{
				Confs:  0,
				Req:    10,
				CoinID: tUpdatedCoinID,
			},
			expectRefundConfirmTxCalled: true,
			expectedStatus:              order.TakerSwapCast,
			isRefund:                    true,
		},
		{
			name:        "maker, makerSwapCast, replacedTx confirmed, refund",
			matchStatus: order.MakerSwapCast,
			matchSide:   order.Maker,
			expectedNotifications: []*note{
				{
					severity: db.WarningLevel,
					topic:    TopicRefundResubmitted,
				},
				{
					severity: db.Success,
					topic:    TopicRefundConfirmed,
				},
			},
			refundConfirmTxResult: &asset.ConfirmTxStatus{
				Confs:  15,
				Req:    10,
				CoinID: tUpdatedCoinID,
			},
			expectRefundConfirmTxCalled: true,
			expectedStatus:              order.MatchConfirmed,
			isRefund:                    true,
		},
		{
			name:                        "maker, makerSwapCast, error",
			matchStatus:                 order.MakerSwapCast,
			matchSide:                   order.Maker,
			refundConfirmTxErr:          errors.New("err"),
			expectedStatus:              order.MakerSwapCast,
			expectTicksDelayed:          true,
			expectRefundConfirmTxCalled: true,
			isRefund:                    true,
		},
		{
			name:               "maker, makerSwapCast, swap redeemed error",
			matchStatus:        order.MakerSwapCast,
			matchSide:          order.Maker,
			refundConfirmTxErr: asset.ErrSwapRedeemed,
			expectedStatus:     order.MatchConfirmed,
			expectedNotifications: []*note{
				{
					severity: db.ErrorLevel,
					topic:    TopicSwapRedeemed,
				},
			},
			expectRefundConfirmTxCalled: true,
			isRefund:                    true,
		},
		{
			name:               "taker, takerSwapCast, refund tx rejected error",
			matchStatus:        order.TakerSwapCast,
			matchSide:          order.Taker,
			refundConfirmTxErr: asset.ErrTxRejected,
			expectedStatus:     order.TakerSwapCast,
			expectedNotifications: []*note{
				{
					severity: db.Data,
					topic:    TopicRefundRejected,
				},
			},
			expectRefundConfirmTxCalled: true,
			isRefund:                    true,
		},
		{
			name:                        "maker, makerSwapCast, refund tx lost",
			matchStatus:                 order.MakerSwapCast,
			matchSide:                   order.Maker,
			refundConfirmTxErr:          asset.ErrTxLost,
			expectedStatus:              order.MakerSwapCast,
			expectRefundConfirmTxCalled: true,
			isRefund:                    true,
		},
		{
			name:                        "taker, takerSwapCast, refund tx lost",
			matchStatus:                 order.TakerSwapCast,
			matchSide:                   order.Taker,
			refundConfirmTxErr:          asset.ErrTxLost,
			expectedStatus:              order.TakerSwapCast,
			expectRefundConfirmTxCalled: true,
			isRefund:                    true,
		},
		{
			name:                  "maker, matchConfirmed, refund",
			matchStatus:           order.MatchConfirmed,
			matchSide:             order.Maker,
			expectedStatus:        order.MatchConfirmed,
			expectedNotifications: []*note{},
			expectConfirmTxCalled: false,
			isRefund:              true,
		},
	}

	notificationFeed := tCore.NotificationFeed()

	for _, test := range tests {
		tracker.mtx.Lock()
		setupMatch(test.matchStatus, test.matchSide, test.isRefund)
		tracker.mtx.Unlock()

		tBtcWallet.confirmTxResult = test.confirmTxResult
		tBtcWallet.confirmTxErr = test.confirmTxErr
		tBtcWallet.confirmTxCalled = false

		tDcrWallet.confirmTxResult = test.refundConfirmTxResult
		tDcrWallet.confirmTxErr = test.refundConfirmTxErr
		tDcrWallet.confirmTxCalled = false

		tCore.schedTradeTick(tracker)
		for atomic.LoadUint32(&tracker.tickRunning) != 0 {
			time.Sleep(time.Millisecond)
		}

		if tBtcWallet.confirmTxCalled != test.expectConfirmTxCalled {
			t.Fatalf("%s: expected confirm tx for redemption to be called=%v but got=%v",
				test.name, test.expectConfirmTxCalled, tBtcWallet.confirmTxCalled)
		}

		if tDcrWallet.confirmTxCalled != test.expectRefundConfirmTxCalled {
			t.Fatalf("%s: expected confirm tx for refund to be called=%v but got=%v",
				test.name, test.expectRefundConfirmTxCalled, tDcrWallet.confirmTxCalled)
		}

		for _, expectedNotification := range test.expectedNotifications {
			var n Notification
		out:
			for {
				select {
				case n = <-notificationFeed.C:
					if n.Topic() == expectedNotification.topic {
						break out
					}
				case <-time.After(60 * time.Second):
					t.Fatalf("%s: did not receive expected notification", test.name)
				}
			}

			if n.Severity() != expectedNotification.severity {
				t.Fatalf("%s: expected severity %v, got %v",
					test.name, expectedNotification.severity, n.Severity())
			}
		}

		tracker.mtx.RLock()
		if test.confirmTxResult != nil {
			var redeemCoin order.CoinID
			if test.matchSide == order.Maker {
				redeemCoin = match.MetaData.Proof.MakerRedeem
			} else {
				redeemCoin = match.MetaData.Proof.TakerRedeem
			}
			if !bytes.Equal(redeemCoin, test.confirmTxResult.CoinID) {
				t.Fatalf("%s: expected coin %v != actual %v", test.name, test.confirmTxResult.CoinID, redeemCoin)
			}
			if test.confirmTxResult.Confs >= test.confirmTxResult.Req {
				if len(tDcrWallet.returnedContracts) != 1 || !bytes.Equal(ourContract, tDcrWallet.returnedContracts[0]) {
					t.Fatalf("%s: refund address not returned", test.name)
				}
			}
		}

		if test.refundConfirmTxResult != nil {
			refundCoinID := match.MetaData.Proof.RefundCoin
			if !bytes.Equal(refundCoinID, test.refundConfirmTxResult.CoinID) {
				t.Fatalf("%s: expected coin %v != actual %v", test.name, test.refundConfirmTxResult.CoinID, refundCoinID)
			}
		}

		ticksDelayed := match.tickGovernor != nil
		if ticksDelayed != test.expectTicksDelayed {
			t.Fatalf("%s: expected ticks delayed %v but got %v", test.name, test.expectTicksDelayed, ticksDelayed)
		}

		if match.Status != test.expectedStatus {
			t.Fatalf("%s: expected status %v but got %v", test.name, test.expectedStatus, match.Status)
		}
		tracker.mtx.RUnlock()
	}
}

func TestWalletSyncing(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	noteFeed := tCore.NotificationFeed()
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	dcrWallet.syncStatus.Synced = false
	dcrWallet.syncStatus.Blocks = 0
	dcrWallet.hookedUp = false
	// Connect with tCore.connectWallet below.

	tStart := time.Now()
	testDuration := 100 * time.Millisecond
	syncTickerPeriod = 10 * time.Millisecond

	tDcrWallet.syncStatus = func() (bool, float32, error) {
		progress := float32(float64(time.Since(tStart)) / float64(testDuration))
		if progress >= 1 {
			return true, 1, nil
		}
		return false, progress, nil
	}

	_, err := tCore.connectWallet(dcrWallet)
	if err != nil {
		t.Fatalf("connectWallet error: %v", err)
	}

	timeout := time.NewTimer(time.Second)
	defer timeout.Stop()
	var progressNotes int
out:
	for {
		select {
		case note := <-noteFeed.C:
			syncNote, ok := note.(*WalletSyncNote)
			if !ok {
				continue
			}
			progressNotes++
			if syncNote.SyncStatus.Synced {
				break out
			}
		case <-timeout.C:
			t.Fatalf("timed out waiting for synced wallet note. Received %d progress notes", progressNotes)
		}
	}
	// By the time we've got 10th note it should signal that the wallet has been
	// synced (due to how we've set up testDuration and syncTickerPeriod values).
	if progressNotes > 10 {
		t.Fatalf("expected 10 progress notes at most, got %d", progressNotes)
	}
}

func TestCoreAssetSeedAndPass(t *testing.T) {
	// This test ensures the derived wallet seed and password are deterministic
	// and depend on both asset ID and app seed.

	// NOTE: the blake256 hash of an empty slice is:
	// []byte{0x71, 0x6f, 0x6e, 0x86, 0x3f, 0x74, 0x4b, 0x9a, 0xc2, 0x2c, 0x97, 0xec, 0x7b, 0x76, 0xea, 0x5f,
	//        0x59, 0x8, 0xbc, 0x5b, 0x2f, 0x67, 0xc6, 0x15, 0x10, 0xbf, 0xc4, 0x75, 0x13, 0x84, 0xea, 0x7a}
	// The above was very briefly the password for all seeded wallets, not released.

	tests := []struct {
		name     string
		appSeed  []byte
		assetID  uint32
		wantSeed []byte
		wantPass []byte
	}{
		{
			name:    "base",
			appSeed: []byte{1, 2, 3},
			assetID: 2,
			wantSeed: []byte{
				0xac, 0x61, 0xb1, 0xbc, 0x77, 0xd0, 0xa6, 0xd5, 0xd2, 0xb5, 0xc9, 0x77, 0x91, 0xd6, 0x4a, 0xaf,
				0x4a, 0xa3, 0x47, 0xb7, 0xb, 0x85, 0xe, 0x82, 0x1c, 0x79, 0xab, 0xc0, 0x86, 0x50, 0xee, 0xda},
			wantPass: []byte{
				0xd8, 0xf0, 0x27, 0x4d, 0xbc, 0x56, 0xb0, 0x74, 0x1e, 0x20, 0x3b, 0x98, 0xe9, 0xaa, 0x5c, 0xba,
				0x13, 0xfd, 0x60, 0x3b, 0x83, 0x76, 0x2e, 0x4b, 0x5d, 0x6d, 0x19, 0x57, 0x89, 0xe2, 0x8b, 0xc7},
		},
		{
			name:    "change app seed",
			appSeed: []byte{2, 2, 3},
			assetID: 2,
			wantSeed: []byte{
				0xf, 0xc9, 0xf, 0xa8, 0xb3, 0xe9, 0x31, 0x2a, 0xba, 0xf1, 0xda, 0x70, 0x41, 0x81, 0x49, 0xed,
				0xad, 0x47, 0x9, 0xcd, 0xe2, 0x17, 0x14, 0xd, 0x63, 0x49, 0x8a, 0xd8, 0xff, 0x1f, 0x3e, 0x8b},
			wantPass: []byte{
				0x78, 0x21, 0x72, 0x59, 0xbe, 0x39, 0xea, 0x54, 0x10, 0x46, 0x7d, 0x7e, 0xa, 0x95, 0xc4, 0xa0,
				0xd8, 0x73, 0xce, 0x1, 0xb2, 0x49, 0x98, 0x6c, 0x68, 0xc5, 0x69, 0x69, 0xa7, 0x13, 0xc1, 0xce},
		},
		{
			name:    "change asset ID",
			appSeed: []byte{1, 2, 3},
			assetID: 0,
			wantSeed: []byte{
				0xe1, 0xad, 0x62, 0xe4, 0x60, 0xfd, 0x75, 0x91, 0x3d, 0x41, 0x2e, 0x8e, 0xc5, 0x72, 0xd4, 0xa2,
				0x39, 0x2d, 0x32, 0x86, 0xf0, 0x6b, 0xf7, 0xdf, 0x48, 0xcc, 0x57, 0xb1, 0x4b, 0x7b, 0xc6, 0xce},
			wantPass: []byte{
				0x52, 0xba, 0x59, 0x21, 0xd3, 0xc5, 0x6b, 0x2, 0x2c, 0x12, 0xc1, 0x98, 0xdc, 0x84, 0xed, 0x68,
				0x6, 0x35, 0xa6, 0x25, 0xd0, 0xc4, 0x49, 0x5a, 0x13, 0xc3, 0x12, 0xfb, 0xeb, 0xb3, 0x61, 0x88},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seed, pass := AssetSeedAndPass(tt.assetID, tt.appSeed)
			if !bytes.Equal(pass, tt.wantPass) {
				t.Errorf("pass not as expected, got %#v", pass)
			}
			if !bytes.Equal(seed, tt.wantSeed) {
				t.Errorf("seed not as expected, got %#v", seed)
			}
		})
	}
}

func TestValidateAddress(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	wallet, tWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = wallet

	tests := []struct {
		name              string
		addr              string
		wantValidAddr     bool
		wantMissingWallet bool
		wantErr           bool
	}{{
		name:          "valid address",
		addr:          "randomvalidaddress",
		wantValidAddr: true,
	}, {
		name: "invalid address",
		addr: "",
	}, {
		name:              "wallet not found",
		addr:              "randomaddr",
		wantMissingWallet: true,
		wantErr:           true,
	}}
	for _, test := range tests {
		tWallet.validAddr = test.wantValidAddr
		if test.wantMissingWallet {
			tCore.wallets = make(map[uint32]*xcWallet)
		}
		valid, err := tCore.ValidateAddress(test.addr, tUTXOAssetA.ID)
		if test.wantErr {
			if err != nil {
				continue
			}
			t.Fatalf("%s: expected error", test.name)
		}
		if test.wantValidAddr != valid {
			t.Fatalf("Got wrong response for address validation, got %v expected %v", valid, test.wantValidAddr)
		}
	}
}

func TestEstimateSendTxFee(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	tests := []struct {
		name              string
		asset             uint32
		estFee            uint64
		value             uint64
		subtract          bool
		wantMissingWallet bool
		wantErr           bool
	}{{
		name:     "ok",
		asset:    tUTXOAssetA.ID,
		subtract: true,
		estFee:   1e8,
		value:    1e8,
	}, {
		name:     "zero amount",
		asset:    tACCTAsset.ID,
		subtract: true,
		wantErr:  true,
	}, {
		name:     "subtract true and not withdrawer",
		asset:    tACCTAsset.ID,
		subtract: true,
		wantErr:  true,
		value:    1e8,
	}, {
		name:              "wallet not found",
		asset:             tUTXOAssetA.ID,
		wantErr:           true,
		wantMissingWallet: true,
		value:             1e8,
	}}

	for _, test := range tests {
		wallet, tWallet := newTWallet(test.asset)
		tCore.wallets[test.asset] = wallet
		if test.wantMissingWallet {
			delete(tCore.wallets, test.asset)
		}

		tWallet.estFee = test.estFee

		tWallet.estFeeErr = nil
		if test.wantErr {
			tWallet.estFeeErr = tErr
		}
		estimate, _, err := tCore.EstimateSendTxFee("addr", test.asset, test.value, test.subtract, false)
		if test.wantErr {
			if err != nil {
				continue
			}
			t.Fatalf("%s: expected error", test.name)
		}
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", test.name, err)
		}

		if estimate != test.estFee {
			t.Fatalf("%s: expected fee %v, got %v", test.name, test.estFee, estimate)
		}
		if !test.wantErr && err != nil {
			t.Fatalf("%s: unexpected error", test.name)
		}
	}
}
