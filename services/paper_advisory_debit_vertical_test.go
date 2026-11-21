package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C (Hermes C10): the planned offline integration gate for a debit vertical on the PAPER_ADVISORY_OP2 path. It feeds
// FROZEN AlphaDesk-produced receipt bytes (the Phase A/B managed goldens: a bull call debit AAPL 200/205, one unit, net debit
// 1.10, captured from AD's real FastAPI app with a frozen clock) through the real order service with the real TradingPolicy,
// the real durable group store, the entry spread cap with its confirmed revision and the dispatch lease. A valid exact two-leg
// debit produces exactly one mock broker request; a modified receipt, leg, price, cap revision or expired evidence produces
// none. No live AlphaDesk or broker call is made.

var debitFrozenNow = time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)

const (
	debitClientID = "baseline-bull_call_debit_spread"
	debitLow      = "AAPL261106C00200000"
	debitHigh     = "AAPL261106C00205000"
)

type debitHarness struct {
	service     *AlpacaTradingService
	storage     *database.LocalStorage
	order       func() *interfaces.OptionsOrder
	brokerCalls *[]alpaca.PlaceOrderRequest
	adCalls     *int
}

func goldenBytes(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// newDebitHarness builds the service. mutateReceipt may alter the receipt bytes AD returns; now is the clock AD evidence is judged by.
func newDebitHarness(t *testing.T, now time.Time, mutateReceipt func(doc map[string]any)) *debitHarness {
	t.Helper()
	t.Setenv("ALPACA_ACCOUNT_ID", "fixture")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "fixture")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "fixture")
	oldPolicyNow := PolicyNow
	PolicyNow = func() time.Time { return debitFrozenNow }
	t.Cleanup(func() { PolicyNow = oldPolicyNow })

	receipt := goldenBytes(t, "ad-debit-vertical-managed-receipt.json")
	if mutateReceipt != nil {
		var doc map[string]any
		if err := json.Unmarshal(receipt, &doc); err != nil {
			t.Fatal(err)
		}
		mutateReceipt(doc)
		var err error
		if receipt, err = json.Marshal(doc); err != nil {
			t.Fatal(err)
		}
	}
	policyGet := goldenBytes(t, "ad-debit-vertical-managed-policy-get.json")
	adCalls := 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = w.Write(policyGet)
			return
		}
		adCalls++
		_, _ = w.Write(receipt)
	}))
	t.Cleanup(alpha.Close)
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account":
			_, _ = w.Write([]byte(`{"id":"fixture","equity":"100000","last_equity":"100000","cash":"100000","portfolio_value":"100000","buying_power":"100000","daytrade_count":0}`))
		case "/v2/positions":
			_, _ = w.Write([]byte(`[]`))
		case "/v2/orders":
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(broker.Close)

	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "debit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { storage.Close() })

	var requests []alpaca.PlaceOrderRequest
	policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, RequireConfirmation: false, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100, AllowedStructures: "bull_call_debit,long_call,long_put"}
	s := &AlpacaTradingService{
		client: alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}), logger: logrus.New(),
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, policy: policy,
		expectedAccountID: "fixture", expectedPaper: true, expectedTenantID: "fixture", expectedSandboxID: "fixture",
		localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
		alphaDesk: &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, ExecutionMode: "PAPER_ADVISORY_OP2", RequireManagedApprovalGate: true,
			URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return now }},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			requests = append(requests, req)
			legs := make([]alpaca.Order, len(req.Legs))
			for i := range req.Legs {
				ratio := req.Legs[i].RatioQty
				legs[i] = alpaca.Order{Symbol: req.Legs[i].Symbol, Side: req.Legs[i].Side, PositionIntent: req.Legs[i].PositionIntent, RatioQty: &ratio}
			}
			return &alpaca.Order{ID: "paper-order", ClientOrderID: req.ClientOrderID, OrderClass: alpaca.MLeg, Type: req.Type, TimeInForce: req.TimeInForce, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted", Legs: legs}, nil
		},
	}
	s.SetSubmissionMarker(func(string) error { return nil })
	s.SetManagedExecutionBlockCheck(func() bool { return false })
	s.SetOpeningReservationLock(filepath.Join(t.TempDir(), "reservation.lock"))
	if err := s.SetOptionSpreadCapPct(10); err != nil { // the golden's worst leg is exactly 10%, which the cap admits
		t.Fatal(err)
	}
	s.SetOptionGroupProvider(func(_ context.Context, exclude string) ([]OptionGroupRisk, error) {
		states, err := storage.OptionGroupStatesExcluding(exclude)
		if err != nil {
			return nil, err
		}
		return OptionGroupRisksFromStates(states)
	})

	h := &debitHarness{service: s, storage: storage, brokerCalls: &requests, adCalls: &adCalls}
	h.order = func() *interfaces.OptionsOrder {
		price := 1.10
		revision := s.OptionSpreadCapRevision()
		return &interfaces.OptionsOrder{ClientOrderID: debitClientID, Symbol: debitLow, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day",
			LimitPrice: &price, PriceKind: PriceKindDebit, CapRevision: &revision,
			Legs:                []interfaces.OptionLeg{{Symbol: debitLow, Side: "buy", RatioQty: 1, PositionIntent: "buy_to_open", Price: 2.0}, {Symbol: debitHigh, Side: "sell", RatioQty: 1, PositionIntent: "sell_to_open", Price: 1.0}},
			AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { return nil }}
	}
	return h
}

