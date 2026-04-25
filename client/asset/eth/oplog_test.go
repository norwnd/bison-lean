// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package eth

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"testing"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/dex"
	"github.com/ethereum/go-ethereum/common"
)

func newTestTxDB(t *testing.T) *TxDB {
	t.Helper()
	tempDir := t.TempDir()
	db, err := NewTxDB(tempDir, dex.StdOutLogger("TXDB", dex.LevelError), BipID)
	if err != nil {
		t.Fatalf("NewTxDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// fakeCoin is a minimal asset.Coin with a fixed ID, used to build redemptions
// and contracts for op-key tests without dragging in the eth-specific coin
// implementations.
type fakeCoin struct {
	id dex.Bytes
}

func (c *fakeCoin) ID() dex.Bytes  { return c.id }
func (c *fakeCoin) String() string { return hex.EncodeToString(c.id) }
func (c *fakeCoin) Value() uint64  { return 0 }
func (c *fakeCoin) TxID() string   { return c.String() }

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func TestOpKeysAreDeterministicAndOrderInvariant(t *testing.T) {
	id1 := mustHex(t, "aa11")
	id2 := mustHex(t, "bb22")
	id3 := mustHex(t, "cc33")

	red := func(ids ...[]byte) []*asset.Redemption {
		out := make([]*asset.Redemption, len(ids))
		for i, id := range ids {
			out[i] = &asset.Redemption{
				Spends: &asset.AuditInfo{Coin: &fakeCoin{id: id}},
			}
		}
		return out
	}

	a := redeemKey(red(id1, id2, id3))
	b := redeemKey(red(id3, id1, id2))
	c := redeemKey(red(id2, id1)) // different set
	if a != b {
		t.Fatalf("redeemKey order-variance: %q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("redeemKey collided across different inputs: %q == %q", a, c)
	}

	swap := func(hashes ...[]byte) []*asset.Contract {
		out := make([]*asset.Contract, len(hashes))
		for i, h := range hashes {
			out[i] = &asset.Contract{SecretHash: h}
		}
		return out
	}

	a = swapKey(swap(id1, id2))
	b = swapKey(swap(id2, id1))
	if a != b {
		t.Fatalf("swapKey order-variance: %q vs %q", a, b)
	}

	if got := refundKey(id1); got != "refund:aa11" {
		t.Fatalf("refundKey wrong: %q", got)
	}
}

func TestOpKeyTypePrefixesPreventCollision(t *testing.T) {
	id := mustHex(t, "aa11")
	r := redeemKey([]*asset.Redemption{{Spends: &asset.AuditInfo{Coin: &fakeCoin{id: id}}}})
	s := swapKey([]*asset.Contract{{SecretHash: id}})
	f := refundKey(id)

	if r == s || r == f || s == f {
		t.Fatalf("op-key types collided: redeem=%q swap=%q refund=%q", r, s, f)
	}
}

func TestOperationMarshalRoundtrip(t *testing.T) {
	in := &Operation{
		Key:         "redeem:aa,bb",
		Type:        OpRedeem,
		State:       OpStatePending,
		CreatedAt:   1700000000,
		ConfirmedAt: 0,
		Attempts: []*Attempt{
			{
				Nonce:      big.NewInt(7),
				Outcome:    AttemptPending,
				Candidates: []common.Hash{common.HexToHash("0xdeadbeef"), common.HexToHash("0xfeedface")},
				CreatedAt:  1700000005,
			},
		},
	}

	b, err := in.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	out := new(Operation)
	if err := out.UnmarshalBinary(b); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if out.Key != in.Key || out.Type != in.Type || out.State != in.State {
		t.Fatalf("scalar mismatch: in=%+v out=%+v", in, out)
	}
	if out.CreatedAt != in.CreatedAt {
		t.Fatalf("CreatedAt mismatch: %d != %d", out.CreatedAt, in.CreatedAt)
	}
	if len(out.Attempts) != 1 {
		t.Fatalf("attempt count mismatch: %d", len(out.Attempts))
	}
	a, b2 := in.Attempts[0], out.Attempts[0]
	if a.Nonce.Cmp(b2.Nonce) != 0 {
		t.Fatalf("nonce mismatch: %s != %s", a.Nonce, b2.Nonce)
	}
	if a.Outcome != b2.Outcome || a.CreatedAt != b2.CreatedAt {
		t.Fatalf("attempt scalar mismatch")
	}
	if len(a.Candidates) != len(b2.Candidates) {
		t.Fatalf("candidate count mismatch")
	}
	for i := range a.Candidates {
		if !bytes.Equal(a.Candidates[i].Bytes(), b2.Candidates[i].Bytes()) {
			t.Fatalf("candidate[%d] mismatch", i)
		}
	}
}

func TestActiveAttemptAndCanonicalCoinID(t *testing.T) {
	op := &Operation{Key: "k", Type: OpRedeem, State: OpStatePending}

	if op.activeAttempt() != nil {
		t.Fatal("expected no active attempt on empty op")
	}
	if got := op.canonicalCoinID(); got != (common.Hash{}) {
		t.Fatalf("expected zero hash on empty op, got %s", got)
	}

	h1 := common.HexToHash("0x01")
	h2 := common.HexToHash("0x02")
	op.Attempts = append(op.Attempts, &Attempt{
		Nonce:      big.NewInt(1),
		Outcome:    AttemptPending,
		Candidates: []common.Hash{h1},
	})

	if op.activeAttempt() == nil {
		t.Fatal("expected active attempt")
	}
	if got := op.canonicalCoinID(); got != h1 {
		t.Fatalf("canonical: got %s want %s", got, h1)
	}

	// After a fee-bump candidate is appended, the latest one becomes canonical.
	op.Attempts[0].Candidates = append(op.Attempts[0].Candidates, h2)
	if got := op.canonicalCoinID(); got != h2 {
		t.Fatalf("canonical after bump: got %s want %s", got, h2)
	}

	// Finalize the attempt — no more active attempt, canonical reverts to zero.
	op.Attempts[0].Outcome = AttemptMinedEffective
	if op.activeAttempt() != nil {
		t.Fatal("finalized attempt should not be active")
	}
	if got := op.canonicalCoinID(); got != (common.Hash{}) {
		t.Fatalf("canonical after finalize: got %s want zero", got)
	}
}

func TestOpLogFindOrCreateAndIndex(t *testing.T) {
	l := newOpLog()

	op1 := l.findOrCreate("k1", OpRedeem)
	op2 := l.findOrCreate("k1", OpRedeem) // same key
	if op1 != op2 {
		t.Fatal("findOrCreate did not return existing op for same key")
	}
	if op1.State != OpStatePending {
		t.Fatalf("new op state: %s", op1.State)
	}

	if got := l.get("k1"); got != op1 {
		t.Fatal("get missed existing op")
	}
	if l.get("k-missing") != nil {
		t.Fatal("get returned non-nil for missing key")
	}

	h := common.HexToHash("0xabc")
	if got := l.findByTx(h); got != nil {
		t.Fatal("findByTx returned non-nil before indexCandidate")
	}
	l.indexCandidate(h, "k1")
	if got := l.findByTx(h); got != op1 {
		t.Fatal("findByTx returned wrong op after indexCandidate")
	}
}

func TestTxDBOperationPersistence(t *testing.T) {
	db := newTestTxDB(t)

	// Empty bucket → empty list, not an error.
	if ops, err := db.getAllOps(); err != nil {
		t.Fatalf("getAllOps on empty: %v", err)
	} else if len(ops) != 0 {
		t.Fatalf("expected 0 ops, got %d", len(ops))
	}

	// Missing key → (nil, nil).
	if op, err := db.getOp("nonesuch"); err != nil {
		t.Fatalf("getOp missing: %v", err)
	} else if op != nil {
		t.Fatalf("expected nil op for missing key, got %+v", op)
	}

	op := &Operation{
		Key:       "redeem:aa,bb",
		Type:      OpRedeem,
		State:     OpStatePending,
		CreatedAt: 1700000000,
		Attempts: []*Attempt{{
			Nonce:      big.NewInt(11),
			Outcome:    AttemptPending,
			Candidates: []common.Hash{common.HexToHash("0x01"), common.HexToHash("0x02")},
			CreatedAt:  1700000005,
		}},
	}
	if err := db.storeOp(op); err != nil {
		t.Fatalf("storeOp: %v", err)
	}

	// getOp round-trip.
	got, err := db.getOp(op.Key)
	if err != nil {
		t.Fatalf("getOp: %v", err)
	}
	if got == nil {
		t.Fatal("expected op, got nil")
	}
	if got.Key != op.Key || got.Type != op.Type || got.State != op.State {
		t.Fatalf("scalar mismatch: %+v vs %+v", got, op)
	}
	if len(got.Attempts) != 1 || got.Attempts[0].Nonce.Cmp(op.Attempts[0].Nonce) != 0 {
		t.Fatalf("attempt round-trip failed: %+v", got.Attempts)
	}

	// Replace existing op (state transition).
	op.State = OpStateConfirmed
	op.ConfirmedAt = 1700001000
	if err := db.storeOp(op); err != nil {
		t.Fatalf("storeOp replace: %v", err)
	}
	got, err = db.getOp(op.Key)
	if err != nil {
		t.Fatalf("getOp after replace: %v", err)
	}
	if got.State != OpStateConfirmed || got.ConfirmedAt != 1700001000 {
		t.Fatalf("replace did not persist: %+v", got)
	}

	// Add a second op; getAllOps returns both.
	op2 := &Operation{
		Key:       "swap:cc",
		Type:      OpSwap,
		State:     OpStatePending,
		CreatedAt: 1700000100,
	}
	if err := db.storeOp(op2); err != nil {
		t.Fatalf("storeOp op2: %v", err)
	}
	all, err := db.getAllOps()
	if err != nil {
		t.Fatalf("getAllOps: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 ops, got %d", len(all))
	}
	keys := map[OpKey]bool{}
	for _, o := range all {
		keys[o.Key] = true
	}
	if !keys[op.Key] || !keys[op2.Key] {
		t.Fatalf("getAllOps missing one of the keys: %v", keys)
	}
}

func TestOpLogReindexFromPersistedState(t *testing.T) {
	// Simulate ops loaded from disk into l.ops with no reverse index built yet.
	l := newOpLog()
	h1 := common.HexToHash("0x01")
	h2 := common.HexToHash("0x02")
	h3 := common.HexToHash("0x03")
	l.ops["redeem:k1"] = &Operation{
		Key: "redeem:k1", Type: OpRedeem, State: OpStatePending,
		Attempts: []*Attempt{{
			Nonce: big.NewInt(1), Outcome: AttemptPending,
			Candidates: []common.Hash{h1, h2},
		}},
	}
	l.ops["swap:k2"] = &Operation{
		Key: "swap:k2", Type: OpSwap, State: OpStatePending,
		Attempts: []*Attempt{{
			Nonce: big.NewInt(2), Outcome: AttemptPending,
			Candidates: []common.Hash{h3},
		}},
	}

	// Reverse index empty before reindex.
	if got := l.findByTx(h1); got != nil {
		t.Fatal("expected empty reverse index before reindex")
	}

	l.reindex()

	if op := l.findByTx(h1); op == nil || op.Key != "redeem:k1" {
		t.Fatalf("h1 should map to redeem:k1, got %+v", op)
	}
	if op := l.findByTx(h2); op == nil || op.Key != "redeem:k1" {
		t.Fatalf("h2 should map to redeem:k1, got %+v", op)
	}
	if op := l.findByTx(h3); op == nil || op.Key != "swap:k2" {
		t.Fatalf("h3 should map to swap:k2, got %+v", op)
	}
	// Hash that was never indexed.
	if l.findByTx(common.HexToHash("0xff")) != nil {
		t.Fatal("unknown hash should map to nil")
	}
}
