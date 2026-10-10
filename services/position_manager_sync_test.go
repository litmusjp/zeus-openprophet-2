package services

import (
	"context"
	"errors"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"runtime"
	"testing"
	"time"
)

type syncRegressionBroker struct {
	exitOrderRecorder
	lookupErr  error
	openOrders []*interfaces.Order
}

func (r *syncRegressionBroker) ListOrders(ctx context.Context, status string) ([]*interfaces.Order, error) {
	if status == "open" && r.openOrders != nil {
		return r.openOrders, nil
	}
	return r.exitOrderRecorder.ListOrders(ctx, status)
}

func (r *syncRegressionBroker) GetOrderByClientOrderID(ctx context.Context, id string) (*interfaces.Order, error) {
	for _, o := range r.brokerOrders {
		if o.ClientOrderID == id {
			return o, nil
		}
	}
	if r.lookupErr != nil {
		return nil, r.lookupErr
	}
	return nil, &OrderLookupError{ClientOrderID: id, NotFound: true}
}
func (r *syncRegressionBroker) PlaceOrder(ctx context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	res, err := r.exitOrderRecorder.PlaceOrder(ctx, o)
	if err != nil {
		return res, err
	}
	copy := *o
	copy.ID = res.OrderID
	copy.Status = "new"
	copy.Purpose = "close"
	copy.AssetClass = "us_equity"
	copy.Underlying = copy.Symbol
	copy.PositionIntent = "sell_to_close"
	r.brokerOrders[copy.ID] = &copy
	return res, nil
}
func syncRegressionRecoveryFixture(t *testing.T) (*PositionManager, *database.LocalStorage, *syncRegressionBroker, *ManagedPosition) {
	t.Helper()
	r := &syncRegressionBroker{}
	pm, s := newTestPositionManager(t, &r.exitOrderRecorder)
	pm.tradingService = r
	r.result = &interfaces.OrderResult{OrderID: "new-stop", Status: "new"}
	r.brokerOrders = map[string]*interfaces.Order{}
	i := s.DurableIdentity()
	price := 270.0
	p := &ManagedPosition{DurableIdentity: i, ID: "recovery", Symbol: "IWM", Side: "buy", Quantity: 1, RemainingQty: 1, Status: "PROTECTION_BLOCKED", StopLossPrice: price, StopLossOrderID: "old-stop", StopLossClientOrderID: "old-client", EntryOrderID: "entry", EntryClientOrderID: "entry-client", EntryOrderType: "market"}
	r.account = &interfaces.Account{ID: i.BrokerAccountID, BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID}
	r.positions = []*interfaces.Position{{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, Symbol: "IWM", Side: "long", Qty: 1}}
	fill := 282.0
	entry := &interfaces.Order{ID: "entry", ClientOrderID: "entry-client", BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, Symbol: "IWM", Side: "buy", Qty: 1, Type: "market", TimeInForce: "day", Status: "filled", FilledQty: 1, FilledAvgPrice: &fill, AssetClass: "us_equity", PositionIntent: "buy_to_open", Purpose: "entry"}
	old := &interfaces.Order{ID: "old-stop", ClientOrderID: "old-client", BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, Symbol: "IWM", Side: "sell", Qty: 1, Type: "stop", TimeInForce: "gtc", StopPrice: &price, Status: "canceled", AssetClass: "us_equity", PositionIntent: "sell_to_close", Purpose: "close"}
	for _, o := range []*interfaces.Order{entry, old} {
		role, purpose := "protection", "protection"
		if o == entry {
			role, purpose = "entry", "entry"
		}
		proj := &models.DBManagedOrder{DurableIdentity: i, PositionID: p.ID, Role: role, Purpose: purpose, ClientOrderID: o.ClientOrderID, BrokerOrderID: o.ID, Symbol: o.Symbol, Side: o.Side, AssetClass: o.AssetClass, PositionIntent: o.PositionIntent, OrderType: o.Type, TimeInForce: o.TimeInForce, RequestedQty: 1, StopPrice: o.StopPrice, Lifecycle: o.Status, FilledQty: o.FilledQty, FillWatermark: o.FilledQty, FilledAvgPrice: o.FilledAvgPrice}
		if err := s.SaveManagedOrder(proj); err != nil {
			t.Fatal(err)
		}
		r.brokerOrders[o.ID] = o
	}
	if e := pm.savePositionToDB(p); e != nil {
		t.Fatal(e)
	}
	pm.positions[p.ID] = p
	return pm, s, r, p
}

