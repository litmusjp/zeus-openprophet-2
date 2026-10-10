package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type reconciliationTradingService struct {
	orders map[string]*interfaces.Order
	err    error
}

type visibleOrdersStorage struct {
	orders []*interfaces.Order
}

func (s *visibleOrdersStorage) SaveBars([]*interfaces.Bar) error { return nil }
func (s *visibleOrdersStorage) GetBars(string, time.Time, time.Time) ([]*interfaces.Bar, error) {
	return nil, nil
}
func (s *visibleOrdersStorage) SaveOrder(order *interfaces.Order) error {
	s.orders = append(s.orders, order)
	return nil
}
func (s *visibleOrdersStorage) GetOrder(string) (*interfaces.Order, error) { return nil, nil }
func (s *visibleOrdersStorage) GetOrderByClientOrderID(string) (*interfaces.Order, error) {
	return nil, nil
}
func (s *visibleOrdersStorage) GetOrders(string) ([]*interfaces.Order, error) { return s.orders, nil }
func (s *visibleOrdersStorage) GetOrdersNeedingReconciliation() ([]*interfaces.Order, error) {
	return nil, nil
}
func (s *visibleOrdersStorage) CleanupOldData(time.Time) error { return nil }

type visibleOrdersTradingService struct {
	*reconciliationTradingService
	brokerOrders []*interfaces.Order
	listErr      error
	listStatuses []string
	lookups      map[string]*interfaces.Order
	lookupErr    error
}

func (s *visibleOrdersTradingService) ListOrders(_ context.Context, status string) ([]*interfaces.Order, error) {
	s.listStatuses = append(s.listStatuses, status)
	return s.brokerOrders, s.listErr
}

func (s *visibleOrdersTradingService) GetOrderByClientOrderID(_ context.Context, id string) (*interfaces.Order, error) {
	if s.lookupErr != nil {
		return nil, s.lookupErr
	}
	return s.lookups[id], nil
}

