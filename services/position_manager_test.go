package services

import (
	"context"
	"errors"
	"path/filepath"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"testing"
	"time"
)

func TestValidateManagedBrokerOrderRequiresRolePurpose(t *testing.T) {
	position := &ManagedPosition{Symbol: "AAPL", Side: "buy", Quantity: 10}
	order := &interfaces.Order{Symbol: "AAPL", Side: "sell", Qty: 5, Type: "stop", TimeInForce: "gtc", Status: "new", Purpose: "entry"}
	if err := validateManagedBrokerOrder(position, order, "", true, "protection"); err == nil {
		t.Fatal("validateManagedBrokerOrder() accepted an entry-purpose order as protection")
	}
}

func TestValidateManagedOrderProjectionAcceptsCloseIntentForProtection(t *testing.T) {
	identity := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	projection := &models.DBManagedOrder{
		DurableIdentity: identity,
		PositionID:      "position-1",
		Role:            "protection",
		Purpose:         "protection",
		ClientOrderID:   "client-protection",
		BrokerOrderID:   "broker-protection",
		Symbol:          "AAPL",
		Side:            "sell",
		OrderType:       "stop",
		TimeInForce:     "gtc",
		RequestedQty:    1,
		StopPrice:       floatPtr(90),
		PositionIntent:  "buy_to_close",
		AssetClass:      "us_option",
		Underlying:      "AAPL",
	}
	order := &interfaces.Order{
		ID:              "broker-protection",
		ClientOrderID:   "client-protection",
		BrokerAccountID: identity.BrokerAccountID,
		PaperLive:       identity.PaperLive,
		TenantID:        identity.TenantID,
		SandboxID:       identity.SandboxID,
		Symbol:          "AAPL",
		Side:            "sell",
		Qty:             1,
		Type:            "stop",
		TimeInForce:     "gtc",
		StopPrice:       floatPtr(90),
		Status:          "new",
		Purpose:         "close",
		PositionIntent:  "buy_to_close",
		AssetClass:      "us_option",
		Underlying:      "AAPL",
	}
	if err := validateManagedOrderProjection(projection, order); err != nil {
		t.Fatalf("protection projection with broker close intent was rejected: %v", err)
	}
}

func TestValidateManagedBrokerOrderRequiresEntryContract(t *testing.T) {
	position := &ManagedPosition{Symbol: "AAPL", Side: "buy", Quantity: 10, EntryOrderType: "limit"}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 10, Side: "buy", Type: "market", TimeInForce: "gtc", Status: "new", Purpose: "entry"}
	if err := validateManagedBrokerOrder(position, order, "", false, "entry"); err == nil {
		t.Fatal("validateManagedBrokerOrder() accepted an entry order with the wrong type")
	}
}

func TestValidateManagedBrokerOrderRequiresEntryPrice(t *testing.T) {
	price := 101.0
	position := &ManagedPosition{Symbol: "AAPL", Side: "buy", Quantity: 10, EntryOrderType: "limit", EntryPrice: price}
	wrong := 102.0
	order := &interfaces.Order{Symbol: "AAPL", Qty: 10, Side: "buy", Type: "limit", TimeInForce: "gtc", LimitPrice: &wrong, Status: "new", Purpose: "entry"}
	if err := validateManagedBrokerOrder(position, order, "", false, "entry"); err == nil {
		t.Fatal("validateManagedBrokerOrder() accepted an entry order with the wrong price")
	}
}

func managedCancellationProjection(identity models.DurableIdentity, clientID, brokerID, positionID, role, purpose string) *models.DBManagedOrder {
	return &models.DBManagedOrder{DurableIdentity: identity, PositionID: positionID, Role: role, Purpose: purpose, ClientOrderID: clientID, BrokerOrderID: brokerID, Symbol: "AAPL", Side: "buy", OrderType: "market", TimeInForce: "day", RequestedQty: 1, Lifecycle: "accepted"}
}

