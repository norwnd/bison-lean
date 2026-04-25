// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package eth

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"decred.org/dcrdex/client/asset"
	dexeth "decred.org/dcrdex/dex/networks/eth"
	"github.com/ethereum/go-ethereum/common"
)

// On-chain probe layer (Phase 5).
//
// The probe answers a single question for a logical wallet operation: has the
// operation's effect already happened on-chain? It is the source of truth for
// the Op-layer state machine introduced in Phases 6–8 — Op transitions to
// Confirmed are driven by probe results, not by individual tx receipts.
//
// Each probe returns three signals:
//   - achieved == true:  the on-chain state matches the operation's intended
//                        effect. Caller may treat the operation as Confirmed.
//   - unknown == true:   probe results were inconsistent or all RPC providers
//                        erred. Caller MUST NOT broadcast a duplicate; back
//                        off and retry later.
//   - achieved == false && unknown == false: the on-chain state does not yet
//                        reflect the operation. Caller may proceed to broadcast.
//
// Positive results are terminal under normal conditions and are cached in
// baseWallet.probeCache so subsequent probes for the same OpKey short-circuit
// without an RPC. Negative and unknown results are not cached.
//
// Probes ride withContractor and therefore inherit the multi-RPC client's
// provider rotation. They MUST be called with no wallet locks held: each
// makes one or more RPC calls and could otherwise stall the receipt-update /
// nonce-allocation paths.

// probeCacheMaxEntries is the FIFO cap on the in-memory probe-result cache.
// Entries are tiny (one OpKey string + a struct{}), so 1024 ≈ tens of KiB.
// Eviction runs only when a brand-new key would push us above the cap.
const probeCacheMaxEntries = 1024

// probeAchieved reports whether a positive result is cached for the given
// OpKey.
func (w *baseWallet) probeAchieved(key OpKey) bool {
	w.probeCache.Lock()
	defer w.probeCache.Unlock()
	_, ok := w.probeCache.achieved[key]
	return ok
}

// markProbeAchieved caches a positive probe result so subsequent calls for
// the same OpKey short-circuit. Evicts the oldest entries FIFO-style once
// the cache exceeds probeCacheMaxEntries.
func (w *baseWallet) markProbeAchieved(key OpKey) {
	w.probeCache.Lock()
	defer w.probeCache.Unlock()
	if w.probeCache.achieved == nil {
		w.probeCache.achieved = make(map[OpKey]struct{})
	}
	if _, ok := w.probeCache.achieved[key]; ok {
		return
	}
	w.probeCache.achieved[key] = struct{}{}
	w.probeCache.order = append(w.probeCache.order, key)
	for len(w.probeCache.order) > probeCacheMaxEntries {
		oldest := w.probeCache.order[0]
		w.probeCache.order = w.probeCache.order[1:]
		delete(w.probeCache.achieved, oldest)
	}
}

// acquireBridgeCompleteLock returns a release function that holds a
// per-initiation-tx mutex. Use to serialize concurrent CompleteBridge
// calls for the same initiation. The returned function MUST be called
// (typically `defer release()`); failure to release will deadlock
// future calls for this initiation.
//
// The map mutex is held only briefly (for map mutation); the per-key
// mutex is what's actually held during the critical section. Different
// initiations don't block each other.
func (w *baseWallet) acquireBridgeCompleteLock(initiationTxID string) func() {
	w.bridgeCompleteLocks.Lock()
	if w.bridgeCompleteLocks.m == nil {
		w.bridgeCompleteLocks.m = make(map[string]*sync.Mutex)
	}
	l, ok := w.bridgeCompleteLocks.m[initiationTxID]
	if !ok {
		l = &sync.Mutex{}
		w.bridgeCompleteLocks.m[initiationTxID] = l
	}
	w.bridgeCompleteLocks.Unlock()
	l.Lock()
	return l.Unlock
}

// probeRedeemOnChain checks whether all swaps in the given redemption set are
// already SSRedeemed on-chain. Used to make Redeem() idempotent and to detect
// emergency or external redemptions. Probes serially; bails on the first
// definitive negative or first error.
func (w *assetWallet) probeRedeemOnChain(ctx context.Context, redemptions []*asset.Redemption) (achieved, unknown bool, err error) {
	if len(redemptions) == 0 {
		return false, false, errors.New("probeRedeemOnChain: no redemptions")
	}
	key := redeemKey(redemptions)
	if w.probeAchieved(key) {
		return true, false, nil
	}

	var contractVer uint32
	for i, r := range redemptions {
		if r == nil || r.Spends == nil {
			return false, false, errors.New("probeRedeemOnChain: nil redemption")
		}
		ver, locator, decErr := dexeth.DecodeContractData(r.Spends.Contract)
		if decErr != nil {
			return false, false, fmt.Errorf("probeRedeemOnChain: invalid contract data: %w", decErr)
		}
		if i == 0 {
			contractVer = ver
		} else if contractVer != ver {
			return false, false, fmt.Errorf("probeRedeemOnChain: inconsistent contract versions: %d vs %d", contractVer, ver)
		}
		status, _, statusErr := w.statusAndVector(ctx, locator, ver)
		if statusErr != nil {
			return false, true, fmt.Errorf("probeRedeemOnChain: status query failed: %w", statusErr)
		}
		if status.Step != dexeth.SSRedeemed {
			return false, false, nil
		}
	}
	w.markProbeAchieved(key)
	return true, false, nil
}

// probeRefundOnChain checks whether the swap identified by the locator is
// already SSRefunded on-chain.
func (w *assetWallet) probeRefundOnChain(ctx context.Context, locator []byte, contractVer uint32) (achieved, unknown bool, err error) {
	if len(locator) == 0 {
		return false, false, errors.New("probeRefundOnChain: empty locator")
	}
	key := refundKey(locator)
	if w.probeAchieved(key) {
		return true, false, nil
	}
	status, statusErr := w.status(ctx, locator, contractVer)
	if statusErr != nil {
		return false, true, fmt.Errorf("probeRefundOnChain: status query failed: %w", statusErr)
	}
	if status.Step != dexeth.SSRefunded {
		return false, false, nil
	}
	w.markProbeAchieved(key)
	return true, false, nil
}

// probeSwapOnChain checks whether all contracts in the given swap set are
// already at SSInitiated or beyond — i.e., the on-chain initiation has
// happened. Used to make Swap() idempotent.
func (w *assetWallet) probeSwapOnChain(ctx context.Context, contracts []*asset.Contract, contractVer uint32) (achieved, unknown bool, err error) {
	if len(contracts) == 0 {
		return false, false, errors.New("probeSwapOnChain: no contracts")
	}
	key := swapKey(contracts)
	if w.probeAchieved(key) {
		return true, false, nil
	}
	for _, c := range contracts {
		if c == nil {
			return false, false, errors.New("probeSwapOnChain: nil contract")
		}
		var locator []byte
		switch contractVer {
		case 0:
			// v0 contracts key swaps by secret hash directly.
			locator = c.SecretHash
		default:
			v := &dexeth.SwapVector{
				From:     w.addr,
				To:       common.HexToAddress(c.Address),
				Value:    w.evmify(c.Value),
				LockTime: c.LockTime,
			}
			copy(v.SecretHash[:], c.SecretHash)
			locator = v.Locator()
		}
		status, statusErr := w.status(ctx, locator, contractVer)
		if statusErr != nil {
			return false, true, fmt.Errorf("probeSwapOnChain: status query failed: %w", statusErr)
		}
		if status.Step < dexeth.SSInitiated {
			return false, false, nil
		}
	}
	w.markProbeAchieved(key)
	return true, false, nil
}
