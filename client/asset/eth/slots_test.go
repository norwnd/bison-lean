// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package eth

import (
	"math/big"
	"testing"

	"decred.org/dcrdex/client/asset"
	"github.com/ethereum/go-ethereum/core/types"
)

// makeTx creates a minimal extendedWalletTx for slot tests.
func makeTx(id string, nonce uint64, submittedAt uint64) *extendedWalletTx {
	return &extendedWalletTx{
		WalletTransaction: &asset.WalletTransaction{ID: id},
		Nonce:             new(big.Int).SetUint64(nonce),
		SubmissionTime:    submittedAt,
	}
}

func TestBuildSlotsGroupsAndSorts(t *testing.T) {
	// Out-of-order, multiple candidates per nonce, ties on SubmissionTime.
	in := []*extendedWalletTx{
		makeTx("0x05", 5, 100),
		makeTx("0x07", 7, 110),
		makeTx("0x05b", 5, 200), // bump at nonce 5
		makeTx("0x06", 6, 105),
		makeTx("0x05c", 5, 200), // tie on submission time with 0x05b
	}

	slots := buildSlots(in)

	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	// Sorted by nonce asc.
	if slots[0].Nonce.Uint64() != 5 || slots[1].Nonce.Uint64() != 6 || slots[2].Nonce.Uint64() != 7 {
		t.Fatalf("slot order: %v %v %v", slots[0].Nonce, slots[1].Nonce, slots[2].Nonce)
	}
	// Slot at nonce 5 has 3 candidates ordered by submission time (then ID for ties).
	cs := slots[0].Candidates
	if len(cs) != 3 {
		t.Fatalf("expected 3 candidates at nonce 5, got %d", len(cs))
	}
	if cs[0].ID != "0x05" {
		t.Fatalf("original at nonce 5 should be 0x05, got %s", cs[0].ID)
	}
	// Tie on SubmissionTime: order by ID ascending → 0x05b before 0x05c.
	if cs[1].ID != "0x05b" || cs[2].ID != "0x05c" {
		t.Fatalf("tie-break wrong: %s, %s", cs[1].ID, cs[2].ID)
	}

	if slots[0].original().ID != "0x05" {
		t.Fatalf("original wrong: %s", slots[0].original().ID)
	}
	if slots[0].latest().ID != "0x05c" {
		t.Fatalf("latest wrong: %s", slots[0].latest().ID)
	}
}

func TestBuildSlotsEmpty(t *testing.T) {
	if got := buildSlots(nil); got != nil {
		t.Fatalf("expected nil slots from nil input, got %v", got)
	}
	if got := buildSlots([]*extendedWalletTx{}); got != nil {
		t.Fatalf("expected nil slots from empty input, got %v", got)
	}
}

func TestSlotWinnerAndFinalized(t *testing.T) {
	a := makeTx("a", 5, 100)
	b := makeTx("b", 5, 200)
	c := makeTx("c", 5, 300)
	s := newNonceSlot(a)
	s.addCandidate(b)
	s.addCandidate(c)

	if w := s.winner(); w != nil {
		t.Fatalf("no candidate has receipt yet, expected nil winner, got %s", w.ID)
	}
	if s.consumed() {
		t.Fatal("expected !consumed before any receipt")
	}
	if s.finalized() {
		t.Fatal("expected !finalized before any receipt")
	}

	// Give middle candidate a receipt — should still win because we walk in
	// broadcast order and pick the first with a receipt; only b has one.
	b.Receipt = &types.Receipt{Status: types.ReceiptStatusSuccessful}
	if w := s.winner(); w == nil || w.ID != "b" {
		t.Fatalf("winner: %v", w)
	}
	if !s.consumed() {
		t.Fatal("expected consumed after a receipt")
	}
	if s.finalized() {
		t.Fatal("expected !finalized while winner not Confirmed")
	}

	b.Confirmed = true
	if !s.finalized() {
		t.Fatal("expected finalized when winner.Confirmed")
	}

	// If a (earlier in broadcast order) also gets a receipt, it should now be
	// the winner — the chain enforces only one tx per nonce so this is a
	// degenerate case, but the ordering rule must hold.
	a.Receipt = &types.Receipt{Status: types.ReceiptStatusSuccessful}
	if w := s.winner(); w == nil || w.ID != "a" {
		t.Fatalf("winner with both a,b receipted: expected a, got %v", w)
	}
}

func TestSlotFindAndRemove(t *testing.T) {
	a := makeTx("a", 5, 100)
	b := makeTx("b", 5, 200)
	s := newNonceSlot(a)
	s.addCandidate(b)

	if got := s.findByID("a"); got != a {
		t.Fatalf("findByID a: got %v", got)
	}
	if got := s.findByID("missing"); got != nil {
		t.Fatalf("findByID missing should be nil, got %v", got)
	}

	if !s.removeCandidate("a") {
		t.Fatal("removeCandidate(a) returned false")
	}
	if len(s.Candidates) != 1 || s.Candidates[0].ID != "b" {
		t.Fatalf("after remove a, candidates: %v", s.Candidates)
	}
	if s.removeCandidate("missing") {
		t.Fatal("removeCandidate(missing) returned true")
	}
}

func TestSlotByNonceAndFindCandidateByID(t *testing.T) {
	slots := buildSlots([]*extendedWalletTx{
		makeTx("0x03", 3, 100),
		makeTx("0x05", 5, 100),
		makeTx("0x07", 7, 100),
	})

	if i := slotByNonce(slots, big.NewInt(5)); i != 1 {
		t.Fatalf("slotByNonce 5: got %d want 1", i)
	}
	if i := slotByNonce(slots, big.NewInt(4)); i != -1 {
		t.Fatalf("slotByNonce 4 (gap): got %d want -1", i)
	}
	if i := slotByNonce(slots, big.NewInt(2)); i != -1 {
		t.Fatalf("slotByNonce 2 (below min): got %d", i)
	}
	if i := slotByNonce(slots, big.NewInt(8)); i != -1 {
		t.Fatalf("slotByNonce 8 (above max): got %d", i)
	}

	idx, slot, c := findCandidateByID(slots, "0x05")
	if idx != 1 || slot == nil || c == nil || c.ID != "0x05" {
		t.Fatalf("findCandidateByID: idx=%d slot=%v c=%v", idx, slot, c)
	}
	idx, slot, c = findCandidateByID(slots, "missing")
	if idx != -1 || slot != nil || c != nil {
		t.Fatalf("findCandidateByID missing: idx=%d slot=%v c=%v", idx, slot, c)
	}
}

func TestSlotAnyIndexed(t *testing.T) {
	a := makeTx("a", 5, 100)
	b := makeTx("b", 5, 200)
	s := newNonceSlot(a)
	s.addCandidate(b)
	if s.anyIndexed() {
		t.Fatal("no candidate indexed yet")
	}
	b.indexed = true
	if !s.anyIndexed() {
		t.Fatal("expected anyIndexed after b indexed")
	}
}