func TestManagedCancellationBindingRequiresExactProjectionBeforeProvider(t *testing.T) {
	rec := &exitOrderRecorder{}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	position := &ManagedPosition{ID: "bound-position", DurableIdentity: storage.DurableIdentity(), EntryOrderID: "broker-entry", EntryClientOrderID: "client-entry"}
	if err := storage.SaveManagedOrder(managedCancellationProjection(storage.DurableIdentity(), "client-entry", "broker-entry", position.ID, "entry", "entry")); err != nil {
		t.Fatal(err)
	}
	bound, err := pm.boundManagedCancellations(position)
	if err != nil || len(bound) != 1 || bound[0].providerID != "broker-entry" {
		t.Fatalf("boundManagedCancellations() = %#v, %v; want exact bound provider identity", bound, err)
	}

	position.EntryClientOrderID = "missing-client"
	if _, err := pm.boundManagedCancellations(position); err == nil || rec.calls != 0 {
		t.Fatalf("missing projection err=%v provider calls=%d; want rejection before provider", err, rec.calls)
	}
}

func TestManagedCancellationBindingRejectsMismatchedAndAmbiguousProjections(t *testing.T) {
	rec := &exitOrderRecorder{}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	identity := storage.DurableIdentity()
	position := &ManagedPosition{ID: "bound-position-2", DurableIdentity: identity, EntryOrderID: "broker-entry", EntryClientOrderID: "client-entry"}
	projection := managedCancellationProjection(identity, "client-entry", "broker-other", position.ID, "entry", "entry")
	if err := storage.SaveManagedOrder(projection); err != nil {
		t.Fatal(err)
	}
	if _, err := pm.boundManagedCancellations(position); err == nil || rec.calls != 0 {
		t.Fatalf("mismatched projection err=%v provider calls=%d; want rejection before provider", err, rec.calls)
	}

	// A broker identity shared by two durable projections is ambiguous even if
	// the position fields otherwise look plausible.
	first := managedCancellationProjection(identity, "ambiguous-1", "broker-ambiguous", position.ID, "entry", "entry")
	second := managedCancellationProjection(identity, "ambiguous-2", "broker-ambiguous", position.ID, "entry", "entry")
	if err := storage.SaveManagedOrder(first); err != nil {
		t.Fatal(err)
	}
	if err := storage.SaveManagedOrder(second); err != nil {
		t.Fatal(err)
	}
	position.EntryOrderID, position.EntryClientOrderID = "broker-ambiguous", ""
	if _, err := pm.boundManagedCancellations(position); err == nil || rec.calls != 0 {
		t.Fatalf("ambiguous projection err=%v provider calls=%d; want rejection before provider", err, rec.calls)
	}
}

func uncertainCancellationResult() error {
	price := 101.0
	return &SubmissionUncertainError{
		Err:    errors.New("cancel outcome uncertain"),
		Result: &interfaces.OrderResult{OrderID: "broker-cancel", ClientOrderID: "client-cancel", Status: "canceled", Qty: 1, FilledQty: 1, FilledAvgPrice: &price},
	}
}

