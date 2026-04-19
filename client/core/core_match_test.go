//go:build !harness && !botlive

package core

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/db"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/encode"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
	"decred.org/dcrdex/server/account"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

func TestHandlePreimageRequest(t *testing.T) {
	t.Run("basic checks", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		oid := ord.ID()
		preImg := newPreimage()

		// It is no longer OK for server to omit the commitment.
		payload := &msgjson.PreimageRequest{
			OrderID: oid[:],
			// No commitment in this request.
		}
		reqNoCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)
		// mkt := dc.marketConfig(tDcrBtcMktName)

		tracker := &trackedTrade{
			Order:    ord,
			preImg:   preImg,
			mktID:    tDcrBtcMktName,
			db:       rig.db,
			dc:       rig.dc,
			metaData: &db.OrderMetaData{},
		}

		// resetCsum resets csum for further preimage request since multiple
		// testing scenarios use the same tracker object.
		resetCsum := func(tracker *trackedTrade) {
			tracker.csumMtx.Lock()
			tracker.csum = nil
			tracker.csumMtx.Unlock()
		}

		rig.dc.trades[oid] = tracker
		err := handlePreimageRequest(rig.core, rig.dc, reqNoCommit)
		if err == nil {
			t.Fatalf("handlePreimageRequest succeeded with no commitment in the request")
		}
		resetCsum(tracker)

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitSig := readyCommitment(commit)
		payload = &msgjson.PreimageRequest{
			OrderID:    oid[:],
			Commitment: commit[:],
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		notes := rig.core.NotificationFeed()

		rig.dc.trades[oid] = tracker
		err = handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}
		resetCsum(tracker)

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case note := <-notes.C:
			if note.Topic() != TopicPreimageSent {
				t.Fatalf("note subject is %v, not %v", note.Topic(), TopicPreimageSent)
			}
		case <-time.After(time.Second):
			t.Fatal("no order note from preimage request handling")
		}

		// negative paths
		ensureErr := func(tag string, req *msgjson.Message, errPrefix string) {
			t.Helper()
			commitSig := readyCommitment(commit)
			close(commitSig) // ready before preimage request
			err := handlePreimageRequest(rig.core, rig.dc, req)
			if err == nil {
				t.Fatalf("%s: no error", tag)
			}
			if !strings.HasPrefix(err.Error(), errPrefix) {
				t.Fatalf("expected error starting with %q, got %q", errPrefix, err)
			}
			resetCsum(tracker)
		}

		// unknown commitment in request
		payloadBad := &msgjson.PreimageRequest{
			OrderID:    oid[:],
			Commitment: encode.RandomBytes(order.CommitmentSize), // junk, but correct length
		}
		reqCommitBad, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payloadBad)
		ensureErr("unknown commitment", reqCommitBad, "received preimage request for unknown commitment")
	})
	t.Run("csum for order", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		oid := ord.ID()
		preImg := newPreimage()
		// mkt := dc.marketConfig(tDcrBtcMktName)

		tracker := &trackedTrade{
			Order:    ord,
			preImg:   preImg,
			mktID:    tDcrBtcMktName,
			db:       rig.db,
			dc:       rig.dc,
			metaData: &db.OrderMetaData{},
		}

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitCSum := dex.Bytes{2, 3, 5, 7, 11, 13}
		commitSig := readyCommitment(commit)
		payload := &msgjson.PreimageRequest{
			OrderID:        oid[:],
			Commitment:     commit[:],
			CommitChecksum: commitCSum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		notes := rig.core.NotificationFeed()

		rig.dc.trades[oid] = tracker
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case note := <-notes.C:
			if note.Topic() != TopicPreimageSent {
				t.Fatalf("note subject is %v, not %v", note.Topic(), TopicPreimageSent)
			}
		case <-time.After(time.Second):
			t.Fatal("no order note from preimage request handling")
		}

		tracker.csumMtx.RLock()
		csum := tracker.csum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(commitCSum, csum) {
			t.Fatalf(
				"handlePreimageRequest must initialize tracker csum, exp: %s, got: %s",
				commitCSum,
				csum,
			)
		}

	})
	t.Run("more than one preimage request for order (different csums)", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		oid := ord.ID()
		preImg := newPreimage()
		// mkt := dc.marketConfig(tDcrBtcMktName)
		firstCSum := dex.Bytes{2, 3, 5, 7, 11, 13}

		tracker := &trackedTrade{
			Order:  ord,
			preImg: preImg,
			mktID:  tDcrBtcMktName,
			db:     rig.db,
			dc:     rig.dc,
			// Simulate first preimage request by initializing csum here.
			csum:     firstCSum,
			metaData: &db.OrderMetaData{},
		}

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitSig := readyCommitment(commit)
		secondCSum := dex.Bytes{2, 3, 5, 7, 11, 14}
		payload := &msgjson.PreimageRequest{
			OrderID:        oid[:],
			Commitment:     commit[:],
			CommitChecksum: secondCSum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		// Prepare to have processPreimageRequest respond with a payload with
		// the Error field set.
		rig.ws.sendMsgErrChan = make(chan *msgjson.Error, 1)
		defer func() { rig.ws.sendMsgErrChan = nil }()

		rig.dc.trades[oid] = tracker
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case msgErr := <-rig.ws.sendMsgErrChan:
			if msgErr.Code != msgjson.InvalidRequestError {
				t.Fatalf("expected error code %d got %d", msgjson.InvalidRequestError, msgErr.Code)
			}
		case <-time.After(time.Second):
			t.Fatal("no msgjson.Error sent from preimage request handling")
		}

		tracker.csumMtx.RLock()
		csum := tracker.csum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(firstCSum, csum) {
			t.Fatalf(
				"[handlePreimageRequest] csum was changed, exp: %s, got: %s",
				firstCSum,
				csum,
			)
		}

	})
	t.Run("more than one preimage request for order (same csum)", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		oid := ord.ID()
		preImg := newPreimage()
		// mkt := dc.marketConfig(tDcrBtcMktName)
		csum := dex.Bytes{2, 3, 5, 7, 11, 13}

		tracker := &trackedTrade{
			Order:  ord,
			preImg: preImg,
			mktID:  tDcrBtcMktName,
			db:     rig.db,
			dc:     rig.dc,
			// Simulate first preimage request by initializing csum here.
			csum:     csum,
			metaData: &db.OrderMetaData{},
		}

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitSig := readyCommitment(commit)
		payload := &msgjson.PreimageRequest{
			OrderID:        oid[:],
			Commitment:     commit[:],
			CommitChecksum: csum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		notes := rig.core.NotificationFeed()

		rig.dc.trades[oid] = tracker
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case note := <-notes.C:
			if note.Topic() != TopicPreimageSent {
				t.Fatalf("note subject is %v, not %v", note.Topic(), TopicPreimageSent)
			}
		case <-time.After(time.Second):
			t.Fatal("no order note from preimage request handling")
		}

		tracker.csumMtx.RLock()
		checkSum := tracker.csum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(csum, checkSum) {
			t.Fatalf(
				"[handlePreimageRequest] csum was changed, exp: %s, got: %s",
				csum,
				checkSum,
			)
		}
	})
	t.Run("csum for cancel order", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		preImg := newPreimage()
		mkt := rig.dc.marketConfig(tDcrBtcMktName)

		tracker := &trackedTrade{
			Order:    ord,
			preImg:   preImg,
			mktID:    tDcrBtcMktName,
			db:       rig.db,
			dc:       rig.dc,
			metaData: &db.OrderMetaData{},
			cancel: &trackedCancel{
				CancelOrder: order.CancelOrder{
					P: order.Prefix{
						AccountID:  rig.dc.acct.ID(),
						BaseAsset:  tUTXOAssetA.ID,
						QuoteAsset: tUTXOAssetB.ID,
						OrderType:  order.MarketOrderType,
						ClientTime: time.Now(),
						ServerTime: time.Now().Add(time.Millisecond),
						Commit:     preImg.Commit(),
					},
				},
				epochLen: mkt.EpochLen,
			},
		}
		oid := tracker.ID()
		cid := tracker.cancel.ID()

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitCSum := dex.Bytes{2, 3, 5, 7, 11, 13}
		commitSig := readyCommitment(commit)
		payload := &msgjson.PreimageRequest{
			OrderID:        cid[:],
			Commitment:     commit[:],
			CommitChecksum: commitCSum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		notes := rig.core.NotificationFeed()

		rig.dc.trades[oid] = tracker
		rig.dc.registerCancelLink(cid, oid)
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case note := <-notes.C:
			if note.Topic() != TopicCancelPreimageSent {
				t.Fatalf("note subject is %v, not %v", note.Topic(), TopicCancelPreimageSent)
			}
		case <-time.After(time.Second):
			t.Fatal("no order note from preimage request handling")
		}

		tracker.csumMtx.RLock()
		cancelCsum := tracker.cancelCsum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(commitCSum, cancelCsum) {
			t.Fatalf(
				"handlePreimageRequest must initialize tracker cancel csum, exp: %s, got: %s",
				commitCSum,
				cancelCsum,
			)
		}

	})
	t.Run("more than one preimage request for cancel order (different csums)", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		preImg := newPreimage()
		mkt := rig.dc.marketConfig(tDcrBtcMktName)
		firstCSum := dex.Bytes{2, 3, 5, 7, 11, 13}

		tracker := &trackedTrade{
			Order:    ord,
			preImg:   preImg,
			mktID:    tDcrBtcMktName,
			db:       rig.db,
			dc:       rig.dc,
			metaData: &db.OrderMetaData{},
			// Simulate first preimage request by initializing csum here.
			cancelCsum: firstCSum,
			cancel: &trackedCancel{
				CancelOrder: order.CancelOrder{
					P: order.Prefix{
						AccountID:  rig.dc.acct.ID(),
						BaseAsset:  tUTXOAssetA.ID,
						QuoteAsset: tUTXOAssetB.ID,
						OrderType:  order.MarketOrderType,
						ClientTime: time.Now(),
						ServerTime: time.Now().Add(time.Millisecond),
						Commit:     preImg.Commit(),
					},
				},
				epochLen: mkt.EpochLen,
			},
		}
		oid := tracker.ID()
		cid := tracker.cancel.ID()

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		secondCSum := dex.Bytes{2, 3, 5, 7, 11, 14}
		commitSig := readyCommitment(commit)
		payload := &msgjson.PreimageRequest{
			OrderID:        cid[:],
			Commitment:     commit[:],
			CommitChecksum: secondCSum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		// Prepare to have processPreimageRequest respond with a payload with
		// the Error field set.
		rig.ws.sendMsgErrChan = make(chan *msgjson.Error, 1)
		defer func() { rig.ws.sendMsgErrChan = nil }()

		rig.dc.trades[oid] = tracker
		rig.dc.registerCancelLink(cid, oid)
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case msgErr := <-rig.ws.sendMsgErrChan:
			if msgErr.Code != msgjson.InvalidRequestError {
				t.Fatalf("expected error code %d got %d", msgjson.InvalidRequestError, msgErr.Code)
			}
		case <-time.After(time.Second):
			t.Fatal("no msgjson.Error sent from preimage request handling")
		}
		tracker.csumMtx.RLock()
		cancelCsum := tracker.cancelCsum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(firstCSum, cancelCsum) {
			t.Fatalf(
				"[handlePreimageRequest] cancel csum was changed, exp: %s, got: %s",
				firstCSum,
				cancelCsum,
			)
		}
	})
	t.Run("more than one preimage request for cancel order (same csum)", func(t *testing.T) {
		rig := newTestRig()
		defer rig.shutdown()
		ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
		preImg := newPreimage()
		mkt := rig.dc.marketConfig(tDcrBtcMktName)
		csum := dex.Bytes{2, 3, 5, 7, 11, 13}

		tracker := &trackedTrade{
			Order:    ord,
			preImg:   preImg,
			mktID:    tDcrBtcMktName,
			db:       rig.db,
			dc:       rig.dc,
			metaData: &db.OrderMetaData{},
			// Simulate first preimage request by initializing csum here.
			cancelCsum: csum,
			cancel: &trackedCancel{
				CancelOrder: order.CancelOrder{
					P: order.Prefix{
						AccountID:  rig.dc.acct.ID(),
						BaseAsset:  tUTXOAssetA.ID,
						QuoteAsset: tUTXOAssetB.ID,
						OrderType:  order.MarketOrderType,
						ClientTime: time.Now(),
						ServerTime: time.Now().Add(time.Millisecond),
						Commit:     preImg.Commit(),
					},
				},
				epochLen: mkt.EpochLen,
			},
		}
		oid := tracker.ID()
		cid := tracker.cancel.ID()

		// Test the new path with rig.core.sentCommits.
		readyCommitment := func(commit order.Commitment) chan struct{} {
			commitSig := make(chan struct{}) // close after fake order submission is "done"
			rig.core.sentCommitsMtx.Lock()
			rig.core.sentCommits[commit] = commitSig
			rig.core.sentCommitsMtx.Unlock()
			return commitSig
		}

		commit := preImg.Commit()
		commitSig := readyCommitment(commit)
		payload := &msgjson.PreimageRequest{
			OrderID:        cid[:],
			Commitment:     commit[:],
			CommitChecksum: csum,
		}
		reqCommit, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.PreimageRoute, payload)

		notes := rig.core.NotificationFeed()

		rig.dc.trades[oid] = tracker
		rig.dc.registerCancelLink(cid, oid)
		err := handlePreimageRequest(rig.core, rig.dc, reqCommit)
		if err != nil {
			t.Fatalf("handlePreimageRequest error: %v", err)
		}

		// It has gone async now, waiting for commitSig.
		// i.e. "Received preimage request for %v with no corresponding order submission response! Waiting..."
		close(commitSig) // pretend like the order submission just finished

		select {
		case note := <-notes.C:
			if note.Topic() != TopicCancelPreimageSent {
				t.Fatalf("note subject is %v, not %v", note.Topic(), TopicCancelPreimageSent)
			}
		case <-time.After(time.Second):
			t.Fatal("no order note from preimage request handling")
		}

		tracker.csumMtx.RLock()
		cancelCsum := tracker.cancelCsum
		tracker.csumMtx.RUnlock()
		if !bytes.Equal(csum, cancelCsum) {
			t.Fatalf(
				"[handlePreimageRequest] cancel csum was changed, exp: %s, got: %s",
				csum,
				cancelCsum,
			)
		}
	})
}

func TestHandleRevokeOrderMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)

	fundCoinDcrID := encode.RandomBytes(36)
	fundCoinDcr := &tCoin{id: fundCoinDcrID}

	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	// fundCoinBID := encode.RandomBytes(36)
	// fundCoinB := &tCoin{id: fundCoinBID}

	qty := 2 * dcrBtcLotSize
	rate := dcrBtcRateStep * 10
	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, qty, rate) // sell DCR
	lo.Coins = []order.CoinID{fundCoinDcrID}
	dbOrder.MetaData.Status = order.OrderStatusBooked
	oid := lo.ID()

	tDcrWallet.fundingCoins = asset.Coins{fundCoinDcr}

	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	// Not in dc.trades yet.

	// Send a request for the unknown order.
	payload := &msgjson.RevokeOrder{
		OrderID: oid[:],
	}
	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.RevokeOrderRoute, payload)

	// Ensure revoking a non-existent order generates an error.
	err = handleRevokeOrderMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleRevokeOrderMsg] expected a non-existent order")
	}

	// Now store the order in dc.trades, with a linked cancel order.
	tracker := newTrackedTrade(dbOrder, preImg, dc,
		rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, tDcrWallet.fundingCoins, rig.core.notify,
		rig.core.formatDetails, &rig.core.wg)
	preImgC := newPreimage()
	co := &order.CancelOrder{
		P: order.Prefix{
			ServerTime: time.Now(),
			Commit:     preImgC.Commit(),
		},
	}
	tracker.cancel = &trackedCancel{CancelOrder: *co}
	coid := co.ID()
	rig.dc.trades[oid] = tracker
	rig.dc.registerCancelLink(coid, oid)

	orderNotes, feedDone := orderNoteFeed(tCore)
	defer feedDone()

	// Revoke the cancel order, not the targeted order.
	payloadC := &msgjson.RevokeOrder{
		OrderID: coid[:],
	}
	reqC, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.RevokeOrderRoute, payloadC)
	err = handleRevokeOrderMsg(rig.core, rig.dc, reqC)
	if err != nil {
		t.Fatalf("handleRevokeOrderMsg error: %v", err)
	}

	verifyRevokeNotification(orderNotes, TopicFailedCancel, t)

	if tracker.metaData.Status == order.OrderStatusRevoked {
		t.Errorf("Incorrectly revoked the targeted order instead of clearing the cancel order!")
	}
	if tracker.cancel != nil {
		t.Fatalf("Did not clear the cancel order")
	}

	// Now revoke the actual trade order.
	err = handleRevokeOrderMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("handleRevokeOrderMsg error: %v", err)
	}

	verifyRevokeNotification(orderNotes, TopicOrderRevoked, t)

	if tracker.metaData.Status != order.OrderStatusRevoked {
		t.Errorf("expected order status %v, got %v", order.OrderStatusRevoked, tracker.metaData.Status)
	}
}

func TestHandleRevokeMatchMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)

	fundCoinDcrID := encode.RandomBytes(36)
	fundCoinDcr := &tCoin{id: fundCoinDcrID}

	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	// fundCoinBID := encode.RandomBytes(36)
	// fundCoinB := &tCoin{id: fundCoinBID}

	matchSize := 4 * dcrBtcLotSize
	cancelledQty := dcrBtcLotSize
	qty := 2*matchSize + cancelledQty
	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, qty, dcrBtcRateStep)
	lo.Coins = []order.CoinID{fundCoinDcrID}
	dbOrder.MetaData.Status = order.OrderStatusBooked
	oid := lo.ID()

	tDcrWallet.fundingCoins = asset.Coins{fundCoinDcr}

	mid := ordertest.RandomMatchID()
	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	tracker := newTrackedTrade(dbOrder, preImg, dc,
		rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, tDcrWallet.fundingCoins, rig.core.notify,
		rig.core.formatDetails, &rig.core.wg)

	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: mid},
			MetaData:  &db.MatchMetaData{},
		},
	}
	tracker.matches[mid] = match

	payload := &msgjson.RevokeMatch{
		OrderID: oid[:],
		MatchID: mid[:],
	}
	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.RevokeMatchRoute, payload)

	// Ensure revoking a non-existent order generates an error.
	err = handleRevokeMatchMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleRevokeMatchMsg] expected a non-existent order")
	}

	rig.dc.trades[oid] = tracker

	// Success
	err = handleRevokeMatchMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("handleRevokeMatchMsg error: %v", err)
	}
}

func TestHandleEpochOrderMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	ord := &order.LimitOrder{P: order.Prefix{ServerTime: time.Now()}}
	oid := ord.ID()
	payload := &msgjson.EpochOrderNote{
		BookOrderNote: msgjson.BookOrderNote{
			OrderNote: msgjson.OrderNote{
				MarketID: tDcrBtcMktName,
				OrderID:  oid.Bytes(),
			},
			TradeNote: msgjson.TradeNote{
				Side:     msgjson.BuyOrderNum,
				Rate:     4,
				Quantity: 10,
			},
		},
		Epoch: 1,
	}

	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.EpochOrderRoute, payload)

	// Ensure handling an epoch order associated with a non-existent orderbook
	// generates an error.
	err := handleEpochOrderMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleEpochOrderMsg] expected a non-existent orderbook error")
	}

	rig.dc.books[tDcrBtcMktName] = newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)

	err = handleEpochOrderMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleEpochOrderMsg] unexpected error: %v", err)
	}
}

func TestHandleMatchProofMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	pimg := newPreimage()
	cmt := pimg.Commit()

	seed, csum, err := makeMatchProof([]order.Preimage{pimg}, []order.Commitment{cmt})
	if err != nil {
		t.Fatalf("[makeMatchProof] unexpected error: %v", err)
	}

	payload := &msgjson.MatchProofNote{
		MarketID:  tDcrBtcMktName,
		Epoch:     1,
		Preimages: []dex.Bytes{pimg[:]},
		CSum:      csum[:],
		Seed:      seed[:],
	}

	eo := &msgjson.EpochOrderNote{
		BookOrderNote: msgjson.BookOrderNote{
			OrderNote: msgjson.OrderNote{
				MarketID: tDcrBtcMktName,
				OrderID:  encode.RandomBytes(order.OrderIDSize),
			},
		},
		Epoch:  1,
		Commit: cmt[:],
	}

	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.MatchProofRoute, payload)

	// Ensure match proof validation generates an error for a non-existent orderbook.
	err = handleMatchProofMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleMatchProofMsg] expected a non-existent orderbook error")
	}

	rig.dc.books[tDcrBtcMktName] = newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)

	err = rig.dc.books[tDcrBtcMktName].Enqueue(eo)
	if err != nil {
		t.Fatalf("[Enqueue] unexpected error: %v", err)
	}

	err = handleMatchProofMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleMatchProofMsg] unexpected error: %v", err)
	}
}

func TestSetEpoch(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	dc.books[tDcrBtcMktName] = newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)

	mktEpoch := func() uint64 {
		dc.epochMtx.RLock()
		defer dc.epochMtx.RUnlock()
		return dc.epoch[tDcrBtcMktName]
	}

	payload := &msgjson.MatchProofNote{
		MarketID: tDcrBtcMktName,
		Epoch:    1,
	}
	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.MatchProofRoute, payload)
	err := handleMatchProofMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("error advancing epoch: %v", err)
	}
	if mktEpoch() != 2 {
		t.Fatalf("expected epoch 2, got %d", mktEpoch())
	}

	payload.Epoch = 0
	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.MatchProofRoute, payload)
	err = handleMatchProofMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("error handling match proof: %v", err)
	}
	if mktEpoch() != 2 {
		t.Fatalf("epoch changed, expected epoch 2, got %d", mktEpoch())
	}
}

func TestHandleTradeSuspensionMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	tCore := rig.core
	dc := rig.dc
	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.Unlock(rig.crypter)

	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.Unlock(rig.crypter)

	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	rig.dc.books[tDcrBtcMktName] = newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)

	addTracker := func(coins asset.Coins) *trackedTrade {
		lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, 0, 0)
		oid := lo.ID()
		tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
			rig.db, rig.queue, walletSet, coins, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
		dc.trades[oid] = tracker
		return tracker
	}

	// Make a trade that has a single funding coin, no change coin, and no
	// active matches.
	fundCoinDcrID := encode.RandomBytes(36)
	freshTracker := addTracker(asset.Coins{&tCoin{id: fundCoinDcrID}})
	freshTracker.metaData.Status = order.OrderStatusBooked // suspend with purge only purges book orders since epoch orders are always processed first

	// Ensure a non-existent market cannot be suspended.
	payload := &msgjson.TradeSuspension{
		MarketID: "dcr_dcr",
	}

	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.SuspensionRoute, payload)
	err := handleTradeSuspensionMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleTradeSuspensionMsg] expected a market ID not found error")
	}

	newPayload := func() *msgjson.TradeSuspension {
		return &msgjson.TradeSuspension{
			MarketID:    tDcrBtcMktName,
			FinalEpoch:  100,
			SuspendTime: uint64(time.Now().Add(time.Millisecond * 20).UnixMilli()),
			Persist:     false, // Make sure the coins are returned.
		}
	}

	// Suspend a running market.
	rig.dc.cfgMtx.Lock()
	mktConf := rig.dc.findMarketConfig(tDcrBtcMktName)
	mktConf.StartEpoch = 12
	rig.dc.cfgMtx.Unlock()

	payload = newPayload()
	payload.SuspendTime = 0 // now

	orderNotes, feedDone := orderNoteFeed(tCore)
	defer feedDone()

	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.SuspensionRoute, payload)
	err = handleTradeSuspensionMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleTradeSuspensionMsg] unexpected error: %v", err)
	}

	verifyRevokeNotification(orderNotes, TopicOrderAutoRevoked, t)

	// Check that the funding coin was returned. Use the tradeMtx for
	// synchronization.
	dc.tradeMtx.Lock()
	if len(tDcrWallet.returnedCoins) != 1 || !bytes.Equal(tDcrWallet.returnedCoins[0].ID(), fundCoinDcrID) {
		t.Fatalf("funding coin not returned")
	}
	dc.tradeMtx.Unlock()

	// Make sure the change coin is returned for a trade with a change coin.
	delete(dc.trades, freshTracker.ID())
	swappedTracker := addTracker(nil)
	changeCoinID := encode.RandomBytes(36)
	swappedTracker.change = &tCoin{id: changeCoinID}
	swappedTracker.changeLocked = true
	swappedTracker.metaData.Status = order.OrderStatusBooked
	rig.dc.cfgMtx.Lock()
	mktConf.StartEpoch = 12 // make it appear running again first
	mktConf.FinalEpoch = 0
	mktConf.Persist = nil
	rig.dc.cfgMtx.Unlock()
	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.SuspensionRoute, payload)
	err = handleTradeSuspensionMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleTradeSuspensionMsg] unexpected error: %v", err)
	}
	// Check that the funding coin was returned.
	dc.tradeMtx.Lock()
	if len(tDcrWallet.returnedCoins) != 1 || !bytes.Equal(tDcrWallet.returnedCoins[0].ID(), changeCoinID) {
		t.Fatalf("change coin not returned")
	}
	tDcrWallet.returnedCoins = nil
	dc.tradeMtx.Unlock()

	// Make sure the coin isn't returned if there are unswapped matches.
	mid := ordertest.RandomMatchID()
	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: mid}, // Default status = NewlyMatched
			MetaData:  &db.MatchMetaData{},
		},
		counterConfirms: -1,
	}
	swappedTracker.matches[mid] = match
	rig.dc.cfgMtx.Lock()
	mktConf.StartEpoch = 12 // make it appear running again first
	rig.dc.cfgMtx.Unlock()
	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.SuspensionRoute, payload)
	err = handleTradeSuspensionMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleTradeSuspensionMsg] unexpected error: %v", err)
	}
	dc.tradeMtx.Lock()
	if tDcrWallet.returnedCoins != nil {
		t.Fatalf("change coin returned with active matches")
	}
	dc.tradeMtx.Unlock()

	// Ensure trades for a suspended market generate an error.
	form := &TradeForm{
		Host:    tDexHost,
		IsLimit: true,
		Sell:    true,
		Base:    tUTXOAssetA.ID,
		Quote:   tUTXOAssetB.ID,
		Qty:     dcrBtcLotSize * 10,
		Rate:    dcrBtcRateStep * 1000,
		TifNow:  false,
	}

	_, err = rig.core.Trade(tPW, form)
	if err == nil {
		t.Fatalf("expected a suspension market error")
	}
}

func TestHandleTradeResumptionMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	tCore := rig.core
	dcrWallet, _ := newTradingTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.Unlock(rig.crypter)

	btcWallet, _ := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.Unlock(rig.crypter)

	epochLen := rig.dc.marketConfig(tDcrBtcMktName).EpochLen

	handleLimit := func(msg *msgjson.Message, f msgFunc) error {
		// Need to stamp and sign the message with the server's key.
		msgOrder := new(msgjson.LimitOrder)
		err := msg.Unmarshal(msgOrder)
		if err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		lo := convertMsgLimitOrder(msgOrder)
		f(orderResponse(msg.ID, msgOrder, lo, false, false, false))
		return nil
	}

	tradeForm := &TradeForm{
		Host:    tDexHost,
		IsLimit: true,
		Sell:    true,
		Base:    tUTXOAssetA.ID,
		Quote:   tUTXOAssetB.ID,
		Qty:     dcrBtcLotSize * 10,
		Rate:    dcrBtcRateStep * 1000,
		TifNow:  false,
	}

	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)

	// Ensure a non-existent market cannot be suspended.
	payload := &msgjson.TradeResumption{
		MarketID: "dcr_dcr",
	}

	req, _ := msgjson.NewRequest(rig.dc.NextID(), msgjson.ResumptionRoute, payload)
	err := handleTradeResumptionMsg(rig.core, rig.dc, req)
	if err == nil {
		t.Fatal("[handleTradeResumptionMsg] expected a market ID not found error")
	}

	var resumeTime uint64
	newPayload := func() *msgjson.TradeResumption {
		return &msgjson.TradeResumption{
			MarketID:   tDcrBtcMktName,
			ResumeTime: resumeTime, // set the time to test the scheduling notification case, zero it for immediate resume
			StartEpoch: resumeTime / epochLen,
		}
	}

	// Notify of scheduled resume.
	rig.dc.cfgMtx.Lock()
	mktConf := rig.dc.findMarketConfig(tDcrBtcMktName)
	mktConf.StartEpoch = 12
	mktConf.FinalEpoch = mktConf.StartEpoch + 1 // long since closed
	rig.dc.cfgMtx.Unlock()

	resumeTime = uint64(time.Now().Add(time.Hour).UnixMilli())
	payload = newPayload()
	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.ResumptionRoute, payload)
	err = handleTradeResumptionMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleTradeResumptionMsg] unexpected error: %v", err)
	}

	// Should be suspended still, no trades
	_, err = rig.core.Trade(tPW, tradeForm)
	if err == nil {
		t.Fatal("trade was accepted for suspended market")
	}

	// Resume the market immediately.
	resumeTime = uint64(time.Now().UnixMilli())
	payload = newPayload()
	payload.ResumeTime = 0 // resume now, not scheduled
	req, _ = msgjson.NewRequest(rig.dc.NextID(), msgjson.ResumptionRoute, payload)
	err = handleTradeResumptionMsg(rig.core, rig.dc, req)
	if err != nil {
		t.Fatalf("[handleTradeResumptionMsg] unexpected error: %v", err)
	}

	// Ensure trades for a resumed market are processed without error.
	_, err = rig.core.Trade(tPW, tradeForm)
	if err != nil {
		t.Fatalf("unexpected trade error %v", err)
	}
}

