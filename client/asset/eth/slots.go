// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package eth

import (
	"math/big"
	"sort"
	"time"
)

// nonceSlot represents one nonce value the wallet has broadcast at, with all
// candidate transactions that compete to mine at that nonce. A slot may hold
// the original tx, fee bumps, and (Phase 3+) abandon-replacement txs together.
//
// The slot's nonce is consumed on-chain as soon as any candidate's tx is
// mined into a block. The slot is finalized when that mined candidate reaches
// the wallet's finalizeConfs threshold.
type nonceSlot struct {
	// Nonce is the slot's nonce value. Read-only after creation.
	Nonce *big.Int
	// Candidates are the txs broadcast at Nonce, in broadcast order. The first
	// is the original; subsequent entries are fee bumps or abandon-replacements.
	// Always non-empty; an empty slot is removed from the wallet's slots list.
	Candidates []*extendedWalletTx

	// lastAutoBumpAt is when the auto-bump scheduler last appended a fee-bump
	// candidate to this slot. Zero value means never. Used to throttle to one
	// auto-bump per autoBumpInterval. Not persisted — resets on restart.
	lastAutoBumpAt time.Time
	// autoBumpCapNoticed is set after the wallet emits the "auto-bump fee cap
	// reached" warning for this slot, to avoid re-emitting it every tick once
	// the cap is hit. Not persisted.
	autoBumpCapNoticed bool
}

// newNonceSlot creates a slot with one initial candidate.
func newNonceSlot(c *extendedWalletTx) *nonceSlot {
	return &nonceSlot{
		Nonce:      new(big.Int).Set(c.Nonce),
		Candidates: []*extendedWalletTx{c},
	}
}

// addCandidate appends a candidate to the slot. The caller must ensure the
// candidate's nonce matches the slot's nonce.
func (s *nonceSlot) addCandidate(c *extendedWalletTx) {
	s.Candidates = append(s.Candidates, c)
}

// original is the first candidate broadcast in this slot — the one core's
// match metadata first stored as the redeem/swap/refund coin ID.
func (s *nonceSlot) original() *extendedWalletTx {
	return s.Candidates[0]
}

// latest is the most recently added candidate — typically the one with the
// highest fees and the canonical coin ID surfaced to core via handleResubmit.
func (s *nonceSlot) latest() *extendedWalletTx {
	return s.Candidates[len(s.Candidates)-1]
}

// winner returns the first candidate (in broadcast order) whose receipt has
// arrived, or nil if no candidate has been mined yet. Once winner is non-nil
// the slot's nonce is consumed on-chain.
func (s *nonceSlot) winner() *extendedWalletTx {
	for _, c := range s.Candidates {
		if c.Receipt != nil {
			return c
		}
	}
	return nil
}

// consumed is true when any candidate has a receipt — i.e., the chain has
// accepted a tx at this nonce, so the nonce can never be reused.
func (s *nonceSlot) consumed() bool {
	return s.winner() != nil
}

// finalized is true when the slot's winning candidate has reached finalizeConfs
// confirmations. The slot can be dropped from in-memory tracking when finalized
// AND the winner's record is persisted.
func (s *nonceSlot) finalized() bool {
	w := s.winner()
	return w != nil && w.Confirmed
}

// findByID returns the candidate at this slot with the given tx ID, or nil.
func (s *nonceSlot) findByID(txID string) *extendedWalletTx {
	for _, c := range s.Candidates {
		if c.ID == txID {
			return c
		}
	}
	return nil
}

// removeCandidate removes the candidate with the given tx ID from the slot.
// Returns true if removed. The slot may end up empty; callers should drop
// empty slots from the wallet's slots list.
func (s *nonceSlot) removeCandidate(txID string) bool {
	for i, c := range s.Candidates {
		if c.ID == txID {
			s.Candidates = append(s.Candidates[:i], s.Candidates[i+1:]...)
			return true
		}
	}
	return false
}

// anyIndexed reports whether any of this slot's candidates has been observed
// by the network (transactionAndReceipt returned a tx). Used to decide whether
// the slot is "live" or fully lost in the mempool.
func (s *nonceSlot) anyIndexed() bool {
	for _, c := range s.Candidates {
		if c.indexed {
			return true
		}
	}
	return false
}