func TestPersistCancellationEvidenceRequiresCurrentPositionBinding(t *testing.T) {
	pm, storage := newTestPositionManager(t, &exitOrderRecorder{})
	defer storage.Close()
	identity := storage.DurableIdentity()
	if err := storage.SaveOrder(&interfaces.Order{ID: "broker-cancel", ClientOrderID: "client-cancel", Symbol: "AAPL", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "new", Purpose: "protection"}); err != nil {
		t.Fatal(err)
	}
	for _, projection := range []*models.DBManagedOrder{
		{DurableIdentity: identity, PositionID: "other-position", Role: "protection", Purpose: "protection", ClientOrderID: "client-cancel", BrokerOrderID: "broker-cancel", Symbol: "AAPL", Side: "sell", OrderType: "market", TimeInForce: "day", RequestedQty: 2, Lifecycle: "accepted"},
	} {
		if err := storage.SaveManagedOrder(projection); err != nil {
			t.Fatal(err)
		}
		before, err := storage.GetManagedOrder("client-cancel")
		if err != nil {
			t.Fatal(err)
		}
		err = pm.persistCancellationEvidence(managedCancellation{positionID: "current-position", providerID: "broker-cancel", clientID: "client-cancel", role: "protection", purpose: "protection"}, uncertainCancellationResult())
		if err == nil || before.FillWatermark != 0 {
			t.Fatalf("persistCancellationEvidence() err=%v before=%#v; want binding rejection without projection mutation", err, before)
		}
	}
	if err := storage.SaveOrder(&interfaces.Order{ID: "broker-missing", ClientOrderID: "client-missing", Symbol: "AAPL", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "new", Purpose: "protection"}); err != nil {
		t.Fatal(err)
	}
	if err := pm.persistCancellationEvidence(managedCancellation{positionID: "current-position", providerID: "broker-missing", clientID: "client-missing", role: "protection", purpose: "protection"}, uncertainCancellationResult()); err == nil {
		t.Fatal("persistCancellationEvidence() accepted missing managed position projection")
	}
}