func TestHandleNomatch(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	dcrWallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet

	walletSet, _, _, err := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	if err != nil {
		t.Fatalf("walletSet error: %v", err)
	}

	fundingCoins := asset.Coins{&tCoin{}}

	// Four types of order to check

	// 1. Immediate limit order
	loImmediate, dbOrder, preImgL, _ := makeLimitOrder(dc, true, dcrBtcLotSize*100, dcrBtcRateStep)
	loImmediate.Force = order.ImmediateTiF
	immediateOID := loImmediate.ID()
	immediateTracker := newTrackedTrade(dbOrder, preImgL, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundingCoins, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[immediateOID] = immediateTracker

	// 2. Standing limit order
	loStanding, dbOrder, preImgL, _ := makeLimitOrder(dc, true, dcrBtcLotSize*100, dcrBtcRateStep)
	loStanding.Force = order.StandingTiF
	standingOID := loStanding.ID()
	standingTracker := newTrackedTrade(dbOrder, preImgL, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundingCoins, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[standingOID] = standingTracker

	// 3. Cancel order.
	cancelOrder := &order.CancelOrder{
		P: order.Prefix{
			ServerTime: time.Now(),
		},
	}
	cancelOID := cancelOrder.ID()
	standingTracker.cancel = &trackedCancel{
		CancelOrder: *cancelOrder,
	}
	dc.registerCancelLink(cancelOID, standingOID)

	// 4. Market order.
	loWillBeMarket, dbOrder, preImgL, _ := makeLimitOrder(dc, true, dcrBtcLotSize*100, dcrBtcRateStep)
	mktOrder := &order.MarketOrder{
		P: loWillBeMarket.P,
		T: *loWillBeMarket.Trade().Copy(),
	}
	dbOrder.Order = mktOrder
	marketOID := mktOrder.ID()
	marketTracker := newTrackedTrade(dbOrder, preImgL, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, fundingCoins, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[marketOID] = marketTracker

	runNomatch := func(tag string, oid order.OrderID) {
		tracker, _ := dc.findOrder(oid)
		if tracker == nil {
			t.Fatalf("%s: order ID not found", tag)
		}
		payload := &msgjson.NoMatch{OrderID: oid[:]}
		req, _ := msgjson.NewRequest(dc.NextID(), msgjson.NoMatchRoute, payload)
		err := handleNoMatchRoute(tCore, dc, req)
		if err != nil {
			t.Fatalf("handleNoMatchRoute error: %v", err)
		}
	}

	checkTradeStatus := func(tag string, oid order.OrderID, expStatus order.OrderStatus) {
		tracker, _ := dc.findOrder(oid)
		if tracker.metaData.Status != expStatus {
			t.Fatalf("%s: wrong status. expected %s, got %s", tag, expStatus, tracker.metaData.Status)
		}
		if rig.db.lastStatusID != oid {
			t.Fatalf("%s: order status not stored", tag)
		}
		if rig.db.lastStatus != expStatus {
			t.Fatalf("%s: wrong order status stored. expected %s, got %s", tag, expStatus, rig.db.lastStatus)
		}
		if expStatus == order.OrderStatusExecuted {
			if tBtcWallet.returnedAddr != tracker.Trade().Address {
				t.Fatalf("%s: redemption address not returned", tag)
			}
		}
	}

	runNomatch("cancel", cancelOID)
	if rig.db.lastStatusID != cancelOID || rig.db.lastStatus != order.OrderStatusExecuted {
		t.Fatalf("cancel status not updated")
	}
	if rig.db.linkedFromID != standingOID || !rig.db.linkedToID.IsZero() {
		t.Fatalf("missed cancel not unlinked. wanted trade ID %s, got %s. wanted zeroed linked ID, got %s",
			standingOID, rig.db.linkedFromID, rig.db.linkedToID)
	}

	runNomatch("standing limit", standingOID)
	checkTradeStatus("standing limit", standingOID, order.OrderStatusBooked)

	runNomatch("immediate", immediateOID)
	checkTradeStatus("immediate", immediateOID, order.OrderStatusExecuted)

	runNomatch("market", marketOID)
	checkTradeStatus("market", marketOID, order.OrderStatusExecuted)

	// Unknown order should error.
	oid := ordertest.RandomOrderID()
	payload := &msgjson.NoMatch{OrderID: oid[:]}
	req, _ := msgjson.NewRequest(dc.NextID(), msgjson.NoMatchRoute, payload)
	err = handleNoMatchRoute(tCore, dc, req)
	if !errorHasCode(err, unknownOrderErr) {
		t.Fatalf("wrong error for unknown order ID: %v", err)
	}
}

func TestHandlePenaltyMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc
	penalty := &msgjson.Penalty{
		Rule:    account.Rule(1),
		Time:    uint64(1598929305),
		Details: "You may no longer trade. Leave your client running to finish pending trades.",
	}
	diffKey, _ := secp256k1.GeneratePrivateKey()
	noMatch, err := msgjson.NewNotification(msgjson.NoMatchRoute, "fake")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		key     *secp256k1.PrivateKey
		payload any
		wantErr bool
	}{{
		name:    "ok",
		key:     tDexPriv,
		payload: penalty,
	}, {
		name:    "bad note",
		key:     tDexPriv,
		payload: noMatch,
		wantErr: true,
	}, {
		name:    "wrong sig",
		key:     diffKey,
		payload: penalty,
		wantErr: true,
	}}
	for _, test := range tests {
		var err error
		var note *msgjson.Message
		switch v := test.payload.(type) {
		case *msgjson.Penalty:
			penaltyNote := &msgjson.PenaltyNote{
				Penalty: v,
			}
			sign(test.key, penaltyNote)
			note, err = msgjson.NewNotification(msgjson.PenaltyRoute, penaltyNote)
			if err != nil {
				t.Fatalf("error creating penalty notification: %v", err)
			}
		case *msgjson.Message:
			note = v
		default:
			t.Fatalf("unknown payload type: %T", v)
		}

		err = handlePenaltyMsg(tCore, dc, note)
		if test.wantErr {
			if err == nil {
				t.Fatalf("expected error for test %s", test.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", test.name, err)
		}
	}
}

func TestHandleMMEpochSnapshotMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	acctID := make([]byte, 32)
	copy(acctID, dc.acct.id[:])

	snap := &msgjson.MMEpochSnapshot{
		MarketID:  tDcrBtcMktName,
		Base:      tUTXOAssetA.ID,
		Quote:     tUTXOAssetB.ID,
		EpochIdx:  1000,
		EpochDur:  60000,
		AccountID: acctID,
		BuyOrders: []msgjson.SnapOrder{
			{Rate: 1e8, Qty: 2e8},
		},
		SellOrders: []msgjson.SnapOrder{
			{Rate: 3e8, Qty: 4e8},
		},
		BestBuy:  5e8,
		BestSell: 6e8,
	}

	diffKey, _ := secp256k1.GeneratePrivateKey()
	badPayload, err := msgjson.NewNotification(msgjson.NoMatchRoute, "fake")
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		key     *secp256k1.PrivateKey
		payload any
		wantErr bool
	}{{
		name:    "ok",
		key:     tDexPriv,
		payload: snap,
	}, {
		name:    "bad payload",
		key:     tDexPriv,
		payload: badPayload,
		wantErr: true,
	}, {
		name:    "wrong sig",
		key:     diffKey,
		payload: snap,
		wantErr: true,
	}}
	for _, test := range tests {
		var err error
		var note *msgjson.Message
		switch v := test.payload.(type) {
		case *msgjson.MMEpochSnapshot:
			snapCopy := *v
			sign(test.key, &snapCopy)
			note, err = msgjson.NewNotification(msgjson.MMEpochSnapshotRoute, &snapCopy)
			if err != nil {
				t.Fatalf("%s: error creating notification: %v", test.name, err)
			}
		case *msgjson.Message:
			note = v
		default:
			t.Fatalf("unknown payload type: %T", v)
		}

		err = handleMMEpochSnapshotMsg(tCore, dc, note)
		if test.wantErr {
			if err == nil {
				t.Fatalf("%s: expected error", test.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", test.name, err)
		}
	}
}

func TestMatchStatusResolution(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dc := rig.dc

	dcrWallet, _ := newTWallet(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, tBtcWallet := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet

	qty := 3 * dcrBtcLotSize
	secret := encode.RandomBytes(32)
	secretHash := sha256.Sum256(secret)

	lo, dbOrder, preImg, addr := makeLimitOrder(dc, true, qty, dcrBtcRateStep*10)
	tBtcWallet.redemptionAddr = addr
	tBtcWallet.validAddr = true
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)
	dbOrder.MetaData.Status = order.OrderStatusExecuted // so there is no order_status request for this
	oid := lo.ID()
	trade := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)

	dc.trades[trade.ID()] = trade
	matchID := ordertest.RandomMatchID()
	matchTime := time.Now()
	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			MetaData: &db.MatchMetaData{
				SwapAddr: addr,
			},
			UserMatch: &order.UserMatch{
				MatchID: matchID,
				Address: addr,
			},
		},
	}
	trade.matches[matchID] = match

	// oid order.OrderID, mid order.MatchID, recipient string, val uint64, secretHash []byte
	_, auditInfo := tMsgAudit(oid, matchID, addr, qty, secretHash[:])
	tBtcWallet.auditInfo = auditInfo

	connectMatches := func(status order.MatchStatus) []*msgjson.Match {
		return []*msgjson.Match{
			{
				OrderID: oid[:],
				MatchID: matchID[:],
				Status:  uint8(status),
				Side:    uint8(match.Side),
			},
		}

	}

	tBytes := encode.RandomBytes(2)
	tCoinID := encode.RandomBytes(36)
	tTxData := encode.RandomBytes(1)

	setAuthSigs := func(status order.MatchStatus) {
		isMaker := match.Side == order.Maker
		match.MetaData.Proof.Auth = db.MatchAuth{}
		auth := &match.MetaData.Proof.Auth
		auth.MatchStamp = uint64(matchTime.UnixMilli())
		if status >= order.MakerSwapCast {
			if isMaker {
				auth.InitSig = tBytes
			} else {
				auth.AuditSig = tBytes
			}
		}
		if status >= order.TakerSwapCast {
			if isMaker {
				auth.AuditSig = tBytes
			} else {
				auth.InitSig = tBytes
			}
		}
		if status >= order.MakerRedeemed {
			if isMaker {
				auth.RedeemSig = tBytes
			} else {
				auth.RedemptionSig = tBytes
			}
		}
		if status >= order.MatchComplete {
			if isMaker {
				auth.RedemptionSig = tBytes
			} else {
				auth.RedeemSig = tBytes
			}
		}
	}

	// Call setProof before setAuthSigs
	setProof := func(status order.MatchStatus) {
		isMaker := match.Side == order.Maker
		match.Status = status
		match.MetaData.Proof = db.MatchProof{}
		proof := &match.MetaData.Proof

		if isMaker {
			auditInfo.Expiration = matchTime.Add(trade.lockTimeTaker)
		} else {
			auditInfo.Expiration = matchTime.Add(trade.lockTimeMaker)
		}

		if status >= order.MakerSwapCast {
			proof.MakerSwap = tCoinID
			proof.SecretHash = secretHash[:]
			if isMaker {
				proof.ContractData = tBytes
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
				proof.ContractData = tBytes
			}
		}
		if status >= order.MakerRedeemed {
			proof.MakerRedeem = tCoinID
			if !isMaker {
				proof.Secret = secret
			}
		}
		if status >= order.MatchComplete {
			proof.TakerRedeem = tCoinID
		}
	}

	setLocalMatchStatus := func(proofStatus, authStatus order.MatchStatus) {
		setProof(proofStatus)
		setAuthSigs(authStatus)
	}

	var tMatchResults *msgjson.MatchStatusResult
	setMatchResults := func(status order.MatchStatus) *msgjson.MatchStatusResult {
		tMatchResults = &msgjson.MatchStatusResult{
			MatchID: matchID[:],
			Status:  uint8(status),
			Active:  status != order.MatchComplete,
		}
		if status >= order.MakerSwapCast {
			tMatchResults.MakerContract = tBytes
			tMatchResults.MakerSwap = tCoinID
		}
		if status == order.MakerSwapCast || status == order.TakerSwapCast {
			tMatchResults.TakerTxData = tTxData
		}
		if status >= order.TakerSwapCast {
			tMatchResults.TakerContract = tBytes
			tMatchResults.TakerSwap = tCoinID
		}
		if status >= order.MakerRedeemed {
			tMatchResults.MakerRedeem = tCoinID
			tMatchResults.Secret = secret
		}
		if status >= order.MatchComplete {
			tMatchResults.TakerRedeem = tCoinID
		}
		return tMatchResults
	}

	type test struct {
		ours, servers      order.MatchStatus
		side               order.MatchSide
		tweaker            func()
		countStatusUpdates int
	}

	testName := func(tt *test) string {
		return fmt.Sprintf("%s / %s (%s)", tt.ours, tt.servers, tt.side)
	}

	runTest := func(tt *test) order.MatchStatus {
		match.Side = tt.side
		setLocalMatchStatus(tt.ours, tt.servers)
		setMatchResults(tt.servers)
		if tt.tweaker != nil {
			tt.tweaker()
		}
		rig.queueConnect(nil, connectMatches(tt.servers), nil)
		rig.ws.queueResponse(msgjson.MatchStatusRoute, func(msg *msgjson.Message, f msgFunc) error {
			resp, _ := msgjson.NewResponse(msg.ID, []*msgjson.MatchStatusResult{tMatchResults}, nil)
			f(resp)
			return nil
		})
		if tt.countStatusUpdates > 0 {
			rig.db.updateMatchChan = make(chan order.MatchStatus, tt.countStatusUpdates)
		}
		if err := tCore.authDEX(dc); err != nil {
			t.Fatalf("unexpected authDEX error: %v", err)
		}
		for i := 0; i < tt.countStatusUpdates; i++ {
			<-rig.db.updateMatchChan
		}
		rig.db.updateMatchChan = nil
		trade.mtx.Lock()
		newStatus := match.Status
		trade.mtx.Unlock()
		return newStatus
	}

	// forwardResolvers are recoverable status combos where the server is ahead
	// of us.
	forwardResolvers := []*test{
		{
			ours:               order.NewlyMatched,
			servers:            order.MakerSwapCast,
			side:               order.Taker,
			countStatusUpdates: 2,
		},
		{
			ours:               order.MakerSwapCast,
			servers:            order.TakerSwapCast,
			side:               order.Maker,
			countStatusUpdates: 2,
		},
		{
			ours:    order.TakerSwapCast,
			servers: order.MakerRedeemed,
			side:    order.Taker,
		},
		{
			ours:    order.MakerRedeemed,
			servers: order.MatchComplete,
			side:    order.Maker,
		},
	}

	// Check that all of the forwardResolvers update the match status.
	for _, tt := range forwardResolvers {
		newStatus := runTest(tt)
		if newStatus == tt.ours {
			t.Fatalf("(%s) status not updated for forward resolution path", testName(tt))
		}
		if match.MetaData.Proof.SelfRevoked {
			t.Fatalf("(%s) match self-revoked during forward resolution", testName(tt))
		}
	}

	// backwardsResolvers are recoverable status mismatches where we are ahead
	// of the server but can be resolved by deferring to resendPendingRequests.
	backWardsResolvers := []*test{
		{
			ours:    order.MakerSwapCast,
			servers: order.NewlyMatched,
			side:    order.Maker,
		},
		{
			ours:    order.TakerSwapCast,
			servers: order.MakerSwapCast,
			side:    order.Taker,
		},
		{
			ours:    order.MakerRedeemed,
			servers: order.TakerSwapCast,
			side:    order.Maker,
		},
		{
			ours:    order.MatchComplete,
			servers: order.MakerRedeemed,
			side:    order.Taker,
		},
	}

	// Backwards resolvers won't update the match status, but also won't revoke
	// the match.
	for _, tt := range backWardsResolvers {
		newStatus := runTest(tt)
		if newStatus != tt.ours {
			t.Fatalf("(%s) status changed for backwards resolution path", testName(tt))
		}
		if match.MetaData.Proof.SelfRevoked {
			t.Fatalf("(%s) match self-revoked during backwards resolution", testName(tt))
		}
	}

	// nonsense are status combos that make no sense, so should always result
	// in a self-revocation.
	nonsense := []*test{
		{ // Server has our info before us
			ours:    order.NewlyMatched,
			servers: order.MakerSwapCast,
			side:    order.Maker,
		},
		{ // Two steps apart
			ours:    order.NewlyMatched,
			servers: order.TakerSwapCast,
			side:    order.Maker,
		},
		{ // Server didn't send contract
			ours:    order.NewlyMatched,
			servers: order.MakerSwapCast,
			side:    order.Taker,
			tweaker: func() {
				tMatchResults.MakerContract = nil
			},
		},
		{ // Server didn't send coin ID.
			ours:    order.NewlyMatched,
			servers: order.MakerSwapCast,
			side:    order.Taker,
			tweaker: func() {
				tMatchResults.MakerSwap = nil
			},
		},
		{ // Audit failed.
			ours:    order.NewlyMatched,
			servers: order.MakerSwapCast,
			side:    order.Taker,
			tweaker: func() {
				auditInfo.Expiration = matchTime
			},
			countStatusUpdates: 2, // async auditContract -> revoke and db update
		},
		{ // Server has our info before us
			ours:    order.MakerSwapCast,
			servers: order.TakerSwapCast,
			side:    order.Taker,
		},
		{ // Server has our info before us
			ours:    order.MakerSwapCast,
			servers: order.TakerSwapCast,
			side:    order.Taker,
		},
		{ // Server didn't send contract
			ours:    order.MakerSwapCast,
			servers: order.TakerSwapCast,
			side:    order.Maker,
			tweaker: func() {
				tMatchResults.TakerContract = nil
			},
		},
		{ // Server didn't send coin ID.
			ours:    order.MakerSwapCast,
			servers: order.TakerSwapCast,
			side:    order.Maker,
			tweaker: func() {
				tMatchResults.TakerSwap = nil
			},
		},
		{ // Audit failed.
			ours:    order.MakerSwapCast,
			servers: order.TakerSwapCast,
			side:    order.Maker,
			tweaker: func() {
				auditInfo.Expiration = matchTime
			},
			countStatusUpdates: 2, // async auditContract -> revoke and db update
		},
		{ // Taker has counter-party info the server doesn't.
			ours:    order.MakerSwapCast,
			servers: order.NewlyMatched,
			side:    order.Taker,
		},
		{ // Maker has a server ack, but they say they don't have the data.
			ours:    order.MakerSwapCast,
			servers: order.NewlyMatched,
			side:    order.Maker,
			tweaker: func() {
				match.MetaData.Proof.Auth.InitSig = tBytes
			},
		},
		{ // Maker has counter-party info the server doesn't.
			ours:    order.TakerSwapCast,
			servers: order.MakerSwapCast,
			side:    order.Maker,
		},
		{ // Taker has a server ack, but they say they don't have the data.
			ours:    order.TakerSwapCast,
			servers: order.MakerSwapCast,
			side:    order.Taker,
			tweaker: func() {
				match.MetaData.Proof.Auth.InitSig = tBytes
			},
		},
		{ // Server has redeem info before us.
			ours:    order.TakerSwapCast,
			servers: order.MakerRedeemed,
			side:    order.Maker,
		},
		{ // Server didn't provide redemption coin ID.
			ours:    order.TakerSwapCast,
			servers: order.MakerRedeemed,
			side:    order.Taker,
			tweaker: func() {
				tMatchResults.MakerRedeem = nil
			},
		},
		{ // Server didn't provide secret.
			ours:    order.TakerSwapCast,
			servers: order.MakerRedeemed,
			side:    order.Taker,
			tweaker: func() {
				tMatchResults.Secret = nil
			},
		},
		{ // Server has our redemption data before us.
			ours:    order.MakerRedeemed,
			servers: order.MatchComplete,
			side:    order.Taker,
		},
		{ // We have data before the server.
			ours:    order.MakerRedeemed,
			servers: order.TakerSwapCast,
			side:    order.Taker,
		},
		{ // We have a server ack, but they say they don't have the data.
			ours:    order.MakerRedeemed,
			servers: order.TakerSwapCast,
			side:    order.Maker,
			tweaker: func() {
				match.MetaData.Proof.Auth.RedeemSig = tBytes
			},
		},
		{ // We have data before the server.
			ours:    order.MatchComplete,
			servers: order.MakerSwapCast,
			side:    order.Maker,
		},
		{ // We have a server ack, but they say they don't have the data.
			ours:    order.MatchComplete,
			servers: order.MakerSwapCast,
			side:    order.Taker,
			tweaker: func() {
				match.MetaData.Proof.Auth.RedeemSig = tBytes
			},
		},
	}

	for _, tt := range nonsense {
		runTest(tt)
		if !match.MetaData.Proof.SelfRevoked {
			t.Fatalf("(%s) match not self-revoked during nonsense resolution", testName(tt))
		}
	}

	// Run two matches for the same order. Clear the cross-match dedup maps
	// since earlier test iterations may have populated them. Use
	// auditInfoFunc to return unique coin IDs and secret hashes per call
	// so the cross-match dedup doesn't fire.
	dc.activeContractsMtx.Lock()
	dc.activeCoinIDs = make(map[string]order.MatchID)
	dc.activeSecretHashes = make(map[string]order.MatchID)
	dc.activeContractsMtx.Unlock()
	tBtcWallet.auditInfoFunc = func(coinID, contract, txData dex.Bytes) (*asset.AuditInfo, error) {
		return &asset.AuditInfo{
			Recipient:  addr,
			Coin:       &tCoin{id: coinID, val: qty},
			Contract:   contract,
			SecretHash: encode.RandomBytes(32),
			Expiration: auditInfo.Expiration,
		}, nil
	}
	defer func() { tBtcWallet.auditInfoFunc = nil }()

	match2ID := ordertest.RandomMatchID()
	match2 := &matchTracker{
		MetaMatch: db.MetaMatch{
			MetaData: &db.MatchMetaData{
				SwapAddr: addr,
			},
			UserMatch: &order.UserMatch{
				MatchID: match2ID,
				Address: addr,
			},
		},
	}
	trade.matches[match2ID] = match2
	setAuthSigs(order.NewlyMatched)
	setProof(order.NewlyMatched)
	match2.Side = order.Taker
	match2.MetaData.Proof = match.MetaData.Proof

	srvMatches := connectMatches(order.MakerSwapCast)
	srvMatches = append(srvMatches, &msgjson.Match{OrderID: oid[:],
		MatchID: match2ID[:],
		Status:  uint8(order.MakerSwapCast),
		Side:    uint8(order.Taker),
	})

	res1 := setMatchResults(order.MakerSwapCast)
	res2 := setMatchResults(order.MakerSwapCast)
	res2.MatchID = match2ID[:]
	res2.MakerSwap = encode.RandomBytes(36)

	rig.queueConnect(nil, srvMatches, nil)
	rig.ws.queueResponse(msgjson.MatchStatusRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, []*msgjson.MatchStatusResult{res1, res2}, nil)
		f(resp)
		return nil
	})
	// 2 matches resolved via contract audit: 2 synchronous updates, 2 async
	rig.db.updateMatchChan = make(chan order.MatchStatus, 4)
	tCore.authDEX(dc)
	for i := 0; i < 4; i++ {
		<-rig.db.updateMatchChan
	}
	trade.mtx.Lock()
	newStatus1 := match.Status
	newStatus2 := match2.Status
	trade.mtx.Unlock()
	if newStatus1 != order.MakerSwapCast {
		t.Fatalf("wrong status for match 1: %s", newStatus1)
	}
	if newStatus2 != order.MakerSwapCast {
		t.Fatalf("wrong status for match 2: %s", newStatus2)
	}
}

