package services

import (
	"context"
	"prophet-trader/models"
	"testing"
)

func TestManagedPositionCloseRequiresBoundCapabilityBeforeProviderMutation(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	rec := &exitOrderRecorder{}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	identity := models.DurableIdentity{BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"}
	pos := &ManagedPosition{ID: "bound-close", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", RemainingQty: 1, DurableIdentity: identity}
	pm.positions[pos.ID] = pos

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err == nil {
		t.Fatal("direct close without capability was accepted")
	}
	if rec.placed != nil {
		t.Fatal("provider mutation occurred without capability")
	}

	wrong, err := NewPositionCloseCapability("operator-secret", models.DurableIdentity{BrokerAccountID: "other", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pm.CloseManagedPositionWithCapability(context.Background(), pos.ID, wrong); err == nil {
		t.Fatal("close with mismatched identity was accepted")
	}
	if rec.placed != nil {
		t.Fatal("provider mutation occurred for mismatched identity")
	}
}