func TestGetOrdersUsesSafeBrokerStatusAndPreservesCompleteness(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     string
		brokerErr  error
		wantStatus string
		wantCount  int
		wantFull   bool
	}{
		{name: "planned intent", status: "planned_for_next_session", wantStatus: "all", wantCount: 1, wantFull: true},
		{name: "submit failed", status: "submit_failed", wantStatus: "all", wantCount: 1, wantFull: true},
		{name: "broker failure", status: "planned_for_next_session", brokerErr: errors.New("broker unavailable"), wantStatus: "all", wantCount: 1, wantFull: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			local := &interfaces.Order{ClientOrderID: "local-1", Symbol: "AAPL", Status: tc.status, SubmittedAt: time.Now()}
			storage := &visibleOrdersStorage{orders: []*interfaces.Order{local}}
			trading := &visibleOrdersTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				brokerOrders:                 []*interfaces.Order{{ClientOrderID: "broker-1", Symbol: "MSFT", Status: "accepted", SubmittedAt: time.Now()}},
				listErr:                      tc.brokerErr,
			}
			controller := NewOrderController(trading, nil, storage)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status="+tc.status, nil)
			controller.HandleGetOrders(ctx)

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
			}
			var response struct {
				Orders   []*interfaces.Order `json:"orders"`
				Complete bool                `json:"complete"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(trading.listStatuses) != 1 || trading.listStatuses[0] != tc.wantStatus {
				t.Fatalf("broker statuses = %#v, want [%q]", trading.listStatuses, tc.wantStatus)
			}
			if len(response.Orders) != tc.wantCount || response.Orders[0].Status != tc.status {
				t.Fatalf("orders = %#v, want one local %q record", response.Orders, tc.status)
			}
			if response.Complete != tc.wantFull {
				t.Fatalf("complete = %v, want %v", response.Complete, tc.wantFull)
			}
		})
	}
}

func TestGetOrdersActiveAndOpenIncludeWorkingBrokerOrdersOnly(t *testing.T) {
	for _, filter := range []string{"active", "open"} {
		for _, status := range []string{"new", "accepted", "pending_new", "partially_filled", "pending_replace", "pending_cancel", "filled", "canceled", "planned_for_next_session", "submission_uncertain"} {
			t.Run(filter+"/"+status, func(t *testing.T) {
				trading := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, brokerOrders: []*interfaces.Order{{ID: "broker-1", ClientOrderID: "broker-1", Status: status}}}
				controller := NewOrderController(trading, nil, &visibleOrdersStorage{orders: []*interfaces.Order{{ClientOrderID: "plan-1", Status: "planned_for_next_session"}}})
				recorder := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(recorder)
				ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status="+filter, nil)
				controller.HandleGetOrders(ctx)
				var response struct {
					Orders   []*interfaces.Order `json:"orders"`
					Complete bool                `json:"complete"`
				}
				if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				want := status == "new" || status == "accepted" || status == "pending_new" || status == "partially_filled" || status == "pending_replace" || status == "pending_cancel"
				if len(response.Orders) != map[bool]int{true: 1, false: 0}[want] || !response.Complete {
					t.Fatalf("filter=%s status=%s response=%s", filter, status, recorder.Body.String())
				}
				if len(trading.listStatuses) != 1 || trading.listStatuses[0] != "open" {
					t.Fatalf("broker filter: %v", trading.listStatuses)
				}
			})
		}
	}
}

func TestActiveAndOpenResolveStaleLocalWorkingOrders(t *testing.T) {
	for _, filter := range []string{"active", "open"} {
		t.Run(filter, func(t *testing.T) {
			local := []*interfaces.Order{
				{ID: "filled-id", ClientOrderID: "stale-filled", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "pending_new", SubmissionAttempted: true},
				{ID: "cancel-id", ClientOrderID: "stale-cancel", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "new", SubmissionAttempted: true},
				{ID: "genuine-id", ClientOrderID: "genuine", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Status: "accepted"},
			}
			avgFill := 210.25
			trading := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, lookups: map[string]*interfaces.Order{
				"stale-filled": {ID: "filled-id", ClientOrderID: "stale-filled", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "filled", FilledQty: 1, FilledAvgPrice: &avgFill},
				"stale-cancel": {ID: "cancel-id", ClientOrderID: "stale-cancel", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "canceled"},
			}, brokerOrders: []*interfaces.Order{{ID: "genuine-id", ClientOrderID: "genuine", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Status: "accepted"}}}
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status="+filter, nil)
			NewOrderController(trading, nil, &visibleOrdersStorage{orders: local}).HandleGetOrders(ctx)
			var response struct {
				Orders   []*interfaces.Order `json:"orders"`
				Complete bool                `json:"complete"`
			}
			_ = json.Unmarshal(recorder.Body.Bytes(), &response)
			if !response.Complete || len(response.Orders) != 1 || response.Orders[0].ClientOrderID != "genuine" {
				t.Fatalf("unexpected response %s", recorder.Body.String())
			}
		})
	}
}

func TestExactLookupRequiresValidTerminalEvidence(t *testing.T) {
	avg := 210.25
	for _, tc := range []struct {
		name string
		edit func(*interfaces.Order)
	}{
		{"unknown status", func(o *interfaces.Order) { o.Status = "mystery" }},
		{"uncertain status", func(o *interfaces.Order) { o.Status = "submission_uncertain" }},
		{"invalid filled quantity", func(o *interfaces.Order) { o.FilledQty = 2; o.FilledAvgPrice = &avg }},
		{"missing average price", func(o *interfaces.Order) { o.FilledQty = 1; o.FilledAvgPrice = nil }},
		{"broker ID mismatch", func(o *interfaces.Order) { o.ID = "other" }},
		{"account mismatch", func(o *interfaces.Order) { o.BrokerAccountID = "other" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			local := &interfaces.Order{ID: "exit", ClientOrderID: "client-exit", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "pending_new", Purpose: "close", BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
			broker := *local
			broker.Status, broker.FilledQty, broker.FilledAvgPrice = "filled", 1, &avg
			tc.edit(&broker)
			trading := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, lookups: map[string]*interfaces.Order{"client-exit": &broker}}
			storage := &visibleOrdersStorage{orders: []*interfaces.Order{local}}
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status=active", nil)
			NewOrderController(trading, nil, storage).HandleGetOrders(ctx)
			var response struct {
				Orders   []*interfaces.Order `json:"orders"`
				Complete bool                `json:"complete"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &response)
			if response.Complete || len(response.Orders) != 1 || response.Orders[0].Status != "pending_new" || len(storage.orders) != 1 {
				t.Fatalf("invalid exact evidence not retained: %s", rec.Body.String())
			}
		})
	}
}