func (h *debitHarness) register(t *testing.T, order *interfaces.OptionsOrder) {
	t.Helper()
	// What the controller does before submission: the exact legs are recorded on the durable group ledger.
	structure, err := ClassifyOptionsStructure(order)
	if err != nil {
		t.Fatal(err)
	}
	legs, _ := EncodeGroupLegs(order.Legs)
	group := &models.DBOptionGroup{GroupID: order.ClientOrderID, Underlying: "AAPL", Structure: structure, Status: "pending_entry", LegsJSON: legs, EntryClientOrderID: order.ClientOrderID, EntryUnits: order.Qty, NetDebit: *order.LimitPrice}
	if err := h.storage.SaveOptionGroup(group); err != nil {
		t.Fatal(err)
	}
}

func TestFrozenADDebitReceiptReachesTheBrokerOnceThroughTheRealBoundary(t *testing.T) {
	h := newDebitHarness(t, debitFrozenNow, nil)
	order := h.order()
	h.register(t, order)
	result, err := h.service.PlaceOptionsOrder(context.Background(), order)
	if err != nil {
		t.Fatalf("the exact frozen AD debit receipt must be accepted through the real boundary: %v", err)
	}
	if len(*h.brokerCalls) != 1 || *h.adCalls != 1 {
		t.Fatalf("exactly one broker request and one AD assessment are expected: broker=%d ad=%d", len(*h.brokerCalls), *h.adCalls)
	}
	req := (*h.brokerCalls)[0]
	if req.OrderClass != alpaca.MLeg || len(req.Legs) != 2 || req.Symbol != "" || req.Side != "" || req.PositionIntent != "" {
		t.Fatalf("the request must be one atomic mleg order with an empty parent: %+v", req)
	}
	if req.LimitPrice == nil || req.LimitPrice.String() != "1.1" || req.Qty == nil || req.Qty.String() != "1" || req.ClientOrderID != debitClientID {
		t.Fatalf("net debit, units and identity must be exact: limit=%v qty=%v id=%q", req.LimitPrice, req.Qty, req.ClientOrderID)
	}
	if req.Legs[0].Symbol != debitLow || req.Legs[0].Side != alpaca.Buy || req.Legs[1].Symbol != debitHigh || req.Legs[1].Side != alpaca.Sell {
		t.Fatalf("legs must be exactly the submitted legs: %+v", req.Legs)
	}
	if result == nil || result.Status != "accepted" || result.ClientOrderID != debitClientID {
		t.Fatalf("result = %+v", result)
	}
	if states, _ := h.storage.OptionGroupStates(); len(states) != 1 || states[0].Group.GroupID != debitClientID {
		t.Fatalf("the group must be on the durable ledger before and after the order: %+v", states)
	}
}