func TestConcurrentRecoveryAndExecutionHealth(t *testing.T) {
	pm, s, r, p := syncRegressionRecoveryFixture(t)
	defer s.Close()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				pm.ExecutionBlocked()
				runtime.Gosched()
			}
		}
	}()
	pm.checkPositions(context.Background())
	close(stop)
	<-done
	if r.calls != 1 || p.Status != "ACTIVE" {
		t.Fatalf("recovery failed calls=%d state=%s", r.calls, p.Status)
	}
}

func TestRollbackRecoveryAndReadinessStayBlocked(t *testing.T) {
	pm, s, r, p := syncRegressionRecoveryFixture(t)
	defer s.Close()
	// Make the persisted old stop fail symbol validation so recovery takes its
	// rollback path while readiness readers run concurrently.
	r.brokerOrders["old-stop"].Symbol = "QQQ"
	stop := make(chan struct{})
	done := make(chan struct{})
	var violations int
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				if !pm.ExecutionBlocked() {
					violations++
				}
				runtime.Gosched()
			}
		}
	}()
	pm.checkPositions(context.Background())
	close(stop)
	<-done
	if violations != 0 || !pm.ExecutionBlocked() || p.Status != "PROTECTION_BLOCKED" || r.calls != 0 {
		t.Fatalf("rollback did not remain blocked: violations=%d blocked=%v state=%s submissions=%d", violations, pm.ExecutionBlocked(), p.Status, r.calls)
	}
}

