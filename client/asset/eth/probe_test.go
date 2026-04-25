// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

//go:build !harness && !rpclive

package eth

import (
	"context"
	"errors"
	"testing"

	"decred.org/dcrdex/client/asset"
	dexeth "decred.org/dcrdex/dex/networks/eth"
	"github.com/ethereum/go-ethereum/common"
)

func newRedemption(secretHash [32]byte, secret []byte) *asset.Redemption {
	return &asset.Redemption{
		Spends: &asset.AuditInfo{
			Contract:   dexeth.EncodeContractData(0, secretHash[:]),
			SecretHash: secretHash[:],
			Coin: &coin{
				txHash: common.HexToHash("0x01"),
				value:  1,
			},
		},
		Secret: secret,
	}
}

func TestProbeRedeemOnChain_Achieved(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	var sh [32]byte
	copy(sh[:], []byte("redeemed-swap-secret-hash-xxxxxx"))
	eth.node.(*tMempoolNode).tContractor.swapMap = map[[32]byte]*dexeth.SwapState{
		sh: {State: dexeth.SSRedeemed},
	}

	red := newRedemption(sh, []byte("secret"))
	achieved, unknown, err := eth.probeRedeemOnChain(context.Background(), []*asset.Redemption{red})
	if err != nil {
		t.Fatalf("probeRedeemOnChain: %v", err)
	}
	if unknown {
		t.Fatal("unexpected unknown=true on healthy probe")
	}
	if !achieved {
		t.Fatal("expected achieved=true for SSRedeemed swap")
	}

	// Second call should hit the cache (no further RPC needed).
	achieved2, _, _ := eth.probeRedeemOnChain(context.Background(), []*asset.Redemption{red})
	if !achieved2 {
		t.Fatal("expected cache hit to return achieved=true")
	}
}

func TestProbeRedeemOnChain_NotYetRedeemed(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	var sh [32]byte
	copy(sh[:], []byte("not-yet-redeemed-secret-hash-yyy"))
	eth.node.(*tMempoolNode).tContractor.swapMap = map[[32]byte]*dexeth.SwapState{
		sh: {State: dexeth.SSInitiated},
	}

	red := newRedemption(sh, []byte("secret"))
	achieved, unknown, err := eth.probeRedeemOnChain(context.Background(), []*asset.Redemption{red})
	if err != nil {
		t.Fatalf("probeRedeemOnChain: %v", err)
	}
	if achieved || unknown {
		t.Fatalf("expected achieved=false unknown=false; got achieved=%v unknown=%v", achieved, unknown)
	}
}

func TestProbeRedeemOnChain_Unknown(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	var sh [32]byte
	copy(sh[:], []byte("unknown-state-secret-hash-zzzzzz"))
	c := eth.node.(*tMempoolNode).tContractor
	c.swapMap = map[[32]byte]*dexeth.SwapState{}
	c.swapErr = errors.New("execution reverted")

	red := newRedemption(sh, []byte("secret"))
	achieved, unknown, err := eth.probeRedeemOnChain(context.Background(), []*asset.Redemption{red})
	if !unknown {
		t.Fatalf("expected unknown=true under provider error, got achieved=%v unknown=%v err=%v", achieved, unknown, err)
	}
	if achieved {
		t.Fatal("achieved must be false when unknown")
	}
	if err == nil {
		t.Fatal("err must be non-nil when unknown")
	}
}

func TestProbeRedeemOnChain_PartialRedeemed(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	var sh1, sh2 [32]byte
	copy(sh1[:], []byte("partial-1-secret-hash-aaaaaaaaaa"))
	copy(sh2[:], []byte("partial-2-secret-hash-bbbbbbbbbb"))
	eth.node.(*tMempoolNode).tContractor.swapMap = map[[32]byte]*dexeth.SwapState{
		sh1: {State: dexeth.SSRedeemed},
		sh2: {State: dexeth.SSInitiated}, // not yet redeemed
	}

	r1 := newRedemption(sh1, []byte("secret-1"))
	r2 := newRedemption(sh2, []byte("secret-2"))
	achieved, unknown, err := eth.probeRedeemOnChain(context.Background(), []*asset.Redemption{r1, r2})
	if err != nil {
		t.Fatalf("probeRedeemOnChain: %v", err)
	}
	if achieved {
		t.Fatal("expected achieved=false when only some swaps are SSRedeemed")
	}
	if unknown {
		t.Fatal("expected unknown=false when probe succeeded but result is negative")
	}
}

func TestProbeCacheFIFOEviction(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	// Insert one more than the cap; the first inserted should be evicted.
	for i := 0; i < probeCacheMaxEntries+1; i++ {
		eth.markProbeAchieved(OpKey([]byte{byte(i / 256), byte(i % 256), 'k'}))
	}
	if len(eth.probeCache.achieved) != probeCacheMaxEntries {
		t.Fatalf("expected map size capped at %d, got %d", probeCacheMaxEntries, len(eth.probeCache.achieved))
	}
	if len(eth.probeCache.order) != probeCacheMaxEntries {
		t.Fatalf("expected order slice capped at %d, got %d", probeCacheMaxEntries, len(eth.probeCache.order))
	}
	first := OpKey([]byte{0, 0, 'k'})
	if eth.probeAchieved(first) {
		t.Fatalf("expected first inserted key %q to have been evicted", first)
	}
	last := OpKey([]byte{byte(probeCacheMaxEntries / 256), byte(probeCacheMaxEntries % 256), 'k'})
	if !eth.probeAchieved(last) {
		t.Fatalf("expected last inserted key %q to still be cached", last)
	}

	// Re-marking an existing key should NOT extend the order slice.
	prevLen := len(eth.probeCache.order)
	eth.markProbeAchieved(last)
	if len(eth.probeCache.order) != prevLen {
		t.Fatalf("re-marking should not grow the order slice; got %d want %d", len(eth.probeCache.order), prevLen)
	}
}

func TestProbeRefundOnChain(t *testing.T) {
	_, eth, _, shutdown := tassetWallet(BipID)
	defer shutdown()

	var sh [32]byte
	copy(sh[:], []byte("refunded-secret-hash-cccccccccc"))
	c := eth.node.(*tMempoolNode).tContractor
	c.swapMap = map[[32]byte]*dexeth.SwapState{
		sh: {State: dexeth.SSRefunded},
	}

	achieved, unknown, err := eth.probeRefundOnChain(context.Background(), sh[:], 0)
	if err != nil {
		t.Fatalf("probeRefundOnChain: %v", err)
	}
	if unknown || !achieved {
		t.Fatalf("expected achieved=true unknown=false; got achieved=%v unknown=%v", achieved, unknown)
	}

	// Negative: still SSInitiated.
	var sh2 [32]byte
	copy(sh2[:], []byte("not-refunded-yet-hash-dddddddddd"))
	c.swapMap[sh2] = &dexeth.SwapState{State: dexeth.SSInitiated}
	achieved, unknown, err = eth.probeRefundOnChain(context.Background(), sh2[:], 0)
	if err != nil {
		t.Fatalf("probeRefundOnChain: %v", err)
	}
	if achieved || unknown {
		t.Fatalf("expected achieved=false unknown=false; got achieved=%v unknown=%v", achieved, unknown)
	}
}
