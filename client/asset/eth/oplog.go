// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package eth

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"sort"
	"strings"
	"time"

	"decred.org/dcrdex/client/asset"
	"github.com/ethereum/go-ethereum/common"
)

// OpKey uniquely identifies a logical wallet operation by its inputs (e.g., the
// counter-party swap coin IDs being redeemed, or the secret hashes of swaps
// being initiated). Two calls with the same OpKey represent the same logical
// intent and the wallet must service them idempotently — at most one active
// nonce slot per OpKey.
type OpKey string

// OpType is the kind of on-chain action an Operation represents.
type OpType string

const (
	OpSwap           OpType = "swap"
	OpRedeem         OpType = "redeem"
	OpRefund         OpType = "refund"
	OpBridgeComplete OpType = "bridge-complete"
)

// OpState is the lifecycle state of an Operation.
type OpState string

const (
	OpStatePending   OpState = "pending"
	OpStateConfirmed OpState = "confirmed"
	OpStateLost      OpState = "lost"
)

// AttemptOutcome is the terminal status of an Attempt within an Operation.
type AttemptOutcome string

const (
	// AttemptPending indicates no candidate of this attempt has been finalized
	// on-chain yet.
	AttemptPending AttemptOutcome = "pending"
	// AttemptMinedEffective indicates a candidate of this attempt mined and the
	// on-chain probe confirms the operation's effect was achieved.
	AttemptMinedEffective AttemptOutcome = "mined-effective"
	// AttemptMinedIneffective indicates a candidate mined (success or revert)
	// but the operation's effect was not achieved by it. The Operation may
	// still be Confirmed if the effect was already on-chain via another path
	// (e.g., emergency gasless redeem).
	AttemptMinedIneffective AttemptOutcome = "mined-ineffective"
	// AttemptAbandoned indicates the abandon-replacement candidate (a 0-value
	// self-send at the same nonce) mined, replacing the original tx in the
	// network.
	AttemptAbandoned AttemptOutcome = "abandoned"
	// AttemptLost indicates an external transaction (not broadcast by this
	// wallet) mined at this attempt's nonce, so none of our candidates will
	// ever mine. Set by the lost-nonce auto-resolver. The Operation's State is
	// independent: it may still transition to Confirmed if the on-chain probe
	// finds the effect was achieved (e.g., Y was an emergency redeem of the
	// same swap).
	AttemptLost AttemptOutcome = "lost"
)

// CandidatePurpose distinguishes how a candidate tx came to be broadcast at a
// given Attempt's nonce. Persisted on extendedWalletTx in Phase 2.
type CandidatePurpose string

const (
	CandidateOriginal           CandidatePurpose = "original"
	CandidateFeeBump            CandidatePurpose = "feebump"
	CandidateAbandonReplacement CandidatePurpose = "abandon"
)

// Operation is a logical wallet action tracked across one or more on-chain
// Attempts. State transitions are driven by an on-chain probe (contract state
// check), not by individual tx receipts: an Operation reaches Confirmed when
// the on-chain effect is observed, regardless of which Candidate mined.
type Operation struct {
	Key         OpKey      `json:"key"`
	Type        OpType     `json:"type"`
	State       OpState    `json:"state"`
	Attempts    []*Attempt `json:"attempts,omitempty"`
	CreatedAt   int64      `json:"createdAt"`             // unix seconds
	ConfirmedAt int64      `json:"confirmedAt,omitempty"` // unix seconds, 0 if not yet
	LostAt      int64      `json:"lostAt,omitempty"`      // unix seconds, 0 if not yet

	// RedeemedValue is the total value (in atoms) the operation moves on the
	// happy path. Cached on first validation so idempotent calls can return
	// it without re-querying. Used by Redeem; left zero for Refund/Swap.
	RedeemedValue uint64 `json:"redeemedValue,omitempty"`
	// ContractVer is the swap contract version this op runs against. Cached
	// alongside RedeemedValue.
	ContractVer uint32 `json:"contractVer,omitempty"`
	// Locators is the per-swap locator(s) needed to re-run the on-chain probe
	// without the original input structs. For OpRedeem and OpSwap this is one
	// locator per swap (decoded from the redemption / contract input). For
	// OpRefund this is a single locator. Set at Op creation; the lost-nonce
	// auto-resolver uses this together with ContractVer to call the probe.
	Locators [][]byte `json:"locators,omitempty"`
}

// Attempt is one nonce's worth of broadcast attempts. A new Attempt is opened
// only when a previous Attempt was Lost (e.g., abandon-replacement mined and
// the probe says the effect was not achieved). Candidates are tx hashes of
// records stored in the txs table; an Attempt may carry multiple in-flight
// Candidates at the same nonce (original + fee-bumps + optional
// abandon-replacement) competing to mine.
type Attempt struct {
	Nonce       *big.Int       `json:"nonce"`
	Outcome     AttemptOutcome `json:"outcome"`
	Candidates  []common.Hash  `json:"candidates"` // tx hashes, broadcast order
	CreatedAt   int64          `json:"createdAt"`
	FinalizedAt int64          `json:"finalizedAt,omitempty"`
}

// MarshalBinary serializes Operation as JSON for storage.
func (op *Operation) MarshalBinary() ([]byte, error) {
	return json.Marshal(op)
}

// UnmarshalBinary deserializes Operation from JSON.
func (op *Operation) UnmarshalBinary(b []byte) error {
	return json.Unmarshal(b, op)
}