func TestHandleCounterPartyAddressMsg(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	dc := rig.dc
	tCore := rig.core

	lo, dbOrder, preImg, _ := makeLimitOrder(dc, true, 3*dcrBtcLotSize, dcrBtcRateStep*10)
	oid := lo.ID()

	dcrWallet, tDcrWallet := newTWallet(tUTXOAssetA.ID)
	tDcrWallet.validAddr = true // fromWallet for sell order validates counterparty addresses
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	btcWallet, _ := newTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	walletSet, _, _, _ := tCore.walletSet(dc, tUTXOAssetA.ID, tUTXOAssetB.ID, true)

	tracker := newTrackedTrade(dbOrder, preImg, dc, rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify, rig.core.formatDetails, &rig.core.wg)
	dc.trades[oid] = tracker

	matchID := ordertest.RandomMatchID()
	match := &matchTracker{
		MetaMatch: db.MetaMatch{
			UserMatch: &order.UserMatch{MatchID: matchID},
			MetaData:  &db.MatchMetaData{},
		},
	}
	tracker.matches[matchID] = match

	// Test 1: Valid counterparty_address message.
	cpa := &msgjson.CounterPartyAddress{
		OrderID: oid[:],
		MatchID: matchID[:],
		Address: "counterparty-per-match-addr",
	}
	sign(tDexPriv, cpa)
	msg, _ := msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa)
	err := handleCounterPartyAddressMsg(tCore, dc, msg)
	if err != nil {
		t.Fatalf("valid counterparty_address failed: %v", err)
	}
	if match.MetaData.CounterPartyAddr != "counterparty-per-match-addr" {
		t.Fatalf("expected counterparty addr %q, got %q",
			"counterparty-per-match-addr", match.MetaData.CounterPartyAddr)
	}

	// Test 2: Bad signature.
	cpa2 := &msgjson.CounterPartyAddress{
		OrderID: oid[:],
		MatchID: matchID[:],
		Address: "other-addr",
	}
	cpa2.SetSig([]byte{0x01, 0x02}) // bad sig
	msg, _ = msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa2)
	err = handleCounterPartyAddressMsg(tCore, dc, msg)
	if err == nil {
		t.Fatal("expected error for bad signature")
	}

	// Test 3: Unknown order.
	unknownOID := ordertest.RandomOrderID()
	cpa3 := &msgjson.CounterPartyAddress{
		OrderID: unknownOID[:],
		MatchID: matchID[:],
		Address: "addr",
	}
	sign(tDexPriv, cpa3)
	msg, _ = msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa3)
	err = handleCounterPartyAddressMsg(tCore, dc, msg)
	if err == nil {
		t.Fatal("expected error for unknown order")
	}

	// Test 4: Empty address.
	cpa4 := &msgjson.CounterPartyAddress{
		OrderID: oid[:],
		MatchID: matchID[:],
		Address: "",
	}
	sign(tDexPriv, cpa4)
	msg, _ = msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa4)
	err = handleCounterPartyAddressMsg(tCore, dc, msg)
	if err == nil {
		t.Fatal("expected error for empty address")
	}

	// Test 5: Invalid address (wallet rejects it).
	tDcrWallet.validAddr = false
	cpa5 := &msgjson.CounterPartyAddress{
		OrderID: oid[:],
		MatchID: matchID[:],
		Address: "invalid-address",
	}
	sign(tDexPriv, cpa5)
	msg, _ = msgjson.NewNotification(msgjson.CounterPartyAddressRoute, cpa5)
	err = handleCounterPartyAddressMsg(tCore, dc, msg)
	if err == nil {
		t.Fatal("expected error for invalid address")
	}
	tDcrWallet.validAddr = true
}