func TestADDebitReceiptMutationsNeverReachTheBroker(t *testing.T) {
	cases := map[string]struct {
		now     time.Time
		receipt func(doc map[string]any)
		order   func(o *interfaces.OptionsOrder)
	}{
		"receipt fingerprint altered": {now: debitFrozenNow, receipt: func(d map[string]any) { d["trade_fingerprint"] = strings.Repeat("0", 64) }},
		"receipt echoes another leg": {now: debitFrozenNow, receipt: func(d map[string]any) {
			d["trade"].(map[string]any)["legs"].([]any)[1].(map[string]any)["symbol"] = "AAPL261106C00210000"
		}},
		"receipt net price altered": {now: debitFrozenNow, receipt: func(d map[string]any) { d["trade"].(map[string]any)["limit_price"] = "1.20" }},
		"receipt decision not pass": {now: debitFrozenNow, receipt: func(d map[string]any) { d["decision"] = "FAIL" }},
		"order leg differs":         {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { o.Legs[1].Symbol = "AAPL261106C00210000" }},
		"order net price differs":   {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { p := 1.20; o.LimitPrice = &p }},
		"order units differ":        {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { o.Qty = 2 }},
		"cap revision is stale":     {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { r := *o.CapRevision + 1; o.CapRevision = &r }},
		"cap revision missing":      {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { o.CapRevision = nil }},
		"evidence expired":          {now: debitFrozenNow.Add(10 * time.Minute)},
		"structure not allowed":     {now: debitFrozenNow, order: func(o *interfaces.OptionsOrder) { o.Legs[0], o.Legs[1] = o.Legs[1], o.Legs[0] }},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := newDebitHarness(t, tc.now, tc.receipt)
			order := h.order()
			if tc.order != nil {
				tc.order(order)
			}
			if structure, err := ClassifyOptionsStructure(order); err == nil {
				legs, _ := EncodeGroupLegs(order.Legs)
				_ = h.storage.SaveOptionGroup(&models.DBOptionGroup{GroupID: order.ClientOrderID, Underlying: "AAPL", Structure: structure, Status: "pending_entry", LegsJSON: legs, EntryClientOrderID: order.ClientOrderID, EntryUnits: order.Qty, NetDebit: *order.LimitPrice})
			}
			if _, err := h.service.PlaceOptionsOrder(context.Background(), order); err == nil {
				t.Fatal("a modified receipt, order, cap revision or expired evidence must be refused")
			}
			if len(*h.brokerCalls) != 0 {
				t.Fatalf("a refused order must produce zero broker requests, got %d", len(*h.brokerCalls))
			}
		})
	}
}

func TestADDebitVerticalIsRefusedWhenThePermissionIsOff(t *testing.T) {
	h := newDebitHarness(t, debitFrozenNow, nil)
	h.service.policy.AllowedStructures = "" // the default: single long legs only
	order := h.order()
	h.register(t, order)
	if _, err := h.service.PlaceOptionsOrder(context.Background(), order); err == nil || !strings.Contains(err.Error(), "not allowed for this sandbox") {
		t.Fatalf("a spread with the permission off must be refused before AlphaDesk or the broker, got %v", err)
	}
	if len(*h.brokerCalls) != 0 || *h.adCalls != 0 {
		t.Fatalf("nothing may be sent: broker=%d ad=%d", len(*h.brokerCalls), *h.adCalls)
	}
}
