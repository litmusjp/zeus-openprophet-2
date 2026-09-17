package services

import (
	"context"
	"prophet-trader/interfaces"
	"testing"
)

func TestCloseManagedPositionKeepsAcceptedOrderUnresolved(t *testing.T) {
	rec := &exitOrderRecorder{result: &interfaces.OrderResult{OrderID: "accepted-exit", Status: "accepted"}}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()

	pos := &ManagedPosition{ID: "c2", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", Quantity: 10, RemainingQty: 10}
	pm.positions[pos.ID] = pos
	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err == nil {
		t.Fatal("expected an accepted but unfilled exit to remain unresolved")
	}
	if pos.Status != "CLOSING" {
		t.Fatalf("position status = %q, want CLOSING", pos.Status)
	}
}