// activeAttempt returns the most recent un-finalized Attempt, or nil if no
// Attempt is currently active (every prior Attempt is finalized, or none yet).
func (op *Operation) activeAttempt() *Attempt {
	if len(op.Attempts) == 0 {
		return nil
	}
	last := op.Attempts[len(op.Attempts)-1]
	if last.Outcome == AttemptPending {
		return last
	}
	return nil
}

// canonicalCoinID returns the tx hash core should track for this Operation.
// Per Option B, this is the most-recent Candidate of the active Attempt, so
// fee-bumps and abandon-replacements eventually surface to core via
// handleResubmit on the next ConfirmTransaction poll. Returns the zero hash
// if there is no active attempt or it has no candidates.
func (op *Operation) canonicalCoinID() common.Hash {
	a := op.activeAttempt()
	if a == nil || len(a.Candidates) == 0 {
		return common.Hash{}
	}
	return a.Candidates[len(a.Candidates)-1]
}

// redeemKey computes the OpKey for a Redeem operation: the sorted set of the
// counter-party swap coin IDs being redeemed. Two Redeem calls that target the
// same set of swaps share the same OpKey.
func redeemKey(redemptions []*asset.Redemption) OpKey {
	ids := make([]string, len(redemptions))
	for i, r := range redemptions {
		if r != nil && r.Spends != nil && r.Spends.Coin != nil {
			ids[i] = hex.EncodeToString(r.Spends.Coin.ID())
		} else {
			ids[i] = "<nil>"
		}
	}
	sort.Strings(ids)
	return OpKey("redeem:" + strings.Join(ids, ","))
}

// swapKey computes the OpKey for a Swap (initiate) operation: the sorted set
// of secret hashes. Since secret hashes derive from random secrets, fresh Swap
// calls don't collide with prior ones.
func swapKey(contracts []*asset.Contract) OpKey {
	ids := make([]string, len(contracts))
	for i, c := range contracts {
		if c != nil {
			ids[i] = hex.EncodeToString(c.SecretHash)
		} else {
			ids[i] = "<nil>"
		}
	}
	sort.Strings(ids)
	return OpKey("swap:" + strings.Join(ids, ","))
}

// refundKey computes the OpKey for a Refund operation, identified by the
// contract locator being refunded.
func refundKey(locator []byte) OpKey {
	return OpKey("refund:" + hex.EncodeToString(locator))
}

// bridgeCompleteKey computes the OpKey for a CompleteBridge operation,
// identified by the initiation tx ID. The completion logically belongs
// to the source-chain initiation tx — a given initiation has at most
// one completion per follow-up step, and concurrent CompleteBridge
// calls for the same initiation must not double-broadcast.
//
// Note: InitiateBridge does NOT get an OpKey today. Bridges are
// user-initiated single-shot actions with no natural retry key (a user
// who clicks Bridge twice with the same parameters typically intends
// two separate bridges, not idempotent dedup), so the op-layer adds
// no value there. Only the completion path — which Core can replay
// across restarts when a stored BridgeReadyToComplete fires twice —
// benefits from the serialization the op-layer provides.
func bridgeCompleteKey(initiationTxID string) OpKey {
	return OpKey("bridge-complete:" + initiationTxID)
}

// opLog is the in-memory operation registry plus a tx-hash → OpKey reverse
// index for fast ConfirmTransaction lookups. Concurrent access is guarded by
// the wallet's opMtx; opLog itself does not lock.
type opLog struct {
	ops     map[OpKey]*Operation
	txToKey map[common.Hash]OpKey
}

func newOpLog() *opLog {
	return &opLog{
		ops:     make(map[OpKey]*Operation),
		txToKey: make(map[common.Hash]OpKey),
	}
}

// findOrCreate returns the Operation for the given key, creating a fresh
// Pending one if none exists. Caller must hold opMtx.
func (l *opLog) findOrCreate(key OpKey, opType OpType) *Operation {
	if op, ok := l.ops[key]; ok {
		return op
	}
	op := &Operation{
		Key:       key,
		Type:      opType,
		State:     OpStatePending,
		CreatedAt: time.Now().Unix(),
	}
	l.ops[key] = op
	return op
}

// get returns the Operation for the given key, or nil. Caller must hold opMtx.
func (l *opLog) get(key OpKey) *Operation {
	return l.ops[key]
}

// findByTx returns the Operation that owns the given tx hash, or nil.
// Caller must hold opMtx.
func (l *opLog) findByTx(h common.Hash) *Operation {
	key, ok := l.txToKey[h]
	if !ok {
		return nil
	}
	return l.ops[key]
}

// indexCandidate registers a tx-hash → OpKey mapping in the reverse index.
// Caller must hold opMtx.
func (l *opLog) indexCandidate(h common.Hash, key OpKey) {
	l.txToKey[h] = key
}

// reindex rebuilds the reverse tx-hash index from the current ops map. Used
// after loading ops from persistent storage at startup. Caller must hold
// opMtx.
func (l *opLog) reindex() {
	l.txToKey = make(map[common.Hash]OpKey, len(l.txToKey))
	for key, op := range l.ops {
		for _, a := range op.Attempts {
			for _, h := range a.Candidates {
				l.txToKey[h] = key
			}
		}
	}
}

// loadOpLog initializes the wallet's in-memory opLog by reading every
// persisted Operation from the txDB and rebuilding the tx-hash → OpKey reverse
// index. Called once at Connect time, after the txDB is up.
func (w *baseWallet) loadOpLog() error {
	ops, err := w.txDB.getAllOps()
	if err != nil {
		return err
	}
	l := newOpLog()
	for _, op := range ops {
		l.ops[op.Key] = op
	}
	l.reindex()

	w.opMtx.Lock()
	w.opLog = l
	w.opMtx.Unlock()
	return nil
}
