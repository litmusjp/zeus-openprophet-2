package services

import (
	"context"
	"prophet-trader/interfaces"
	"testing"
)

func TestCloseManagedPositionKeepsAcceptedOrderUnresolved(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	rec := &exitOrderRecorder{result: &interfaces.OrderResult{OrderID: "accepted-exit", Status: "accepted"}}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()

	pos := &ManagedPosition{ID: "c2", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", Quantity: 10, RemainingQty: 10}
	pm.positions[pos.ID] = pos
	pos.DurableIdentity = storage.DurableIdentity()
	capability, err := NewPositionCloseCapability("operator-secret", storage.DurableIdentity())
	if err != nil { t.Fatal(err) }
	if err := pm.CloseManagedPositionWithCapability(context.Background(), pos.ID, capability); err == nil {
		t.Fatal("expected an accepted but unfilled exit to remain unresolved")
	}
	if pos.Status != "CLOSING" {
		t.Fatalf("position status = %q, want CLOSING", pos.Status)
	}
}