func startupFilledCloseFixture(t *testing.T) (*PositionManager, *database.LocalStorage, *syncRegressionBroker, *ManagedPosition, *interfaces.Order, time.Time) {
	t.Helper()
	r := &syncRegressionBroker{}
	pm, s := newTestPositionManager(t, &r.exitOrderRecorder)
	pm.tradingService = r
	i := s.DurableIdentity()
	r.account = &interfaces.Account{ID: i.BrokerAccountID, BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID}
	r.positions = []*interfaces.Position{}
	r.brokerOrders = map[string]*interfaces.Order{}
	p := &ManagedPosition{DurableIdentity: i, ID: "xom-blocked", Symbol: "XOM", Side: "buy", Status: "PROTECTION_BLOCKED", Quantity: 40, RemainingQty: 40, StopLossOrderID: "xom-stop", StopLossClientOrderID: "xom-stop-client", EntryOrderID: "xom-entry", EntryClientOrderID: "xom-entry-client", EntryOrderType: "market"}
	entryTime, err := time.Parse(time.RFC3339Nano, "2026-10-09T12:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	entryPrice := 170.0
	entry := &interfaces.Order{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, ID: "xom-entry", ClientOrderID: "xom-entry-client", Symbol: "XOM", Qty: 40, Side: "buy", Type: "market", TimeInForce: "day", Status: "filled", FilledQty: 40, FilledAvgPrice: &entryPrice, FilledAt: &entryTime, AssetClass: "us_equity", Underlying: "XOM", Purpose: "entry", PositionIntent: "buy_to_open"}
	stopPrice := 160.0
	stop := &interfaces.Order{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, ID: "xom-stop", ClientOrderID: "xom-stop-client", Symbol: "XOM", Qty: 40, Side: "sell", Type: "stop", TimeInForce: "gtc", StopPrice: &stopPrice, Status: "canceled", AssetClass: "us_equity", Underlying: "XOM", Purpose: "close", PositionIntent: "sell_to_close"}
	for _, o := range []*interfaces.Order{entry, stop} {
		local := *o
		if o == stop {
			local.Purpose = "protection"
		}
		local.SubmissionAttempted = true
		if err := s.SaveOrder(&local); err != nil {
			t.Fatal(err)
		}
		role, purpose := "entry", "entry"
		if o == stop {
			role, purpose = "protection", "protection"
		}
		projection := &models.DBManagedOrder{DurableIdentity: i, PositionID: p.ID, Role: role, Purpose: purpose, ClientOrderID: o.ClientOrderID, BrokerOrderID: o.ID, Symbol: o.Symbol, Side: o.Side, AssetClass: o.AssetClass, Underlying: o.Underlying, PositionIntent: o.PositionIntent, OrderType: o.Type, TimeInForce: o.TimeInForce, RequestedQty: 40, StopPrice: o.StopPrice, Lifecycle: o.Status, SubmissionAttempted: true, FilledQty: o.FilledQty, FilledAvgPrice: o.FilledAvgPrice, FilledAt: o.FilledAt, FillWatermark: o.FilledQty}
		if err := s.SaveManagedOrder(projection); err != nil {
			t.Fatal(err)
		}
		r.brokerOrders[o.ID] = o
	}
	if err := pm.savePositionToDB(p); err != nil {
		t.Fatal(err)
	}
	pm.positions[p.ID] = p
	closeTime, err := time.Parse(time.RFC3339Nano, "2026-10-09T13:32:14.298977601Z")
	if err != nil {
		t.Fatal(err)
	}
	close := &interfaces.Order{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, ClientOrderID: "herald-xom-exit-20261009-01", Symbol: "XOM", Qty: 40, Side: "sell", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(167), Status: "pending_new", Purpose: "close", SubmissionAttempted: true}
	if err := s.SaveOrder(close); err != nil {
		t.Fatal(err)
	}
	brokerClose := *close
	brokerClose.ID, brokerClose.Status, brokerClose.FilledQty, brokerClose.FilledAvgPrice, brokerClose.FilledAt = "314248a9-8b4a-4b8f-8a3c-e8efab44f951", "filled", 40, floatPtr(168.07), &closeTime
	brokerClose.Revision = 0
	brokerClose.AssetClass, brokerClose.Underlying, brokerClose.PositionIntent = "us_equity", "XOM", "sell_to_close"
	r.brokerOrders[brokerClose.ID] = &brokerClose
	withdrawn := &interfaces.Order{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, ClientOrderID: "op-xom-sell-open-001", Symbol: "XOM", Qty: 40, Side: "sell", Type: "market", TimeInForce: "day", Status: "withdrawn", Purpose: "close", SubmissionAttempted: false}
	if err := s.SaveOrder(withdrawn); err != nil {
		t.Fatal(err)
	}
	p.TakeProfitClientOrderID = "failed-protection"
	if err := pm.savePositionToDB(p); err != nil {
		t.Fatal(err)
	}
	failedProjection := &models.DBManagedOrder{DurableIdentity: i, PositionID: p.ID, Role: "protection", Purpose: "protection", ClientOrderID: "failed-protection", Symbol: "XOM", Side: "sell", OrderType: "limit", TimeInForce: "day", RequestedQty: 40, Lifecycle: "submit_failed", SubmissionAttempted: false}
	if err := s.SaveManagedOrder(failedProjection); err != nil {
		t.Fatal(err)
	}
	failedRow := &interfaces.Order{BrokerAccountID: i.BrokerAccountID, PaperLive: i.PaperLive, TenantID: i.TenantID, SandboxID: i.SandboxID, ClientOrderID: "failed-protection", Symbol: "XOM", Side: "sell", Qty: 40, Type: "limit", TimeInForce: "day", Status: "submit_failed", Purpose: "protection"}
	if err := s.SaveOrder(failedRow); err != nil {
		t.Fatal(err)
	}
	return pm, s, r, p, &brokerClose, closeTime
}

func TestStartupReconcilesFilledGenericCloseForBlockedEquity(t *testing.T) {
	pm, s, broker, p, brokerClose, closeTime := startupFilledCloseFixture(t)
	defer s.Close()
	if skipped := pm.ReconcilePersistedPositions(context.Background()); skipped != 0 {
		t.Fatalf("reconcile skipped %d positions", skipped)
	}
	if p.Status != "CLOSED" || p.ExitOrderID != brokerClose.ID || p.ExitClientOrderID != "herald-xom-exit-20261009-01" || p.ExitFilledQty != 40 || p.RemainingQty != 0 || p.ClosedAt == nil || !p.ClosedAt.Equal(closeTime) {
		t.Fatalf("startup did not recover exact filled close: %#v", p)
	}
	projection, err := s.GetManagedOrder(brokerClose.ClientOrderID)
	if err != nil || projection == nil || projection.BrokerOrderID != brokerClose.ID || projection.OrderType != "limit" || projection.LimitPrice == nil || *projection.LimitPrice != 167 {
		t.Fatalf("recovered close projection lost broker identity or limit: %#v err=%v", projection, err)
	}
	if _, err := s.GetOrderByClientOrderID("op-xom-sell-open-001"); err != nil {
		t.Fatalf("withdrawn plan was lost: %v", err)
	}
	if broker.calls != 0 || broker.cancelCalls != 0 {
		t.Fatalf("startup recovery mutated broker: place=%d cancel=%d", broker.calls, broker.cancelCalls)
	}
	reloaded := NewPositionManager(broker, nil, s)
	if skipped := reloaded.ReconcilePersistedPositions(context.Background()); skipped != 0 {
		t.Fatalf("reload reconciliation skipped %d", skipped)
	}
	closed, err := s.GetManagedPosition(p.ID)
	if err != nil || closed.Status != "CLOSED" || closed.ClosedAt == nil || !closed.ClosedAt.Equal(closeTime) {
		t.Fatalf("reloaded closed position=%#v err=%v", closed, err)
	}
	failedSaved, err := s.GetOrderByClientOrderID("failed-protection")
	if err != nil || failedSaved.Status != "submit_failed" || failedSaved.SubmissionAttempted {
		t.Fatalf("failed protection row changed: %#v err=%v", failedSaved, err)
	}
}

func TestStartupFilledCloseRejectsAmbiguousOrUncertainEvidence(t *testing.T) {
	for _, name := range []string{"partial fill", "wrong quantity", "wrong account", "wrong close intent", "lookup unavailable", "lookup not found", "ambiguous local closes", "open provider row with unfamiliar status"} {
		t.Run(name, func(t *testing.T) {
			pm, s, broker, position, closeOrder, _ := startupFilledCloseFixture(t)
			defer s.Close()
			switch name {
			case "partial fill":
				closeOrder.FilledQty = 0.5
			case "wrong quantity":
				closeOrder.Qty = 2
			case "wrong account":
				closeOrder.TenantID = "different-tenant"
			case "wrong close intent":
				closeOrder.PositionIntent = "sell_to_open"
			case "lookup unavailable":
				broker.lookupErr = errors.New("broker lookup unavailable")
			case "lookup not found":
				delete(broker.brokerOrders, closeOrder.ID)
			case "ambiguous local closes":
				other := *closeOrder
				other.ID, other.ClientOrderID, other.Revision, other.Status = "", "xom-close-ambiguous", 0, "pending_new"
				if err := s.SaveOrder(&other); err != nil {
					t.Fatal(err)
				}
			case "open provider row with unfamiliar status":
				broker.openOrders = []*interfaces.Order{{BrokerAccountID: position.BrokerAccountID, PaperLive: position.PaperLive, TenantID: position.TenantID, SandboxID: position.SandboxID, Symbol: "XOM", Status: "accepted_for_bidding"}}
			}
			pm.ReconcilePersistedPositions(context.Background())
			if position.Status != "PROTECTION_BLOCKED" || broker.calls != 0 || broker.cancelCalls != 0 {
				t.Fatalf("unsafe recovery changed state or mutated broker: status=%s place=%d cancel=%d", position.Status, broker.calls, broker.cancelCalls)
			}
		})
	}
}