// anyActionRequested reports whether any candidate in the slot currently has
// an action-required prompt outstanding. Used to avoid stacking dialogs.
func (s *nonceSlot) anyActionRequested() bool {
	for _, c := range s.Candidates {
		if c.actionRequested {
			return true
		}
	}
	return false
}

// buildSlots groups a flat list of pending txs by nonce, returning slots
// sorted by nonce ascending. Within each slot, candidates are ordered by
// SubmissionTime (broadcast order). Used at wallet startup to convert the
// flat list returned by txDB.getPendingTxs into the slot model.
func buildSlots(txs []*extendedWalletTx) []*nonceSlot {
	if len(txs) == 0 {
		return nil
	}
	byNonce := make(map[uint64]*nonceSlot, len(txs))
	for _, tx := range txs {
		key := tx.Nonce.Uint64()
		s, ok := byNonce[key]
		if !ok {
			s = newNonceSlot(tx)
			byNonce[key] = s
			continue
		}
		s.addCandidate(tx)
	}
	slots := make([]*nonceSlot, 0, len(byNonce))
	for _, s := range byNonce {
		// Within a slot, sort candidates by SubmissionTime ascending so
		// original() / latest() reflect broadcast order. Fall back to ID for
		// determinism if SubmissionTime ties.
		sort.SliceStable(s.Candidates, func(i, j int) bool {
			a, b := s.Candidates[i], s.Candidates[j]
			if a.SubmissionTime != b.SubmissionTime {
				return a.SubmissionTime < b.SubmissionTime
			}
			return a.ID < b.ID
		})
		slots = append(slots, s)
	}
	sort.Slice(slots, func(i, j int) bool {
		return slots[i].Nonce.Cmp(slots[j].Nonce) < 0
	})
	return slots
}

// findHeadSlot returns the index of the lowest-nonce non-finalized,
// non-consumed, non-AssumedLost slot — the "head" slot. Head is the next
// nonce that needs to land on-chain; only it gets user-action prompts and
// auto-bumps. Slots before head are either mined (consumed/finalized) or
// the wallet has given up on them (AssumedLost); slots after head are
// queued in mempool waiting for head. Returns -1 if every slot is in one
// of those terminal states.
func findHeadSlot(slots []*nonceSlot) int {
	for i, s := range slots {
		if s.finalized() || s.consumed() {
			continue
		}
		if s.original().AssumedLost {
			continue
		}
		return i
	}
	return -1
}

// slotByNonce returns the index of the slot with the given nonce, or -1 if
// none exists. Slots are sorted by nonce ascending so this is a binary search.
func slotByNonce(slots []*nonceSlot, nonce *big.Int) int {
	i := sort.Search(len(slots), func(i int) bool {
		return slots[i].Nonce.Cmp(nonce) >= 0
	})
	if i < len(slots) && slots[i].Nonce.Cmp(nonce) == 0 {
		return i
	}
	return -1
}

// insertSlotSorted inserts a new slot into a slots list while preserving
// nonce-ascending order. Caller must ensure no slot with the same nonce
// already exists (use addCandidate on the existing slot instead).
func insertSlotSorted(slots []*nonceSlot, s *nonceSlot) []*nonceSlot {
	i := sort.Search(len(slots), func(i int) bool {
		return slots[i].Nonce.Cmp(s.Nonce) > 0
	})
	slots = append(slots, nil)
	copy(slots[i+1:], slots[i:])
	slots[i] = s
	return slots
}

// findCandidateByID searches all slots for a candidate with the given tx ID.
// Returns (slot index, slot, candidate) or (-1, nil, nil) if not found.
func findCandidateByID(slots []*nonceSlot, txID string) (int, *nonceSlot, *extendedWalletTx) {
	for i, s := range slots {
		if c := s.findByID(txID); c != nil {
			return i, s, c
		}
	}
	return -1, nil, nil
}

// eachCandidate visits every candidate in every slot in slot/broadcast order.
// Returning early from f is not supported — use a closure variable to short
// out if needed.
func eachCandidate(slots []*nonceSlot, f func(*extendedWalletTx)) {
	for _, s := range slots {
		for _, c := range s.Candidates {
			f(c)
		}
	}
}