func TestStockTerminalProjectionWithoutPurposeResolvesStaleLocalExit(t *testing.T) {
	avg := 281.85
	local := &interfaces.Order{ID: "exit", ClientOrderID: "client-exit", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "pending_new", Purpose: "close", BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	broker := *local
	broker.Purpose, broker.Status, broker.FilledQty, broker.FilledAvgPrice = "", "filled", 1, &avg
	service := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, lookups: map[string]*interfaces.Order{"client-exit": &broker}}
	storage := &visibleOrdersStorage{orders: []*interfaces.Order{local}}
	for _, filter := range []string{"active", "open"} {
		rec := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(rec)
		ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status="+filter, nil)
		NewOrderController(service, nil, storage).HandleGetOrders(ctx)
		var response struct {
			Orders   []*interfaces.Order `json:"orders"`
			Complete bool                `json:"complete"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &response)
		if !response.Complete || len(response.Orders) != 0 {
			t.Fatalf("valid stock terminal projection was not accepted for %s: %s", filter, rec.Body.String())
		}
	}
}

func TestActiveProtectionStopAllowsBrokerClosePurposeWithoutWeakeningIdentity(t *testing.T) {
	local := &interfaces.Order{ID: "stop-id", ClientOrderID: "stop-client", Symbol: "XOM", Qty: 40, Side: "sell", Type: "stop", TimeInForce: "gtc", StopPrice: floatPtr(165), Status: "pending_cancel", Purpose: "protection", BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	working := *local
	working.Status, working.Purpose, working.PositionIntent = "accepted", "close", "sell_to_close"
	conflict := working
	conflict.Qty = 39
	for _, tc := range []struct {
		name         string
		broker       *interfaces.Order
		wantCount    int
		wantComplete bool
	}{
		{name: "working protection is broker authoritative", broker: &working, wantCount: 1, wantComplete: true},
		{name: "terminal canceled protection is removed", broker: func() *interfaces.Order { o := working; o.Status = "canceled"; return &o }(), wantCount: 0, wantComplete: true},
		{name: "conflicting quantity remains unresolved", broker: &conflict, wantCount: 1, wantComplete: false},
		{name: "missing close intent remains unresolved", broker: func() *interfaces.Order { o := working; o.PositionIntent = ""; return &o }(), wantCount: 1, wantComplete: false},
		{name: "wrong open intent remains unresolved", broker: func() *interfaces.Order { o := working; o.PositionIntent = "sell_to_open"; return &o }(), wantCount: 1, wantComplete: false},
		{name: "wrong account remains unresolved", broker: func() *interfaces.Order { o := working; o.BrokerAccountID = "other"; return &o }(), wantCount: 1, wantComplete: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, brokerOrders: []*interfaces.Order{tc.broker}}
			if tc.broker.Status == "canceled" {
				service.lookups = map[string]*interfaces.Order{local.ClientOrderID: tc.broker}
			}
			storage := &visibleOrdersStorage{orders: []*interfaces.Order{local}}
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status=active", nil)
			NewOrderController(service, nil, storage).HandleGetOrders(ctx)
			var response struct {
				Orders   []*interfaces.Order `json:"orders"`
				Complete bool                `json:"complete"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Orders) != tc.wantCount || response.Complete != tc.wantComplete {
				t.Fatalf("response = %s, want count %d complete %v", rec.Body.String(), tc.wantCount, tc.wantComplete)
			}
		})
	}
}