func TestSiblingCancellationPersistsPositiveFillEvidence(t *testing.T) {
	rec := &exitOrderRecorder{cancelErr: uncertainCancellationResult()}
	dbPath := filepath.Join(t.TempDir(), "sibling.db")
	pm, storage := newTestPositionManagerAt(t, rec, dbPath)
	rec.cancelErr.(*SubmissionUncertainError).Result.BrokerAccountID = storage.DurableIdentity().BrokerAccountID
	rec.cancelErr.(*SubmissionUncertainError).Result.PaperLive = storage.DurableIdentity().PaperLive
	rec.cancelErr.(*SubmissionUncertainError).Result.TenantID = storage.DurableIdentity().TenantID
	rec.cancelErr.(*SubmissionUncertainError).Result.SandboxID = storage.DurableIdentity().SandboxID
	position := &ManagedPosition{ID: "sibling-position", DurableIdentity: storage.DurableIdentity(), StopLossOrderID: "broker-cancel", StopLossClientOrderID: "client-cancel"}
	if err := storage.SaveOrder(&interfaces.Order{ID: "broker-cancel", ClientOrderID: "client-cancel", Symbol: "AAPL", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "new", Purpose: "protection"}); err != nil {
		t.Fatal(err)
	}
	projection := managedCancellationProjection(storage.DurableIdentity(), "client-cancel", "broker-cancel", position.ID, "protection", "protection")
	projection.Side = "sell"
	if err := storage.SaveManagedOrder(projection); err != nil {
		t.Fatal(err)
	}
	cancelErr := pm.cancelSiblingExitOrders(context.Background(), position, "different-order")
	if cancelErr == nil {
		t.Fatal("cancelSiblingExitOrders() unexpectedly succeeded")
	}
	order, err := storage.GetOrder("broker-cancel")
	if err != nil || order == nil || order.FilledQty != 1 {
		t.Fatalf("generic cancellation evidence = %#v, %v; want positive fill", order, err)
	}
	projection, err = storage.GetManagedOrder("client-cancel")
	if err != nil || projection == nil || projection.FillWatermark != 1 {
		t.Fatalf("managed cancellation evidence = %#v, %v; want durable watermark", projection, err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := database.NewLocalStorage(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	projection, err = reopened.GetManagedOrder("client-cancel")
	if err != nil || projection == nil || projection.FillWatermark != 1 {
		t.Fatalf("reopened managed cancellation evidence = %#v, %v; want durable watermark", projection, err)
	}
}

func TestPersistCancellationEvidenceRejectsMissingOrMismatchedIdentityAfterReopen(t *testing.T) {
	for name, mutate := range map[string]func(*interfaces.OrderResult){
		"missing identity": func(result *interfaces.OrderResult) {},
		"mismatched identity": func(result *interfaces.OrderResult) {
			result.BrokerAccountID = "other-account"
		},
	} {
		t.Run(name, func(t *testing.T) {
			dbPath := filepath.Join(t.TempDir(), "invalid-cancellation.db")
			rec := &exitOrderRecorder{}
			pm, storage := newTestPositionManagerAt(t, rec, dbPath)
			identity := storage.DurableIdentity()
			position := &ManagedPosition{ID: "invalid-position", DurableIdentity: identity}
			order := &interfaces.Order{ID: "broker-invalid", ClientOrderID: "client-invalid", BrokerAccountID: identity.BrokerAccountID, PaperLive: identity.PaperLive, TenantID: identity.TenantID, SandboxID: identity.SandboxID, Symbol: "AAPL", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "new", Purpose: "protection"}
			if err := storage.SaveOrder(order); err != nil {
				t.Fatal(err)
			}
			projection := managedCancellationProjection(identity, order.ClientOrderID, order.ID, position.ID, "protection", "protection")
			if err := storage.SaveManagedOrder(projection); err != nil {
				t.Fatal(err)
			}
			resultErr := uncertainCancellationResult()
			result := resultErr.(*SubmissionUncertainError).Result
			mutate(result)
			if err := pm.persistCancellationEvidence(managedCancellation{positionID: position.ID, providerID: order.ID, clientID: order.ClientOrderID, role: "protection", purpose: "protection"}, resultErr); err == nil {
				t.Fatal("persistCancellationEvidence() accepted invalid identity")
			}
			if err := storage.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := database.NewLocalStorage(dbPath)
			if err != nil {
				t.Fatal(err)
			}
			savedOrder, err := reopened.GetOrder(order.ID)
			if err != nil {
				t.Fatal(err)
			}
			savedProjection, err := reopened.GetManagedOrder(order.ClientOrderID)
			if err != nil {
				t.Fatal(err)
			}
			_ = reopened.Close()
			if savedOrder.FilledQty != 0 || savedProjection.FillWatermark != 0 {
				t.Fatalf("invalid cancellation evidence persisted after reopen: order=%#v projection=%#v", savedOrder, savedProjection)
			}
		})
	}
}

func TestPartialProtectionCancellationPersistsPositiveFillEvidence(t *testing.T) {
	rec := &exitOrderRecorder{cancelErr: uncertainCancellationResult()}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	rec.cancelErr.(*SubmissionUncertainError).Result.BrokerAccountID = storage.DurableIdentity().BrokerAccountID
	rec.cancelErr.(*SubmissionUncertainError).Result.PaperLive = storage.DurableIdentity().PaperLive
	rec.cancelErr.(*SubmissionUncertainError).Result.TenantID = storage.DurableIdentity().TenantID
	rec.cancelErr.(*SubmissionUncertainError).Result.SandboxID = storage.DurableIdentity().SandboxID
	position := &ManagedPosition{ID: "partial-position", DurableIdentity: storage.DurableIdentity(), Symbol: "AAPL", Side: "buy"}
	order := &interfaces.Order{ID: "broker-cancel", ClientOrderID: "client-cancel", Symbol: "AAPL", Qty: 1, Side: "sell", Type: "stop", TimeInForce: "gtc", Status: "partially_filled", Purpose: "protection"}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	projection := managedCancellationProjection(storage.DurableIdentity(), order.ClientOrderID, order.ID, position.ID, "protection", "protection")
	projection.Side = "sell"
	projection.OrderType = order.Type
	projection.TimeInForce = order.TimeInForce
	if err := storage.SaveManagedOrder(projection); err != nil {
		t.Fatal(err)
	}
	if _, err := pm.cancelProtectionResidual(context.Background(), position, order); err == nil {
		t.Fatal("cancelProtectionResidual() unexpectedly succeeded")
	}
	reopened, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil || reopened == nil || reopened.FillWatermark != 1 {
		t.Fatalf("partial cancellation evidence = %#v, %v; want durable watermark", reopened, err)
	}
}

type exitOrderRecorder struct {
	placed     *interfaces.Order
	result     *interfaces.OrderResult
	placeErr   error
	marker     func(string, string, string) error
	markerFail bool
	calls      int
	cancelErr  error
}

func (s *exitOrderRecorder) SetManagedSubmissionMarker(marker func(string, string, string) error) {
	s.marker = marker
}

func (s *exitOrderRecorder) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	if s.marker != nil {
		role := o.ManagedRole
		if s.markerFail {
			role += "-mismatch"
		}
		if err := s.marker(o.ClientOrderID, o.ManagedPositionID, role); err != nil {
			return nil, err
		}
	}
	s.calls++
	s.placed = o
	if s.result != nil && s.result.Qty == 0 {
		copyResult := *s.result
		copyResult.Qty = o.Qty
		copyResult.ClientOrderID = o.ClientOrderID
		copyResult.Symbol, copyResult.Side = o.Symbol, o.Side
		copyResult.Type, copyResult.TimeInForce = o.Type, o.TimeInForce
		copyResult.LimitPrice, copyResult.StopPrice = o.LimitPrice, o.StopPrice
		copyResult.PositionIntent, copyResult.Purpose = o.PositionIntent, o.Purpose
		copyResult.BrokerAccountID, copyResult.PaperLive = o.BrokerAccountID, o.PaperLive
		copyResult.TenantID, copyResult.SandboxID = o.TenantID, o.SandboxID
		s.result = &copyResult
	}
	return s.result, s.placeErr
}

func TestManagedEntryMarkerFailureDoesNotCallBroker(t *testing.T) {
	rec := &exitOrderRecorder{markerFail: true}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	position := &ManagedPosition{DurableIdentity: storage.DurableIdentity(), ID: "entry-marker-position", Symbol: "AAPL", Side: "buy", Quantity: 1, EntryPrice: 100, EntryClientOrderID: "entry-marker-client", EntryOrderType: "market"}
	err := pm.placeEntryOrder(context.Background(), position)
	if err == nil || rec.calls != 0 {
		t.Fatalf("placeEntryOrder() err=%v calls=%d, want marker failure and zero broker calls", err, rec.calls)
	}
	order, orderErr := storage.GetOrderByClientOrderID(position.EntryClientOrderID)
	projection, projectionErr := storage.GetManagedOrder(position.EntryClientOrderID)
	if orderErr != nil || projectionErr != nil || order == nil || projection == nil || order.SubmissionAttempted || projection.SubmissionAttempted {
		t.Fatalf("failed marker persisted generic=%#v managed=%#v errors=(%v,%v), want both unattempted", order, projection, orderErr, projectionErr)
	}
}

func TestManagedProtectionMarkerFailureDoesNotCallBroker(t *testing.T) {
	rec := &exitOrderRecorder{markerFail: true}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	position := &ManagedPosition{DurableIdentity: storage.DurableIdentity(), ID: "protection-marker-position", Symbol: "AAPL", Side: "buy", Quantity: 1, RemainingQty: 1, StopLossPrice: 90, StopLossClientOrderID: "protection-marker-client"}
	err := pm.placeStopLossOrder(context.Background(), position)
	if err == nil || rec.calls != 0 {
		t.Fatalf("placeStopLossOrder() err=%v calls=%d, want marker failure and zero broker calls", err, rec.calls)
	}
	order, orderErr := storage.GetOrderByClientOrderID(position.StopLossClientOrderID)
	projection, projectionErr := storage.GetManagedOrder(position.StopLossClientOrderID)
	if orderErr != nil || projectionErr != nil || order == nil || projection == nil || order.SubmissionAttempted || projection.SubmissionAttempted {
		t.Fatalf("failed marker persisted generic=%#v managed=%#v errors=(%v,%v), want both unattempted", order, projection, orderErr, projectionErr)
	}
}
func (s *exitOrderRecorder) CancelOrder(context.Context, string) error { return s.cancelErr }
func (s *exitOrderRecorder) GetOrder(context.Context, string) (*interfaces.Order, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetOrderByClientOrderID(context.Context, string) (*interfaces.Order, error) {
	return nil, nil
}
func (s *exitOrderRecorder) ListOrders(context.Context, string) ([]*interfaces.Order, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetPositions(context.Context) ([]*interfaces.Position, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetAccount(context.Context) (*interfaces.Account, error) {
	return nil, nil
}
func (s *exitOrderRecorder) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetOptionsChain(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetOptionsQuote(context.Context, string) (*interfaces.OptionsQuote, error) {
	return nil, nil
}
func (s *exitOrderRecorder) GetOptionsPosition(context.Context, string) (*interfaces.OptionsPosition, error) {
	return nil, nil
}
func (s *exitOrderRecorder) ListOptionsPositions(context.Context) ([]*interfaces.OptionsPosition, error) {
	return nil, nil
}

func newTestPositionManager(t *testing.T, rec *exitOrderRecorder) (*PositionManager, *database.LocalStorage) {
	t.Helper()
	return newTestPositionManagerAt(t, rec, filepath.Join(t.TempDir(), "pm.db"))
}

func newTestPositionManagerAt(t *testing.T, rec *exitOrderRecorder, dbPath string) (*PositionManager, *database.LocalStorage) {
	t.Helper()
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(dbPath)
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	return NewPositionManager(rec, nil, storage), storage
}

func TestSaveManagedPositionUpdatesByPositionID(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "managed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	first := &models.DBManagedPosition{PositionID: "managed-1", Symbol: "AAPL", Status: "PENDING", RemainingQty: 10}
	if err := storage.SaveManagedPosition(first); err != nil {
		t.Fatal(err)
	}
	second := *first
	second.Status = "CLOSED"
	second.RemainingQty = 0
	if err := storage.SaveManagedPosition(&second); err != nil {
		t.Fatal(err)
	}
	positions, err := storage.GetAllManagedPositions("")
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 1 || positions[0].Status != "CLOSED" || positions[0].RemainingQty != 0 {
		t.Fatalf("positions = %#v, want one updated row", positions)
	}
}

func TestManagedSubmissionAttemptedCannotRetryAfterNotFound(t *testing.T) {
	rec := &exitOrderRecorder{}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	attempted := &interfaces.Order{ClientOrderID: "managed-attempted", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Status: "submission_uncertain", Purpose: "entry", SubmissionAttempted: true}
	if err := storage.SaveOrder(attempted); err != nil {
		t.Fatalf("SaveOrder() error = %v", err)
	}
	if err := pm.prepareManagedOrderIdentity(context.Background(), attempted.ClientOrderID); !IsSubmissionUncertain(err) {
		t.Fatalf("prepareManagedOrderIdentity() error = %v, want submission uncertainty", err)
	}
}

func TestProtectionFillWatermarkRejectsDuplicateAndPersists(t *testing.T) {
	pm, storage := newTestPositionManager(t, &exitOrderRecorder{})
	defer storage.Close()
	price := 95.0
	position := &ManagedPosition{ID: "wm-1", Symbol: "AAPL", Side: "buy", Quantity: 10, RemainingQty: 10}
	order := &interfaces.Order{ID: "broker-stop-1", Symbol: "AAPL", Side: "sell", Qty: 6, FilledQty: 4, FilledAvgPrice: &price, Status: "filled"}
	if delta := pm.applyProtectionFillWatermark(position, order); delta != 4 {
		t.Fatalf("first protection fill delta = %v, want 4", delta)
	}
	if delta := pm.applyProtectionFillWatermark(position, order); delta != 0 {
		t.Fatalf("duplicate protection fill delta = %v, want 0", delta)
	}
	order.FilledQty = 6
	if delta := pm.applyProtectionFillWatermark(position, order); delta != 2 {
		t.Fatalf("incremental protection fill delta = %v, want 2", delta)
	}
	if err := pm.savePositionToDB(position); err != nil {
		t.Fatal(err)
	}
	dbPosition, err := storage.GetManagedPosition(position.ID)
	if err != nil {
		t.Fatal(err)
	}
	reloaded := pm.dbToManagedPosition(dbPosition)
	if reloaded.ProtectionFillWatermarks[order.ID] != 6 {
		t.Fatalf("watermark = %#v, want 6", reloaded.ProtectionFillWatermarks)
	}
}

func TestManagedProtectiveLegsPersistIntentBeforeSubmit(t *testing.T) {
	cases := []struct {
		name     string
		position func() *ManagedPosition
		place    func(*PositionManager, *ManagedPosition) error
	}{
		{
			name: "stop_loss",
			position: func() *ManagedPosition {
				return &ManagedPosition{ID: "p1", Symbol: "AAPL", Side: "buy", RemainingQty: 10, StopLossPrice: 90}
			},
			place: func(pm *PositionManager, pos *ManagedPosition) error {
				return pm.placeStopLossOrder(context.Background(), pos)
			},
		},
		{
			name: "take_profit",
			position: func() *ManagedPosition {
				return &ManagedPosition{ID: "p2", Symbol: "AAPL", Side: "buy", RemainingQty: 10, TakeProfitPrice: 110}
			},
			place: func(pm *PositionManager, pos *ManagedPosition) error {
				return pm.placeTakeProfitOrder(context.Background(), pos)
			},
		},
		{
			name: "partial_exit",
			position: func() *ManagedPosition {
				return &ManagedPosition{ID: "p3", Symbol: "AAPL", Side: "buy", Quantity: 10, RemainingQty: 10, PartialExit: &PartialExitConfig{Enabled: true, Percent: 50, TargetPrice: 105}}
			},
			place: func(pm *PositionManager, pos *ManagedPosition) error {
				return pm.placePartialExitOrder(context.Background(), pos)
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name+"/submit_fails", func(t *testing.T) {
			rec := &exitOrderRecorder{placeErr: errors.New("broker timeout")}
			pm, storage := newTestPositionManager(t, rec)
			defer storage.Close()

			if err := tc.place(pm, tc.position()); err == nil {
				t.Fatal("expected an error when the broker submit fails")
			}
			if rec.placed == nil || rec.placed.ClientOrderID == "" {
				t.Fatalf("PlaceOrder should receive an order carrying a ClientOrderID, got %#v", rec.placed)
			}
			failed, err := storage.GetOrders("submit_failed")
			if err != nil {
				t.Fatalf("GetOrders(submit_failed) error = %v", err)
			}
			if len(failed) != 1 || failed[0].ClientOrderID != rec.placed.ClientOrderID {
				t.Fatalf("expected 1 submit_failed intent persisted with the broker client id, got %#v", failed)
			}
		})

		t.Run(tc.name+"/submit_ok", func(t *testing.T) {
			rec := &exitOrderRecorder{result: &interfaces.OrderResult{OrderID: "broker-" + tc.name, Status: "accepted"}}
			pm, storage := newTestPositionManager(t, rec)
			defer storage.Close()

			if err := tc.place(pm, tc.position()); err != nil {
				t.Fatalf("place() unexpected error = %v", err)
			}
			saved, err := storage.GetOrder("broker-" + tc.name)
			if err != nil {
				t.Fatalf("GetOrder() error = %v", err)
			}
			if saved.Status != "accepted" || saved.ClientOrderID == "" {
				t.Fatalf("saved order = %#v, want accepted status + a ClientOrderID", saved)
			}
			all, err := storage.GetOrders("")
			if err != nil {
				t.Fatalf("GetOrders() error = %v", err)
			}
			if len(all) != 1 {
				t.Fatalf("expected exactly 1 row after pre-submit + post-submit upsert, got %d", len(all))
			}
		})
	}
}

func TestCloseManagedPositionPersistsExitIntentOnAmbiguousSubmit(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	rec := &exitOrderRecorder{placeErr: errors.New("market closed")}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()

	pos := &ManagedPosition{ID: "c1", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", RemainingQty: 10}
	pos.DurableIdentity = storage.DurableIdentity()
	pm.positions[pos.ID] = pos

	capability, err := NewPositionCloseCapability("operator-secret", storage.DurableIdentity())
	if err != nil {
		t.Fatal(err)
	}
	if err := pm.CloseManagedPositionWithCapability(context.Background(), pos.ID, capability); err == nil {
		t.Fatal("expected CloseManagedPosition to report an unconfirmed exit")
	}
	if pos.Status != "CLOSING" {
		t.Fatalf("position status = %q, want CLOSING when the exit submit fails", pos.Status)
	}
	if rec.placed == nil || rec.placed.ClientOrderID == "" {
		t.Fatalf("exit PlaceOrder should carry a ClientOrderID, got %#v", rec.placed)
	}
	failed, err := storage.GetOrders("submit_failed")
	if err != nil {
		t.Fatalf("GetOrders(submit_failed) error = %v", err)
	}
	if len(failed) != 1 || failed[0].ClientOrderID != rec.placed.ClientOrderID {
		t.Fatalf("expected the ambiguous exit persisted as submit_failed for reconciliation, got %#v", failed)
	}
	projection, err := storage.GetManagedOrder(rec.placed.ClientOrderID)
	if err != nil {
		t.Fatalf("GetManagedOrder() error = %v", err)
	}
	if projection == nil || projection.PositionID != pos.ID || projection.Purpose != "close" || !projection.SubmissionAttempted || projection.Lifecycle != "submit_failed" {
		t.Fatalf("close projection = %#v, want attempted close lifecycle for reconciliation", projection)
	}
}

func TestCloseManagedPositionDoesNotRecloseCLOSINGPosition(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	rec := &exitOrderRecorder{result: &interfaces.OrderResult{OrderID: "accepted-exit", Status: "accepted"}}
	pm, storage := newTestPositionManager(t, rec)
	defer storage.Close()
	pos := &ManagedPosition{ID: "c3", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", Quantity: 10, RemainingQty: 10}
	pos.DurableIdentity = storage.DurableIdentity()
	pm.positions[pos.ID] = pos
	capability, err := NewPositionCloseCapability("operator-secret", storage.DurableIdentity())
	if err != nil {
		t.Fatal(err)
	}
	if err := pm.CloseManagedPositionWithCapability(context.Background(), pos.ID, capability); err == nil {
		t.Fatal("expected first close to remain unresolved")
	}
	if err := pm.CloseManagedPositionWithCapability(context.Background(), pos.ID, capability); err == nil {
		t.Fatal("expected repeated close to be rejected while CLOSING")
	}
	if pos.Status != "CLOSING" {
		t.Fatalf("position status = %q, want CLOSING", pos.Status)
	}
}
func TestValidateRequestRejectsInvalidManagedRiskLevels(t *testing.T) {
	entry, stop := 100.0, 90.0
	valid := &PlaceManagedPositionRequest{
		Symbol: "AAPL", Side: "buy", AllocationDollars: 1000, EntryStrategy: "limit",
		EntryPrice: &entry, StopLossPrice: &stop,
	}
	pm := &PositionManager{}
	if err := pm.validateRequest(valid); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	badStop := 0.0
	valid.StopLossPrice = &badStop
	if err := pm.validateRequest(valid); err == nil {
		t.Fatal("expected non-positive stop loss to be rejected")
	}
}

func TestValidateRequestRejectsMultipleProtectionLegs(t *testing.T) {
	stop, target := 90.0, 110.0
	req := &PlaceManagedPositionRequest{Symbol: "AAPL", Side: "buy", AllocationDollars: 1000, StopLossPrice: &stop, TakeProfitPrice: &target}
	if err := (&PositionManager{}).validateRequest(req); err == nil {
		t.Fatal("expected multiple executable protection legs to be rejected")
	}
}

func TestValidateRequestRejectsUnboundedManagedEntries(t *testing.T) {
	for _, strategy := range []string{"", "market"} {
		req := &PlaceManagedPositionRequest{Side: "buy", EntryStrategy: strategy}
		if err := (&PositionManager{}).validateRequest(req); err == nil {
			t.Fatalf("expected %q managed entry strategy to be rejected", strategy)
		}
	}
}
