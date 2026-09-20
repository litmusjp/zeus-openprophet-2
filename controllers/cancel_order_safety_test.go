package controllers

import (
	"context"
	"errors"
	"path/filepath"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
	"testing"
)

type cancelTestStorage struct {
	interfaces.StorageService
	identity models.DurableIdentity
	order    *interfaces.Order
}

func (s *cancelTestStorage) DurableIdentity() models.DurableIdentity { return s.identity }

func (s *cancelTestStorage) GetOrder(orderID string) (*interfaces.Order, error) {
	if s.order != nil && s.order.ID == orderID {
		return s.order, nil
	}
	return nil, nil
}

func (s *cancelTestStorage) GetOrderByClientOrderID(clientOrderID string) (*interfaces.Order, error) {
	if s.order != nil && s.order.ClientOrderID == clientOrderID {
		return s.order, nil
	}
	return nil, nil
}

func (s *cancelTestStorage) SaveOrder(order *interfaces.Order) error {
	s.order = order
	return nil
}

type cancelTestTrading struct {
	interfaces.TradingService
	calls int
}

type fillReadbackTrading struct{ interfaces.TradingService }

func (s *fillReadbackTrading) CancelOrder(context.Context, string) error {
	return &services.SubmissionUncertainError{
		Err: errors.New("terminal broker fill observed during cancellation"),
		Result: &interfaces.OrderResult{OrderID: "broker-order-1", ClientOrderID: "op-order-1", Status: "canceled", FilledQty: 1,
			BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"},
	}
}

func (s *cancelTestTrading) CancelOrder(context.Context, string) error {
	s.calls++
	return nil
}

func cancelTestController(order *interfaces.Order, trading *cancelTestTrading) *OrderController {
	identity := models.DurableIdentity{
		BrokerAccountID: "test-broker-account",
		PaperLive:       "paper",
		TenantID:        "test-tenant",
		SandboxID:       "test-sandbox",
	}
	return NewOrderController(trading, nil, &cancelTestStorage{identity: identity, order: order})
}

func cancelTestOrder() *interfaces.Order {
	return &interfaces.Order{
		BrokerAccountID: "test-broker-account",
		PaperLive:       "paper",
		TenantID:        "test-tenant",
		SandboxID:       "test-sandbox",
		ID:              "broker-order-1",
		ClientOrderID:   "op-order-1",
		Status:          "accepted",
	}
}

func TestCancelOrderDirectRequiresOperatorCapability(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	trading := &cancelTestTrading{}
	oc := cancelTestController(cancelTestOrder(), trading)

	if err := oc.CancelOrder("broker-order-1"); err == nil {
		t.Fatal("CancelOrder() accepted a cancellation without operator capability")
	}
	if trading.calls != 0 {
		t.Fatalf("provider calls = %d, want 0", trading.calls)
	}
}

func TestCancelOrderWithCapabilityRejectsWrongCapability(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	trading := &cancelTestTrading{}
	oc := cancelTestController(cancelTestOrder(), trading)

	if err := oc.CancelOrderWithCapability("broker-order-1", "wrong-secret"); err == nil {
		t.Fatal("CancelOrderWithCapability() accepted the wrong capability")
	}
	if trading.calls != 0 {
		t.Fatalf("provider calls = %d, want 0", trading.calls)
	}
}

func TestCancelOrderWithCapabilityRejectsMismatchedResourceIdentity(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := cancelTestOrder()
	order.SandboxID = "another-sandbox"
	trading := &cancelTestTrading{}
	oc := cancelTestController(order, trading)

	if err := oc.CancelOrderWithCapability("broker-order-1", "operator-secret"); err == nil {
		t.Fatal("CancelOrderWithCapability() accepted a mismatched sandbox identity")
	}
	if trading.calls != 0 {
		t.Fatalf("provider calls = %d, want 0", trading.calls)
	}
}

func TestCancelOrderWithCapabilityAcceptsValidCapabilityAndBinding(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	trading := &cancelTestTrading{}
	oc := cancelTestController(cancelTestOrder(), trading)

	if err := oc.CancelOrderWithCapability("broker-order-1", "operator-secret"); err != nil {
		t.Fatalf("CancelOrderWithCapability() error = %v", err)
	}
	if trading.calls != 1 {
		t.Fatalf("provider calls = %d, want 1", trading.calls)
	}
}

func TestCancelOrderPersistsTerminalFillBeforeReturningUncertainty(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	path := filepath.Join(t.TempDir(), "orders.db")
	storage, err := database.NewLocalStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	order := cancelTestOrder()
	order.Symbol, order.Qty, order.Side, order.Type, order.TimeInForce = "AAPL", 2, "buy", "market", "day"
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	oc := NewOrderController(&fillReadbackTrading{TradingService: &reconciliationTradingService{}}, nil, storage)
	if err := oc.CancelOrderWithCapability(order.ID, "operator-secret"); err == nil || !services.IsSubmissionUncertain(err) {
		t.Fatalf("cancel error = %v, want uncertainty", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := database.NewLocalStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	saved, err := reopened.GetOrder(order.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.FilledQty != 1 || saved.Status != "canceled" {
		t.Fatalf("reopened order = %#v, want durable terminal fill", saved)
	}
}

func TestCancelOrderRejectsUntrustedCancellationFillEvidence(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	identity := models.DurableIdentity{BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"}
	for name, result := range map[string]*interfaces.OrderResult{
		"missing identity":    {OrderID: "broker-order-1", ClientOrderID: "op-order-1", Status: "canceled", FilledQty: 1},
		"mismatched identity": {OrderID: "broker-order-1", ClientOrderID: "op-order-1", Status: "canceled", FilledQty: 1, BrokerAccountID: "other", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"},
	} {
		t.Run(name, func(t *testing.T) {
			order := cancelTestOrder()
			storage := &cancelTestStorage{identity: identity, order: order}
			// Use a fresh result per case so no test can mutate another case's evidence.
			oc := NewOrderController(&fillReadbackTradingWithResult{result: result}, nil, storage)
			if err := oc.CancelOrderWithCapability(order.ID, "operator-secret"); err == nil {
				t.Fatal("accepted cancellation evidence without exact durable identity")
			}
			if storage.order.FilledQty != 0 || storage.order.Status != "accepted" {
				t.Fatalf("order mutated by rejected evidence: %#v", storage.order)
			}
		})
	}
}

type fillReadbackTradingWithResult struct {
	interfaces.TradingService
	result *interfaces.OrderResult
}

func (s *fillReadbackTradingWithResult) CancelOrder(context.Context, string) error {
	return &services.SubmissionUncertainError{Err: errors.New("terminal broker fill observed during cancellation"), Result: s.result}
}