func TestDurableOrderIdentityRequiresSideMatchingExplicitCloseIntent(t *testing.T) {
	for _, tc := range []struct {
		side, intent string
		want         bool
	}{
		{"sell", "sell_to_close", true}, {"sell", "buy_to_close", false}, {"sell", "sell_to_open", false}, {"sell", "", false},
		{"buy", "buy_to_close", true}, {"buy", "sell_to_close", false}, {"buy", "buy_to_open", false}, {"buy", "", false},
	} {
		local := &interfaces.Order{ID: "stop", ClientOrderID: "stop-client", Symbol: "XOM", Qty: 2, Side: tc.side, Type: "stop", TimeInForce: "gtc", Purpose: "protection", BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
		broker := *local
		broker.Purpose, broker.Status, broker.PositionIntent = "close", "accepted", tc.intent
		if got := durableOrderIdentityMatches(local, &broker); got != tc.want {
			t.Errorf("side=%s intent=%q matched=%v, want %v", tc.side, tc.intent, got, tc.want)
		}
		broker.BrokerAccountID = "other"
		if durableOrderIdentityMatches(local, &broker) {
			t.Errorf("cross-account side=%s intent=%q was accepted", tc.side, tc.intent)
		}
	}
}

func TestActiveRetainsUncertainLocalWorkingOrders(t *testing.T) {
	for _, mode := range []string{"lookup failure", "identity mismatch"} {
		t.Run(mode, func(t *testing.T) {
			local := &interfaces.Order{ID: "expected", ClientOrderID: "uncertain", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "pending_new", BrokerAccountID: "acct", PaperLive: "paper", SandboxID: "sandbox"}
			broker := &interfaces.Order{ID: "expected", ClientOrderID: "uncertain", Symbol: "IWM", Qty: 1, Side: "sell", Type: "market", TimeInForce: "day", Status: "filled", FilledQty: 1, BrokerAccountID: "acct", PaperLive: "paper", SandboxID: "sandbox"}
			trading := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, lookups: map[string]*interfaces.Order{"uncertain": broker}}
			if mode == "lookup failure" {
				trading.lookupErr = errors.New("temporary failure")
			} else {
				broker.BrokerAccountID = "other"
			}
			storage := &visibleOrdersStorage{orders: []*interfaces.Order{local}}
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status=active", nil)
			NewOrderController(trading, nil, storage).HandleGetOrders(ctx)
			var response struct {
				Orders      []*interfaces.Order `json:"orders"`
				Complete    bool                `json:"complete"`
				BrokerState string              `json:"broker_state"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &response)
			if response.Complete || response.BrokerState != "available" || len(response.Orders) != 1 || response.Orders[0].Status != "pending_new" || len(storage.orders) != 1 {
				t.Fatalf("uncertain row not retained read-only: %s", rec.Body.String())
			}
		})
	}
}

func TestGetOrdersActiveIsSandboxScopedAndIncompleteWhenBrokerUnavailable(t *testing.T) {
	for _, sandbox := range []string{"l1", "l2"} {
		t.Run(sandbox, func(t *testing.T) {
			trading := &visibleOrdersTradingService{reconciliationTradingService: &reconciliationTradingService{}, brokerOrders: []*interfaces.Order{{ClientOrderID: sandbox + "-stop", Status: "new"}}}
			if sandbox == "l2" {
				trading.listErr = errors.New("broker unavailable")
			}
			controller := NewOrderController(trading, nil, &visibleOrdersStorage{orders: []*interfaces.Order{{ClientOrderID: sandbox + "-local", Status: "accepted"}, {ClientOrderID: sandbox + "-plan", Status: "planned_for_next_session"}, {ClientOrderID: sandbox + "-uncertain", Status: "submission_uncertain"}}})
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/orders?status=active", nil)
			controller.HandleGetOrders(ctx)
			var response struct {
				Orders   []*interfaces.Order `json:"orders"`
				Complete bool                `json:"complete"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			want := 2
			if sandbox == "l2" {
				want = 1
			}
			if len(response.Orders) != want || response.Complete {
				t.Fatalf("sandbox=%s body=%s", sandbox, recorder.Body.String())
			}
			for _, order := range response.Orders {
				if !strings.HasPrefix(order.ClientOrderID, sandbox+"-") {
					t.Fatalf("cross-sandbox order: %#v", order)
				}
			}
		})
	}
}

func TestGetAccountFailsClosedWhenBrokerServiceIsUnavailable(t *testing.T) {
	oc := NewOrderController(nil, nil, nil)
	if _, err := oc.GetAccount(); err == nil {
		t.Fatal("expected inert mode account read to fail closed")
	}
}

func TestInertReadRoutesFailClosedWithoutBrokerOrMarketData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := NewOrderController(nil, nil, nil)
	tests := []struct {
		name    string
		path    string
		handler func(*gin.Context)
	}{
		{"positions", "/positions", oc.HandleGetPositions},
		{"account", "/account", oc.HandleGetAccount},
		{"orders", "/orders", oc.HandleGetOrders},
		{"clock", "/clock", oc.HandleGetMarketClock},
		{"quote", "/market/quote/AAPL", oc.HandleGetQuote},
		{"bar", "/market/bar/AAPL", oc.HandleGetBar},
		{"bars", "/market/bars/AAPL", oc.HandleGetBars},
		{"options positions", "/options/positions", oc.ListOptionsPositions},
		{"options position", "/options/position/AAPL", oc.GetOptionsPosition},
		{"options chain", "/options/chain/AAPL", oc.GetOptionsChain},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = req
			if tc.name == "quote" || tc.name == "bar" || tc.name == "bars" || tc.name == "options position" || tc.name == "options chain" {
				ctx.Params = gin.Params{{Key: "symbol", Value: "AAPL"}}
			}
			tc.handler(ctx)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
			}
		})
	}
}

