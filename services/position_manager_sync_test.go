package services

import (
	"context"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"runtime"
	"testing"
)

type syncRegressionBroker struct{ exitOrderRecorder }

func (r *syncRegressionBroker) GetOrderByClientOrderID(ctx context.Context, id string) (*interfaces.Order, error) {
	for _, o := range r.brokerOrders {
		if o.ClientOrderID == id {
			return o, nil
		}
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