func (s *reconciliationTradingService) PlaceOrder(context.Context, *interfaces.Order) (*interfaces.OrderResult, error) {
	return nil, nil
}

func (s *reconciliationTradingService) CancelOrder(context.Context, string) error {
	return nil
}

func (s *reconciliationTradingService) GetOrder(context.Context, string) (*interfaces.Order, error) {
	return nil, nil
}

func (s *reconciliationTradingService) GetOrderByClientOrderID(_ context.Context, clientOrderID string) (*interfaces.Order, error) {
	if clientOrderID == "op-error" {
		return nil, s.err
	}
	return s.orders[clientOrderID], nil
}

func (s *reconciliationTradingService) ListOrders(context.Context, string) ([]*interfaces.Order, error) {
	return nil, nil
}

func (s *reconciliationTradingService) GetPositions(context.Context) ([]*interfaces.Position, error) {
	return nil, nil
}

func (*reconciliationTradingService) GetAccount(context.Context) (*interfaces.Account, error) {
	return nil, nil
}

func (s *reconciliationTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	return nil, nil
}

func (s *reconciliationTradingService) GetOptionsChain(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
	return nil, nil
}

func (s *reconciliationTradingService) GetOptionsQuote(context.Context, string) (*interfaces.OptionsQuote, error) {
	return nil, nil
}

func (s *reconciliationTradingService) GetOptionsPosition(context.Context, string) (*interfaces.OptionsPosition, error) {
	return nil, nil
}

func (s *reconciliationTradingService) ListOptionsPositions(context.Context) ([]*interfaces.OptionsPosition, error) {
	return nil, nil
}

func TestReconcileOpenOrdersOnlyUpdatesConfirmedOrders(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()

	for _, order := range []*interfaces.Order{
		{ClientOrderID: "op-confirmed", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Status: "pending"},
		{ClientOrderID: "op-error", Symbol: "MSFT", Status: "submit_failed", SubmissionAttempted: true},
	} {
		if err := storage.SaveOrder(order); err != nil {
			t.Fatalf("SaveOrder(%q) error = %v", order.ClientOrderID, err)
		}
	}

	trading := &reconciliationTradingService{
		orders: map[string]*interfaces.Order{
			"op-confirmed": {
				ID:             "broker-confirmed",
				ClientOrderID:  "op-confirmed",
				Symbol:         "AAPL",
				Qty:            1,
				Side:           "buy",
				Type:           "market",
				TimeInForce:    "day",
				Status:         "filled",
				FilledQty:      1,
				FilledAvgPrice: floatPtr(123.45),
			},
		},
		err: errors.New("broker lookup failed"),
	}
	controller := NewOrderController(trading, nil, storage)

	reconciled, skipped := controller.ReconcileOpenOrders(context.Background())
	if reconciled != 1 || skipped != 1 {
		t.Fatalf("ReconcileOpenOrders() = (%d, %d), want (1, 1)", reconciled, skipped)
	}

	confirmed, err := storage.GetOrder("broker-confirmed")
	if err != nil {
		t.Fatalf("GetOrder(confirmed) error = %v", err)
	}
	if confirmed.Status != "filled" || confirmed.FilledQty != 1 || confirmed.FilledAvgPrice == nil || *confirmed.FilledAvgPrice != 123.45 {
		t.Fatalf("confirmed order = %#v, want broker state", confirmed)
	}

	pending, err := storage.GetOrdersNeedingReconciliation()
	if err != nil {
		t.Fatalf("GetOrdersNeedingReconciliation() error = %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("orders needing later reconciliation = %#v, want only failed lookup", pending)
	}
	seen := map[string]string{}
	for _, order := range pending {
		seen[order.ClientOrderID] = order.Status
	}
	if seen["op-error"] != "submit_failed" {
		t.Fatalf("orders needing later reconciliation = %#v, want op-error submit_failed", seen)
	}
}

func floatPtr(value float64) *float64 {
	return &value
}

// placeOrderRecorder captures the order handed to PlaceOrder and lets the test drive the
// broker result/error. Embeds reconciliationTradingService to satisfy the rest of the interface.
type placeOrderRecorder struct {
	*reconciliationTradingService
	placed   *interfaces.Order
	result   *interfaces.OrderResult
	placeErr error
}

type closedSessionTradingService struct {
	*reconciliationTradingService
	nextOpen              time.Time
	brokerSubmissionCalls int
}

func (s *closedSessionTradingService) PlaceOrder(context.Context, *interfaces.Order) (*interfaces.OrderResult, error) {
	// The broker clock check rejects the order before the actual submission
	// function is reached.
	return nil, &services.MarketClosedError{NextOpen: s.nextOpen}
}

func TestClosedSessionBuyAndSellArePlannedWithAcceptedHTTPResponse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		side    string
		handler func(*OrderController, *gin.Context)
	}{
		{name: "buy", side: "buy", handler: (*OrderController).HandleBuy},
		{name: "sell", side: "sell", handler: (*OrderController).HandleSell},
	} {
		t.Run(tc.name, func(t *testing.T) {
			storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()

			nextOpen := time.Now().Add(2 * time.Hour).Truncate(time.Second)
			trading := &closedSessionTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				nextOpen:                     nextOpen,
			}
			controller := NewOrderController(trading, nil, storage)
			clientOrderID := "equity-closed-" + tc.side
			body := []byte(`{"symbol":"AAPL","qty":1,"type":"limit","limit_price":100,"client_order_id":"` + clientOrderID + `"}`)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/orders/"+tc.side, bytes.NewReader(body))
			ctx.Request.Header.Set("Content-Type", "application/json")

			tc.handler(controller, ctx)

			if recorder.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusAccepted, recorder.Body.String())
			}
			var response interfaces.OrderResult
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("response JSON error = %v; body=%s", err, recorder.Body.String())
			}
			if response.Status != "planned_for_next_session" || response.ClientOrderID != clientOrderID || response.NextEligibleAt == nil || !response.NextEligibleAt.Equal(nextOpen) {
				t.Fatalf("response = %#v, want planned status, stable client ID, and next eligible time", response)
			}
			expectedMessage := (&services.MarketClosedError{NextOpen: nextOpen}).Error()
			if response.Message != expectedMessage {
				t.Fatalf("response message = %q, want %q", response.Message, expectedMessage)
			}

			planned, err := storage.GetOrderByClientOrderID(clientOrderID)
			if err != nil {
				t.Fatal(err)
			}
			if planned == nil || planned.Status != "planned_for_next_session" || planned.ClientOrderID != clientOrderID || planned.NextEligibleAt == nil || !planned.NextEligibleAt.Equal(nextOpen) {
				t.Fatalf("durable intent = %#v, want planned lifecycle with stable identity and next eligible time", planned)
			}
			if trading.brokerSubmissionCalls != 0 {
				t.Fatalf("broker submission calls = %d, want 0", trading.brokerSubmissionCalls)
			}
		})
	}
}

func TestClosedSessionMarketOpeningWithoutBoundedPriceIsRejectedAndNotPlanned(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	nextOpen := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	trading := &closedSessionTradingService{reconciliationTradingService: &reconciliationTradingService{}, nextOpen: nextOpen}
	controller := NewOrderController(trading, nil, storage)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/orders/buy", strings.NewReader(`{"symbol":"AAPL","qty":1,"type":"market","client_order_id":"equity-closed-unbounded"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.HandleBuy(ctx)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s; want 409", recorder.Code, recorder.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "rejected_before_submission" || body["category"] != "risk_blocked" {
		t.Fatalf("body=%v; want structured risk rejection", body)
	}
	planned, err := storage.GetOrderByClientOrderID("equity-closed-unbounded")
	if err != nil {
		t.Fatal(err)
	}
	if planned != nil && planned.Status == "planned_for_next_session" {
		t.Fatalf("unbounded market intent was persisted as planned: %#v", planned)
	}
}

func TestHandleBuyReturnsStructuredConflictForPreSubmissionPolicyRejection(t *testing.T) {
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	trading := &placeOrderRecorder{
		reconciliationTradingService: &reconciliationTradingService{},
		placeErr:                     &services.PreSubmissionRejectionError{Err: errors.New("broker trading policy rejected order: max deployed percentage exceeded")},
	}
	controller := NewOrderController(trading, nil, storage)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/orders/buy", strings.NewReader(`{"symbol":"AAPL","qty":1,"type":"limit","limit_price":100,"client_order_id":"policy-rejected"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.HandleBuy(ctx)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s; want 409", recorder.Code, recorder.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "rejected_before_submission" || body["category"] != "risk_blocked" {
		t.Fatalf("body=%v; want structured pre-submission risk rejection", body)
	}
	saved, err := storage.GetOrderByClientOrderID("policy-rejected")
	if err != nil {
		t.Fatal(err)
	}
	if saved == nil || saved.SubmissionAttempted || saved.ID != "" || saved.Status != "rejected_before_submission" {
		t.Fatalf("saved order=%#v; want non-attempted failure with empty broker ID", saved)
	}
}

func (s *placeOrderRecorder) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placed = o
	if s.result == nil {
		return nil, s.placeErr
	}
	result := *s.result
	result.ClientOrderID = o.ClientOrderID
	result.Symbol = o.Symbol
	result.Qty = o.Qty
	result.Side = o.Side
	result.Type = o.Type
	result.TimeInForce = o.TimeInForce
	result.LimitPrice = o.LimitPrice
	result.StopPrice = o.StopPrice
	result.PositionIntent = o.PositionIntent
	result.Purpose = o.Purpose
	return &result, s.placeErr
}

func TestBuyPersistsIntentBeforeSubmit(t *testing.T) {
	// Case 1: broker submit FAILS. The intent must already be durably recorded (persist
	// before submit), marked submit_failed, and carry the ClientOrderID that reached the broker.
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "buy-fail.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()

	rec := &placeOrderRecorder{reconciliationTradingService: &reconciliationTradingService{}, placeErr: errors.New("broker timeout")}
	oc := NewOrderController(rec, nil, storage)

	if _, err := oc.Buy(context.Background(), BuyRequest{Symbol: "AAPL", Qty: 1, Type: "market", ClientOrderID: "buy-fail-1"}); err == nil {
		t.Fatal("Buy() expected an error when the broker submit fails")
	}
	if rec.placed == nil || rec.placed.ClientOrderID == "" {
		t.Fatalf("PlaceOrder should receive an order carrying a ClientOrderID, got %#v", rec.placed)
	}
	failed, err := storage.GetOrders("submit_failed")
	if err != nil {
		t.Fatalf("GetOrders(submit_failed) error = %v", err)
	}
	if len(failed) != 1 || failed[0].Symbol != "AAPL" || failed[0].ClientOrderID != rec.placed.ClientOrderID {
		t.Fatalf("expected 1 submit_failed intent persisted with the broker's client id, got %#v", failed)
	}

	// Case 2: broker submit SUCCEEDS. The pre-submit pending row upserts to the broker's
	// id/status on the same ClientOrderID — one row, not two.
	storage2, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "buy-ok.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage2.Close()

	rec2 := &placeOrderRecorder{reconciliationTradingService: &reconciliationTradingService{}, result: &interfaces.OrderResult{OrderID: "broker-1", Status: "accepted", BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"}}
	oc2 := NewOrderController(rec2, nil, storage2)

	res, err := oc2.Buy(context.Background(), BuyRequest{Symbol: "MSFT", Qty: 2, Type: "market", ClientOrderID: "buy-ok-1"})
	if err != nil {
		t.Fatalf("Buy() unexpected error = %v", err)
	}
	if res == nil || res.OrderID != "broker-1" {
		t.Fatalf("Buy() result = %#v, want broker-1", res)
	}
	saved, err := storage2.GetOrder("broker-1")
	if err != nil {
		t.Fatalf("GetOrder(broker-1) error = %v", err)
	}
	if saved.Status != "accepted" || saved.ClientOrderID == "" {
		t.Fatalf("saved order = %#v, want accepted status + a ClientOrderID", saved)
	}
	all, err := storage2.GetOrders("")
	if err != nil {
		t.Fatalf("GetOrders() error = %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("expected exactly 1 row after pre-submit + post-submit upsert, got %d", len(all))
	}
}

func TestBuyPersistsTypedBrokerRejectionAsTerminalAndDoesNotRetry(t *testing.T) {
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "rejected.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	rejection := &services.BrokerRejectionError{Err: errors.New("typed broker rejection")}
	rec := &placeOrderRecorder{reconciliationTradingService: &reconciliationTradingService{}, placeErr: rejection}
	oc := NewOrderController(rec, nil, storage)
	if _, err := oc.Buy(context.Background(), BuyRequest{Symbol: "IWM", Qty: 10, Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(280), ClientOrderID: "op-rejected"}); err == nil {
		t.Fatal("Buy() expected the broker rejection")
	}
	saved, err := storage.GetOrderByClientOrderID("op-rejected")
	if err != nil {
		t.Fatal(err)
	}
	if saved == nil || saved.Status != "rejected" || !saved.SubmissionAttempted {
		t.Fatalf("saved=%#v; want terminal rejected identity", saved)
	}
	if _, err := oc.Buy(context.Background(), BuyRequest{Symbol: "IWM", Qty: 10, Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(280), ClientOrderID: "op-rejected"}); err == nil {
		t.Fatal("terminal rejected client order ID must not be reposted")
	}
}

func TestSellRetryReloadsPlannedIntentRevision(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "sell-retry.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	nextOpen := time.Now().Add(time.Hour)
	intent := &interfaces.Order{ClientOrderID: "sell-retry", Symbol: "AAPL", Qty: 2, Side: "sell", Type: "market", TimeInForce: "day", Status: "pending", Purpose: "close"}
	if err := storage.SaveOrder(intent); err != nil {
		t.Fatal(err)
	}
	intent.Status, intent.NextEligibleAt, intent.ExpiresAt = "planned_for_next_session", &nextOpen, func() *time.Time { v := nextOpen.Add(time.Hour); return &v }()
	if err := storage.SaveOrder(intent); err != nil {
		t.Fatal(err)
	}
	persistedBefore, err := storage.GetOrderByClientOrderID(intent.ClientOrderID)
	if err != nil || persistedBefore.Revision <= 1 || persistedBefore.Status != "planned_for_next_session" {
		t.Fatalf("planned intent = %#v, err=%v; want non-zero retry revision and planned lifecycle", persistedBefore, err)
	}

	rec := &placeOrderRecorder{reconciliationTradingService: &reconciliationTradingService{}, placeErr: &services.MarketClosedError{NextOpen: nextOpen}}
	oc := NewOrderController(rec, nil, storage)
	result, err := oc.Sell(context.Background(), SellRequest{Symbol: "AAPL", Qty: 2, Type: "market", ClientOrderID: intent.ClientOrderID})
	if err != nil {
		t.Fatalf("Sell() unexpected closed-session error: %v", err)
	}
	if result == nil || result.Status != "planned_for_next_session" || result.ClientOrderID != intent.ClientOrderID || result.NextEligibleAt == nil || !result.NextEligibleAt.Equal(nextOpen) {
		t.Fatalf("Sell() result = %#v, want planned lifecycle response", result)
	}
	after, err := storage.GetOrderByClientOrderID(intent.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision <= persistedBefore.Revision || after.Status != "planned_for_next_session" {
		t.Fatalf("retry lifecycle = %#v; want monotonic revision and planned status without stale CAS", after)
	}
	if rec.placed == nil || rec.placed.Revision <= persistedBefore.Revision {
		t.Fatalf("submitted retry = %#v; want persisted server revision to advance", rec.placed)
	}
}
