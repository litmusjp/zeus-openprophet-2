package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

type fakeMarketClock struct {
	clock *alpaca.Clock
	err   error
}

func readyAssessmentOrder(order *interfaces.OptionsOrder) *interfaces.OptionsOrder {
	quoted := time.Now().Add(-time.Second)
	delta, gamma, theta, vega := 0.5, 0.1, -0.2, 0.3
	order.AssessmentLegs = []interfaces.AlphaDeskAssessmentLeg{{Symbol: order.Symbol, Side: order.Side, Quantity: 1, Price: *order.LimitPrice, Bid: 0.9, Ask: 1.1, QuoteSize: 10, QuotedAt: quoted, Delta: &delta, Gamma: &gamma, Theta: &theta, Vega: &vega}}
	order.StrategyType = "SINGLE_LEG_OPTION"
	order.AssessmentMaxLoss = func() *float64 { v := 100.0; return &v }()
	order.AssessmentGreeks = map[string]float64{"delta": delta, "gamma": gamma, "theta": theta, "vega": vega}
	order.MarketEvidenceAt, order.ObservedAt, order.AssessmentExpiresAt = quoted, time.Now(), time.Now().Add(time.Minute)
	return order
}

func autonomousAuthorizationJSON(order *interfaces.OptionsOrder, identity models.DurableIdentity, allowed bool, reason string, issuedAt, expiresAt time.Time) string {
	auth := interfaces.AutonomousPaperAuthorization{
		Allowed: allowed, Reason: reason, AuthorizationID: "auth-test",
		Fingerprint: AlphaDeskAuthorizationFingerprint(identity, order, "v1"),
		Mode:        "PAPER_ONLY", Environment: "PAPER", WorkspaceID: identity.TenantID, AccountID: identity.BrokerAccountID,
		Issuer: "AlphaDesk", Source: "strategy_assessment", IssuedAt: issuedAt, ExpiresAt: order.AssessmentExpiresAt, PolicyVersion: "v1",
		StrategyIdentity: autonomousPaperStrategyIdentity(order),
	}
	b, _ := json.Marshal(map[string]any{"decision": "PASS", "signal_score": 0.9, "execution_threshold": 0.8, "expires_at": order.AssessmentExpiresAt, "execution_allowed": false, "human_approval_required": true, "autonomous_paper_authorization": auth})
	return string(b)
}

func freshAssessmentChainProvider(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
	return []*interfaces.OptionContract{{
		Symbol: "TSLA251219C00400000", Bid: 0.9, Ask: 1.1, BidSize: 10, AskSize: 10,
		QuoteTimestamp: time.Now().Add(-time.Second), Delta: 0.5, Gamma: 0.1, Theta: -0.2, Vega: 0.3,
	}}, nil
}

func (f fakeMarketClock) GetClock() (*alpaca.Clock, error) {
	return f.clock, f.err
}

func TestValidateOptionsOrderRequiresExplicitIntentAndValidContract(t *testing.T) {
	valid := &interfaces.OptionsOrder{
		Symbol:         "TSLA251219C00400000",
		Underlying:     "TSLA",
		Qty:            2,
		Side:           "buy",
		PositionIntent: "buy_to_open",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     floatPtr(1.25),
	}
	if err := validateOptionsOrder(valid); err != nil {
		t.Fatalf("valid options order rejected: %v", err)
	}
	padded := *valid
	padded.Symbol = "TSLA  251219C00400000"
	if err := validateOptionsOrder(&padded); err != nil {
		t.Fatalf("padded OCC options order rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*interfaces.OptionsOrder)
		want   string
	}{
		{"missing intent", func(order *interfaces.OptionsOrder) { order.PositionIntent = "" }, "position_intent is required"},
		{"wrong side", func(order *interfaces.OptionsOrder) { order.Side = "sell" }, "must match side"},
		{"invalid OCC symbol", func(order *interfaces.OptionsOrder) { order.Symbol = "TSLA" }, "valid OCC"},
		{"underlying mismatch", func(order *interfaces.OptionsOrder) { order.Underlying = "AAPL" }, "underlying"},
		{"fractional contracts", func(order *interfaces.OptionsOrder) { order.Qty = 1.5 }, "whole number"},
		{"non-positive limit", func(order *interfaces.OptionsOrder) { *order.LimitPrice = 0 }, "positive"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			order := *valid
			tt.mutate(&order)
			err := validateOptionsOrder(&order)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("validateOptionsOrder() error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestBuildAlpacaOptionsOrderRequestPreservesIntent(t *testing.T) {
	order := &interfaces.OptionsOrder{
		ClientOrderID:  "op-test",
		Symbol:         "TSLA251219C00400000",
		Underlying:     "TSLA",
		Qty:            1,
		Side:           "buy",
		PositionIntent: "buy_to_close",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     floatPtr(2.5),
	}

	req, err := buildAlpacaOptionsOrderRequest(order)
	if err != nil {
		t.Fatalf("buildAlpacaOptionsOrderRequest() error = %v", err)
	}
	if req.PositionIntent != alpaca.BuyToClose {
		t.Fatalf("PositionIntent = %q, want %q", req.PositionIntent, alpaca.BuyToClose)
	}
	if req.Symbol != order.Symbol || req.ClientOrderID != order.ClientOrderID || req.Qty == nil || req.Qty.InexactFloat64() != 1 {
		t.Fatalf("request did not preserve order identity/quantity: %#v", req)
	}
}

func TestBuildAlpacaOptionsOrderRequestBuildsOneAtomicTwoLegOrder(t *testing.T) {
	order := &interfaces.OptionsOrder{
		ClientOrderID:  "op-mleg",
		Symbol:         "TSLA251219P00400000",
		Underlying:     "TSLA",
		Qty:            2,
		Side:           "buy",
		PositionIntent: "buy_to_open",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     floatPtr(1.25),
		Legs: []interfaces.OptionLeg{
			{Symbol: "TSLA251219P00400000", Side: "sell", RatioQty: 1, PositionIntent: "sell_to_open", Price: 2.10},
			{Symbol: "TSLA251219P00390000", Side: "buy", RatioQty: 1, PositionIntent: "buy_to_open", Price: 0.85},
		},
	}

	req, err := buildAlpacaOptionsOrderRequest(order)
	if err != nil {
		t.Fatalf("buildAlpacaOptionsOrderRequest() error = %v", err)
	}
	if req.OrderClass != alpaca.MLeg || req.ClientOrderID != order.ClientOrderID || req.Qty == nil || req.Qty.InexactFloat64() != order.Qty {
		t.Fatalf("parent request = %#v, want one mleg parent", req)
	}
	if req.LimitPrice == nil || req.LimitPrice.InexactFloat64() != *order.LimitPrice || req.TimeInForce != alpaca.Day {
		t.Fatalf("parent pricing/TIF = %#v, want net limit and day", req)
	}
	if len(req.Legs) != 2 {
		t.Fatalf("request has %d legs, want 2", len(req.Legs))
	}
	for i, leg := range req.Legs {
		want := order.Legs[i]
		if leg.Symbol != want.Symbol || string(leg.Side) != want.Side || string(leg.PositionIntent) != want.PositionIntent || leg.RatioQty.InexactFloat64() != float64(want.RatioQty) {
			t.Fatalf("request leg %d = %#v, want %#v", i, leg, want)
		}
	}
}

func TestPlaceOptionsOrderSubmitsAtomicTwoLegOrderOnceAfterAutonomousAuthorization(t *testing.T) {
	now := time.Now().UTC()
	price := 1.25
	order := &interfaces.OptionsOrder{
		ClientOrderID: "op-authorized-mleg", Symbol: "TSLA251219P00400000", Underlying: "TSLA", Qty: 2,
		Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price,
		StrategyType: "MULTI_LEG_OPTION", AssessmentMaxLoss: func() *float64 { v := 250.0; return &v }(),
		AssessmentGreeks: map[string]float64{"delta": 0.1}, MarketEvidenceAt: now.Add(-time.Minute), ObservedAt: now.Add(-time.Second), AssessmentExpiresAt: now.Add(time.Minute),
		Legs: []interfaces.OptionLeg{
			{Symbol: "TSLA251219P00400000", Side: "sell", RatioQty: 1, PositionIntent: "sell_to_open", Price: 2.10},
			{Symbol: "TSLA251219P00390000", Side: "buy", RatioQty: 1, PositionIntent: "buy_to_open", Price: 0.85},
		},
		AssessmentLegs: []interfaces.AlphaDeskAssessmentLeg{
			{Symbol: "TSLA251219P00400000", Side: "sell", Quantity: 1, Price: 2.10, Bid: 2, Ask: 2.2, QuoteSize: 10, QuotedAt: now.Add(-time.Second)},
			{Symbol: "TSLA251219P00390000", Side: "buy", Quantity: 1, Price: 0.85, Bid: 0.8, Ask: 0.9, QuoteSize: 10, QuotedAt: now.Add(-time.Second)},
		},
	}
	identity := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	alphaCalls, brokerCalls := 0, 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		alphaCalls++
		var req AlphaDeskAssessmentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if !req.RequestAutonomousPaperAuthorization {
			t.Fatal("opening assessment did not request autonomous paper authorization")
		}
		response := autonomousAuthorizationJSON(order, identity, true, "approved", now.Add(-time.Minute), now.Add(time.Hour))
		_, _ = w.Write([]byte(response))
	}))
	defer alpha.Close()
	service := &AlpacaTradingService{
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), submissionMarker: func(string) error { return nil },
		expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox",
		alphaDesk: &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: func() time.Time { return now }},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			if req.OrderClass != alpaca.MLeg || len(req.Legs) != 2 || req.ClientOrderID != order.ClientOrderID || req.Qty == nil || req.Qty.InexactFloat64() != 2 {
				t.Fatalf("submitted request=%#v, want atomic mleg parent", req)
			}
			return &alpaca.Order{ID: "broker-mleg", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, PositionIntent: req.PositionIntent, OrderClass: alpaca.MLeg, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted", Legs: []alpaca.Order{
				{Symbol: req.Legs[0].Symbol, Side: req.Legs[0].Side, PositionIntent: req.Legs[0].PositionIntent, RatioQty: &req.Legs[0].RatioQty},
				{Symbol: req.Legs[1].Symbol, Side: req.Legs[1].Side, PositionIntent: req.Legs[1].PositionIntent, RatioQty: &req.Legs[1].RatioQty},
			}}, nil
		},
	}
	result, err := service.PlaceOptionsOrder(context.Background(), order)
	if err != nil || result == nil || result.ExecutionConfirmed || alphaCalls != 1 || brokerCalls != 1 {
		t.Fatalf("result=%#v err=%v AlphaDesk calls=%d broker calls=%d; want one acknowledged atomic submission", result, err, alphaCalls, brokerCalls)
	}
}

func TestPlaceOptionsOrderRejectsRetryAfterSubmissionAttempt(t *testing.T) {
	calls := 0
	price := 1.0
	service := &AlpacaTradingService{
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox",
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) { calls++; return nil, nil },
	}
	order := &interfaces.OptionsOrder{ClientOrderID: "retry-after-attempt", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price, SubmissionAttempted: true}
	_, err := service.PlaceOptionsOrder(context.Background(), order)
	if err == nil || !IsSubmissionUncertain(err) || calls != 0 {
		t.Fatalf("err=%v calls=%d; want uncertain retry rejection before broker", err, calls)
	}
}

func TestPlaceEquityEntryUsesBrokerClockBeforeSubmission(t *testing.T) {
	service := &AlpacaTradingService{
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: false, NextOpen: time.Now().Add(time.Hour)}},
	}
	limitPrice := 100.0
	_, err := service.PlaceOrder(context.Background(), &interfaces.Order{
		ClientOrderID: "op-clock-test",
		Symbol:        "AAPL",
		Qty:           1,
		Side:          "buy",
		Type:          "limit",
		TimeInForce:   "day",
		LimitPrice:    &limitPrice,
		Purpose:       "entry",
	})
	var closedErr *MarketClosedError
	if !errors.As(err, &closedErr) {
		t.Fatalf("PlaceOrder() error = %v, want MarketClosedError", err)
	}
}

func TestCheckRegularSessionFailsClosedAndReportsNextOpen(t *testing.T) {
	nextOpen := time.Date(2026, 9, 21, 13, 30, 0, 0, time.UTC)
	err := checkRegularSession(fakeMarketClock{clock: &alpaca.Clock{IsOpen: false, NextOpen: nextOpen}})
	var closedErr *MarketClosedError
	if !errors.As(err, &closedErr) {
		t.Fatalf("checkRegularSession() error = %v, want MarketClosedError", err)
	}
	if !closedErr.NextOpen.Equal(nextOpen) {
		t.Fatalf("NextOpen = %v, want %v", closedErr.NextOpen, nextOpen)
	}

	if err := checkRegularSession(fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}); err != nil {
		t.Fatalf("open clock rejected: %v", err)
	}
	if err := checkRegularSession(fakeMarketClock{err: errors.New("clock unavailable")}); err == nil || !strings.Contains(err.Error(), "market clock") {
		t.Fatalf("clock failure = %v, want fail-closed market clock error", err)
	}
}

func TestPlaceOrderRejectsPaddedOCCSymbol(t *testing.T) {
	calls := 0
	service := &AlpacaTradingService{
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			calls++
			return &alpaca.Order{}, nil
		},
	}
	_, err := service.PlaceOrder(context.Background(), &interfaces.Order{Symbol: "TSLA  251219C00400000", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day"})
	if err == nil || !strings.Contains(err.Error(), "place_options_order") || calls != 0 {
		t.Fatalf("PlaceOrder() err=%v calls=%d, want generic padded OCC rejection and zero broker calls", err, calls)
	}
}

func TestPlaceOptionsOrderClosedDoesNotCallBroker(t *testing.T) {
	calls := 0
	service := &AlpacaTradingService{
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: false}},
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			calls++
			return &alpaca.Order{}, nil
		},
	}
	_, err := service.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{
		ClientOrderID:  "op-closed",
		Symbol:         "TSLA251219C00400000",
		Underlying:     "TSLA",
		Qty:            1,
		Side:           "buy",
		PositionIntent: "buy_to_open",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     floatPtr(1),
	})
	var closedErr *MarketClosedError
	if !errors.As(err, &closedErr) || calls != 0 {
		t.Fatalf("PlaceOptionsOrder() err=%v calls=%d, want market-closed and zero broker calls", err, calls)
	}
}

func TestRiskReducingOptionsExitDoesNotCallAlphaDesk(t *testing.T) {
	alphaCalls := 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		alphaCalls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer alpha.Close()
	brokerCalls := 0
	service := &AlpacaTradingService{
		clockReader:          fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:               logrus.New(),
		submissionMarker:     func(string) error { return nil },
		alphaDesk:            &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: freshAssessmentChainProvider,
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return &alpaca.Order{ID: "close-1", Status: "accepted", Qty: decimalPtr(decimal.NewFromInt(1)), Symbol: "TSLA251219C00400000", Side: alpaca.Sell, Type: alpaca.Limit, TimeInForce: alpaca.Day}, nil
		},
	}
	_, err := service.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{
		ClientOrderID: "op-close", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
		Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	})
	if alphaCalls != 0 || brokerCalls != 1 || strings.Contains(fmt.Sprint(err), "AlphaDesk") {
		t.Fatalf("exit err=%v AlphaDesk calls=%d broker calls=%d, want no AlphaDesk call and one broker call", err, alphaCalls, brokerCalls)
	}
}

func TestOpeningOptionsRetryFetchesFreshAlphaDeskAssessment(t *testing.T) {
	alphaCalls := 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		alphaCalls++
		_, _ = w.Write([]byte(`{"assessment_id":"fresh","decision":"PASS","signal_score":0.9,"execution_threshold":0.8,"expires_at":"2099-01-01T00:00:00Z","execution_allowed":true,"human_approval_required":false}`))
	}))
	defer alpha.Close()
	service := &AlpacaTradingService{
		clockReader:          fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:               logrus.New(),
		submissionMarker:     func(string) error { return nil },
		alphaDesk:            &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: freshAssessmentChainProvider,
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			return &alpaca.Order{ID: "retry-1", Status: "accepted", Qty: decimalPtr(decimal.NewFromInt(1)), Symbol: "TSLA251219C00400000", Side: alpaca.Buy, Type: alpaca.Limit, TimeInForce: alpaca.Day}, nil
		},
	}
	order := readyAssessmentOrder(&interfaces.OptionsOrder{ClientOrderID: "op-retry", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)})
	_, _ = service.PlaceOptionsOrder(context.Background(), order)
	_, _ = service.PlaceOptionsOrder(context.Background(), order)
	if alphaCalls != 2 {
		t.Fatalf("AlphaDesk calls = %d, want a fresh assessment on both submissions", alphaCalls)
	}
}

func TestOpeningOptionsBlocksWhenAlphaDeskDisallowsExecution(t *testing.T) {
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"pass":true,"decision":"PASS","assessment_id":"blocked","market_scanner_signal_score":0.9,"policy_snapshot":{"minimum_signal_score":"0.8"},"expires_at":"2099-01-01T00:00:00Z","paper_only":true,"human_approval_required":false,"execution_allowed":false}`))
	}))
	defer alpha.Close()

	brokerCalls := 0
	service := &AlpacaTradingService{
		clockReader:          fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:               logrus.New(),
		submissionMarker:     func(string) error { return nil },
		expectedAccountID:    "acct",
		expectedPaper:        true,
		expectedTenantID:     "tenant",
		expectedSandboxID:    "sandbox",
		alphaDesk:            &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: freshAssessmentChainProvider,
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return nil, nil
		},
	}

	_, err := service.PlaceOptionsOrder(context.Background(), readyAssessmentOrder(&interfaces.OptionsOrder{
		ClientOrderID: "op-alpha-denied", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
		Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	}))
	if err == nil || brokerCalls != 0 {
		t.Fatalf("PlaceOptionsOrder() err=%v broker calls=%d, want AlphaDesk denial and zero broker calls", err, brokerCalls)
	}
}

func TestOpeningOptionsFailsClosedWhenAlphaDeskUnavailable(t *testing.T) {
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer alpha.Close()

	t.Run("enabled but unavailable blocks before broker submission", func(t *testing.T) {
		calls := 0
		service := &AlpacaTradingService{
			clockReader:          fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
			logger:               logrus.New(),
			submissionMarker:     func(string) error { return nil },
			expectedAccountID:    "acct",
			expectedPaper:        true,
			expectedTenantID:     "tenant",
			expectedSandboxID:    "sandbox",
			alphaDesk:            &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
			optionsChainProvider: freshAssessmentChainProvider,
			placeOrderFn:         func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) { calls++; return nil, nil },
		}
		_, err := service.PlaceOptionsOrder(context.Background(), readyAssessmentOrder(&interfaces.OptionsOrder{
			ClientOrderID: "op-no-alpha", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
			Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
		}))
		if err == nil || !strings.Contains(err.Error(), "AlphaDesk assessment unavailable") || calls != 0 {
			t.Fatalf("err=%v broker calls=%d; enabled AlphaDesk outage did not fail closed", err, calls)
		}
	})

	t.Run("disabled does not add a new block", func(t *testing.T) {
		calls := 0
		service := &AlpacaTradingService{
			clockReader:       fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
			logger:            logrus.New(),
			submissionMarker:  func(string) error { return nil },
			expectedAccountID: "acct",
			expectedPaper:     true,
			expectedTenantID:  "tenant",
			expectedSandboxID: "sandbox",
			placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				calls++
				return &alpaca.Order{ID: "disabled-alpha", ClientOrderID: req.ClientOrderID, Status: "accepted", Qty: req.Qty, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, LimitPrice: req.LimitPrice, PositionIntent: req.PositionIntent}, nil
			},
		}
		_, err := service.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{
			ClientOrderID: "op-disabled-alpha", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
			Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
		})
		if err != nil || calls != 1 {
			t.Fatalf("err=%v broker calls=%d; disabled AlphaDesk added a new block", err, calls)
		}
	})
}

func TestOpeningOptionsRefreshesInjectedEvidenceBeforeAlphaDesk(t *testing.T) {
	var assessedLeg interfaces.AlphaDeskAssessmentLeg
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request AlphaDeskAssessmentRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if len(request.Legs) != 1 {
			t.Fatalf("AlphaDesk received %d legs, want one fresh single-leg record", len(request.Legs))
		}
		assessedLeg = request.Legs[0]
		limit := request.LimitPrice
		maxLoss := request.MaxLoss
		authOrder := &interfaces.OptionsOrder{Symbol: request.Legs[0].Symbol, Underlying: request.UnderlyingSymbol, StrategyType: request.StrategyType, Side: request.Side, Qty: float64(request.Quantity), LimitPrice: &limit, AssessmentMaxLoss: &maxLoss, AssessmentLegs: request.Legs, AssessmentExpiresAt: request.ExpiresAt}
		_, _ = w.Write([]byte(autonomousAuthorizationJSON(authOrder, models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}, true, "approved", time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), request.ExpiresAt)))
	}))
	defer alpha.Close()

	brokerCalls := 0
	service := &AlpacaTradingService{
		clockReader:       fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:            logrus.New(),
		submissionMarker:  func(string) error { return nil },
		expectedAccountID: "acct",
		expectedPaper:     true,
		expectedTenantID:  "tenant",
		expectedSandboxID: "sandbox",
		alphaDesk:         &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
			quoteTime := time.Now().Add(-time.Second)
			return []*interfaces.OptionContract{{
				Symbol: "TSLA251219C00400000", Bid: 2.10, Ask: 2.20, BidSize: 7, AskSize: 8,
				QuoteTimestamp: quoteTime, Delta: 0.72, Gamma: 0.12, Theta: -0.31, Vega: 0.44,
			}}, nil
		},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return &alpaca.Order{ID: "fresh-1", ClientOrderID: req.ClientOrderID, Status: "accepted", Qty: req.Qty, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, LimitPrice: req.LimitPrice, PositionIntent: req.PositionIntent}, nil
		},
	}
	order := readyAssessmentOrder(&interfaces.OptionsOrder{
		ClientOrderID: "stable-client-id", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
		Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	})
	order.AssessmentLegs[0].Bid = 0.01
	order.AssessmentLegs[0].Delta = floatPtr(-0.99)

	_, err := service.PlaceOptionsOrder(context.Background(), order)
	if err != nil || brokerCalls != 1 {
		t.Fatalf("PlaceOptionsOrder() err=%v broker calls=%d, want successful submission", err, brokerCalls)
	}
	if assessedLeg.Bid != 2.10 || assessedLeg.Ask != 2.20 || assessedLeg.Delta == nil || *assessedLeg.Delta != 0.72 {
		t.Fatalf("AlphaDesk received stale/injected evidence: %#v", assessedLeg)
	}
	if order.ClientOrderID != "stable-client-id" {
		t.Fatalf("client order ID changed to %q", order.ClientOrderID)
	}
}

func TestOpeningOptionsSingleLegLiveContractApprovalRequiredBlocksBeforeBroker(t *testing.T) {
	brokerCalls := 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req AlphaDeskAssessmentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req.Legs[0].OpenInterest == nil || *req.Legs[0].OpenInterest != 17 {
			t.Fatalf("AlphaDesk leg OI = %#v, want 17", req.Legs[0].OpenInterest)
		}
		_, _ = w.Write([]byte(autonomousAuthorizationJSON(&interfaces.OptionsOrder{Underlying: "TSLA", StrategyType: "SINGLE_LEG_OPTION", Side: "buy", Qty: 1, LimitPrice: floatPtr(1), AssessmentMaxLoss: floatPtr(1), AssessmentLegs: []interfaces.AlphaDeskAssessmentLeg{{Symbol: "TSLA251219C00400000", Side: "buy", Quantity: 1, Price: 1}}, AssessmentExpiresAt: time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)}, models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}, false, "approval required", time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))))
	}))
	defer alpha.Close()
	service := &AlpacaTradingService{
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(),
		submissionMarker: func(string) error { return nil }, expectedAccountID: "acct", expectedPaper: true,
		expectedTenantID: "tenant", expectedSandboxID: "sandbox",
		alphaDesk: &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
			return []*interfaces.OptionContract{{Symbol: "TSLA251219C00400000", Bid: 2, Ask: 2.2, BidSize: 7, AskSize: 8, OpenInterest: 17, OpenInterestPresent: true, QuoteTimestamp: time.Now().Add(-time.Second), Delta: .7, Gamma: .1, Theta: -.2, Vega: .3}}, nil
		},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return &alpaca.Order{ID: "single-1", ClientOrderID: req.ClientOrderID, Status: "accepted", Qty: req.Qty, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, LimitPrice: req.LimitPrice, PositionIntent: req.PositionIntent}, nil
		},
	}
	_, err := service.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{ClientOrderID: "single-boundary", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)})
	if err == nil || !strings.Contains(err.Error(), "is denied") || brokerCalls != 0 {
		t.Fatalf("err=%v brokerCalls=%d, want live-contract approval block and zero broker calls", err, brokerCalls)
	}
}

func TestOpeningOptionsSingleLegAutonomousPaperAuthorizationSubmitsNormalOrder(t *testing.T) {
	for _, tc := range []struct {
		name   string
		symbol string
	}{
		{name: "call", symbol: "TSLA251219C00400000"},
		{name: "put", symbol: "TSLA251219P00400000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			quoteTime := now.Add(-time.Second)
			price := 1.25
			order := &interfaces.OptionsOrder{
				ClientOrderID: "single-positive-" + tc.name, Symbol: tc.symbol, Underlying: "TSLA", Qty: 1,
				Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price,
			}
			identity := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
			expectedLeg := interfaces.AlphaDeskAssessmentLeg{
				Symbol: tc.symbol, Side: "buy", Quantity: 1, Price: price, Bid: 1.20, Ask: 1.30, QuoteSize: 11,
				QuotedAt: quoteTime, OpenInterest: int64Ptr(23),
				Delta: floatPtr(0.55), Gamma: floatPtr(0.08), Theta: floatPtr(-0.18), Vega: floatPtr(0.27),
			}
			alphaCalls, brokerCalls := 0, 0
			alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				alphaCalls++
				var request AlphaDeskAssessmentRequest
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				if !request.RequestAutonomousPaperAuthorization {
					t.Fatal("opening assessment did not request autonomous paper authorization")
				}
				if request.StrategyType != "SINGLE_LEG_OPTION" || request.UnderlyingSymbol != "TSLA" || request.Side != "buy" || request.Quantity != 1 || request.LimitPrice != price {
					t.Fatalf("request identity = %#v, want single-leg TSLA buy", request)
				}
				if len(request.Legs) != 1 || !reflect.DeepEqual(request.Legs[0], expectedLeg) {
					t.Fatalf("AlphaDesk evidence = %#v, want exact one-leg evidence %#v", request.Legs, []interfaces.AlphaDeskAssessmentLeg{expectedLeg})
				}
				authOrder := *order
				authOrder.StrategyType = request.StrategyType
				authOrder.AssessmentLegs = request.Legs
				authOrder.AssessmentMaxLoss = &request.MaxLoss
				authOrder.AssessmentGreeks = request.Greeks
				authOrder.MarketEvidenceAt = request.MarketEvidenceAt
				authOrder.ObservedAt = request.ObservedAt
				authOrder.AssessmentExpiresAt = request.ExpiresAt
				_, _ = w.Write([]byte(autonomousAuthorizationJSON(&authOrder, identity, true, "approved", now.Add(-time.Minute), request.ExpiresAt)))
			}))
			defer alpha.Close()

			service := &AlpacaTradingService{
				clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(),
				submissionMarker: func(string) error { return nil }, expectedAccountID: identity.BrokerAccountID, expectedPaper: true,
				expectedTenantID: identity.TenantID, expectedSandboxID: identity.SandboxID,
				alphaDesk: &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: func() time.Time { return now }},
				optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
					return []*interfaces.OptionContract{{Symbol: tc.symbol, Bid: 1.20, Ask: 1.30, BidSize: 9, AskSize: 11, OpenInterest: 23, OpenInterestPresent: true, QuoteTimestamp: quoteTime, Delta: .55, Gamma: .08, Theta: -.18, Vega: .27}}, nil
				},
				placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
					brokerCalls++
					if req.OrderClass == alpaca.MLeg || len(req.Legs) != 0 {
						t.Fatalf("single-leg submission was multi-leg: %#v", req)
					}
					if req.Symbol != tc.symbol || req.Side != alpaca.Buy || req.Type != alpaca.Limit || req.TimeInForce != alpaca.Day || req.PositionIntent != alpaca.BuyToOpen || req.ClientOrderID != order.ClientOrderID || req.Qty == nil || req.Qty.InexactFloat64() != 1 || req.LimitPrice == nil || req.LimitPrice.InexactFloat64() != price {
						t.Fatalf("single-leg submission = %#v, want exact order identity", req)
					}
					return &alpaca.Order{ID: "single-positive-1", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, PositionIntent: req.PositionIntent, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted"}, nil
				},
			}

			result, err := service.PlaceOptionsOrder(context.Background(), order)
			if err != nil || result == nil || result.ExecutionConfirmed || alphaCalls != 1 || brokerCalls != 1 {
				t.Fatalf("result=%#v err=%v AlphaDesk calls=%d broker calls=%d; want one unfilled single-leg submission", result, err, alphaCalls, brokerCalls)
			}
		})
	}
}

func TestOpeningOptionsRejectsIncompleteAuthorizationBeforeBroker(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*interfaces.AutonomousPaperAuthorization, time.Time)
	}{
		{name: "missing issuer", mutate: func(auth *interfaces.AutonomousPaperAuthorization, _ time.Time) { auth.Issuer = "" }},
		{name: "missing source", mutate: func(auth *interfaces.AutonomousPaperAuthorization, _ time.Time) { auth.Source = "" }},
		{name: "empty policy version", mutate: func(auth *interfaces.AutonomousPaperAuthorization, _ time.Time) { auth.PolicyVersion = "" }},
		{name: "expiry mismatch", mutate: func(auth *interfaces.AutonomousPaperAuthorization, now time.Time) {
			auth.ExpiresAt = now.Add(time.Hour)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			price := 1.25
			order := &interfaces.OptionsOrder{
				ClientOrderID: "single-negative-" + strings.ReplaceAll(tc.name, " ", "-"), Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
				Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price,
			}
			identity := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
			brokerCalls := 0
			alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request AlphaDeskAssessmentRequest
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				maxLoss := request.MaxLoss
				authOrder := &interfaces.OptionsOrder{
					Underlying: request.UnderlyingSymbol, StrategyType: request.StrategyType, Side: request.Side, Qty: float64(request.Quantity), LimitPrice: &request.LimitPrice,
					AssessmentMaxLoss: &maxLoss, AssessmentLegs: request.Legs, AssessmentExpiresAt: request.ExpiresAt,
				}
				auth := &interfaces.AutonomousPaperAuthorization{
					Allowed: true, AuthorizationID: "auth-negative", Mode: "PAPER_ONLY", Environment: "PAPER", WorkspaceID: identity.TenantID, AccountID: identity.BrokerAccountID,
					Issuer: "AlphaDesk", Source: "strategy_assessment", IssuedAt: now.Add(-time.Minute), ExpiresAt: request.ExpiresAt, PolicyVersion: "v1", StrategyIdentity: autonomousPaperStrategyIdentity(authOrder),
				}
				auth.Fingerprint = AlphaDeskAuthorizationFingerprint(identity, authOrder, auth.PolicyVersion)
				tc.mutate(auth, now)
				b, _ := json.Marshal(map[string]any{"decision": "PASS", "signal_score": 0.9, "execution_threshold": 0.8, "expires_at": request.ExpiresAt, "autonomous_paper_authorization": auth})
				_, _ = w.Write(b)
			}))
			defer alpha.Close()

			service := &AlpacaTradingService{
				clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), submissionMarker: func(string) error { return nil },
				expectedAccountID: identity.BrokerAccountID, expectedPaper: true, expectedTenantID: identity.TenantID, expectedSandboxID: identity.SandboxID,
				alphaDesk: &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: func() time.Time { return now }},
				optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
					return []*interfaces.OptionContract{{Symbol: order.Symbol, Bid: 1.20, Ask: 1.30, BidSize: 9, AskSize: 11, OpenInterest: 23, OpenInterestPresent: true, QuoteTimestamp: now.Add(-time.Second), Delta: .55, Gamma: .08, Theta: -.18, Vega: .27}}, nil
				},
				placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) { brokerCalls++; return nil, nil },
			}

			_, err := service.PlaceOptionsOrder(context.Background(), order)
			if err == nil || brokerCalls != 0 {
				t.Fatalf("err=%v brokerCalls=%d; want authorization rejection before broker", err, brokerCalls)
			}
		})
	}
}

func TestEnrichOptionsAssessmentPreservesPositiveZeroAndAbsentOI(t *testing.T) {
	for _, tc := range []struct {
		name    string
		oi      int64
		present bool
		want    *int64
	}{
		{name: "positive", oi: 17, present: true, want: int64Ptr(17)},
		{name: "zero", oi: 0, present: true, want: int64Ptr(0)},
		{name: "absent", oi: 0, present: false, want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quoted := time.Now().Add(-time.Second)
			service := &AlpacaTradingService{optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
				return []*interfaces.OptionContract{{Symbol: "TSLA251219C00400000", Bid: 1, Ask: 1.2, BidSize: 2, AskSize: 3, OpenInterest: tc.oi, OpenInterestPresent: tc.present, QuoteTimestamp: quoted}}, nil
			}}
			order := &interfaces.OptionsOrder{Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)}
			if err := service.enrichOptionsAssessment(context.Background(), order); err != nil {
				t.Fatal(err)
			}
			got := order.AssessmentLegs[0].OpenInterest
			if (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
				t.Fatalf("OI=%v, want %v", got, tc.want)
			}
			encoded, err := json.Marshal(order.AssessmentLegs[0])
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == nil && strings.Contains(string(encoded), "open_interest") {
				t.Fatalf("absent OI was serialized: %s", encoded)
			}
			if tc.want != nil && !strings.Contains(string(encoded), "open_interest") {
				t.Fatalf("present OI was omitted: %s", encoded)
			}
		})
	}
}

func int64Ptr(value int64) *int64 { return &value }

func TestEnrichOptionsAssessmentRejectsStaleFutureAndUnquotedEvidence(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(time.Time) *interfaces.OptionContract
	}{
		{name: "stale", make: func(now time.Time) *interfaces.OptionContract {
			return &interfaces.OptionContract{Symbol: "TSLA251219C00400000", Bid: 1, Ask: 1.2, BidSize: 2, AskSize: 3, QuoteTimestamp: now.Add(-3 * time.Minute)}
		}},
		{name: "future", make: func(now time.Time) *interfaces.OptionContract {
			return &interfaces.OptionContract{Symbol: "TSLA251219C00400000", Bid: 1, Ask: 1.2, BidSize: 2, AskSize: 3, QuoteTimestamp: now.Add(time.Second)}
		}},
		{name: "missing quote size", make: func(now time.Time) *interfaces.OptionContract {
			return &interfaces.OptionContract{Symbol: "TSLA251219C00400000", Bid: 1, Ask: 1.2, QuoteTimestamp: now.Add(-time.Second)}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &AlpacaTradingService{optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
				return []*interfaces.OptionContract{tc.make(time.Now())}, nil
			}}
			order := &interfaces.OptionsOrder{Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)}
			if err := service.enrichOptionsAssessment(context.Background(), order); err == nil || !strings.Contains(err.Error(), "fresh broker quote evidence") {
				t.Fatalf("err=%v, want typed fresh-quote evidence diagnostic", err)
			}
		})
	}
}

func TestQuoteTimestampFreshUsesNamedTwoMinuteBound(t *testing.T) {
	now := time.Now()
	if quoteTimestampFresh(time.Time{}) || quoteTimestampFresh(now.Add(time.Second)) {
		t.Fatal("zero and future quote timestamps must be rejected")
	}
	if !quoteTimestampFresh(now.Add(-brokerQuoteMaxAge + time.Second)) {
		t.Fatal("quote within brokerQuoteMaxAge must be accepted")
	}
	if quoteTimestampFresh(now.Add(-brokerQuoteMaxAge - time.Second)) {
		t.Fatal("quote older than brokerQuoteMaxAge must be rejected")
	}
}

func TestOpeningOptionsBlocksBeforeBrokerWhenFreshEnrichmentFails(t *testing.T) {
	alphaCalls := 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		alphaCalls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer alpha.Close()

	brokerCalls := 0
	service := &AlpacaTradingService{
		clockReader:       fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:            logrus.New(),
		submissionMarker:  func(string) error { return nil },
		expectedAccountID: "acct",
		expectedPaper:     true,
		expectedTenantID:  "tenant",
		expectedSandboxID: "sandbox",
		alphaDesk:         &AlphaDeskClient{Enabled: true, URL: alpha.URL, APIKey: "test", HTTP: alpha.Client(), Now: time.Now},
		optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
			return nil, errors.New("broker chain unavailable")
		},
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return nil, nil
		},
	}

	_, err := service.PlaceOptionsOrder(context.Background(), readyAssessmentOrder(&interfaces.OptionsOrder{
		ClientOrderID: "op-enrichment-fail", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
		Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	}))
	var unavailable *AlphaDeskUnavailableError
	if !errors.As(err, &unavailable) || brokerCalls != 0 || alphaCalls != 0 {
		t.Fatalf("err=%T %v broker calls=%d AlphaDesk calls=%d; want structured enrichment failure before submission", err, err, brokerCalls, alphaCalls)
	}
}

func TestOpeningOptionsRejectsUnsupportedMultiLegEvidence(t *testing.T) {
	brokerCalls := 0
	service := &AlpacaTradingService{
		clockReader:          fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		logger:               logrus.New(),
		submissionMarker:     func(string) error { return nil },
		alphaDesk:            &AlphaDeskClient{Enabled: true},
		optionsChainProvider: freshAssessmentChainProvider,
		placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return nil, nil
		},
	}
	order := readyAssessmentOrder(&interfaces.OptionsOrder{
		ClientOrderID: "op-multileg", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1,
		Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	})
	order.AssessmentLegs = append(order.AssessmentLegs, order.AssessmentLegs[0])
	_, err := service.PlaceOptionsOrder(context.Background(), order)
	var unavailable *AlphaDeskUnavailableError
	if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), "multi-leg") || brokerCalls != 0 {
		t.Fatalf("err=%v broker calls=%d; want structured multi-leg unavailable before submission", err, brokerCalls)
	}
}

func TestOrderResultDistinguishesAcknowledgementFromFill(t *testing.T) {
	accepted := orderResultFromAlpacaOrder(nil, &alpaca.Order{
		ID:     "broker-accepted",
		Status: "accepted",
		Qty:    decimalPtr(decimal.NewFromInt(1)),
	})
	if accepted.ExecutionConfirmed {
		t.Fatal("accepted order was marked execution-confirmed")
	}
	if !strings.Contains(accepted.Message, "not confirmed") {
		t.Fatalf("accepted message = %q, want not-confirmed wording", accepted.Message)
	}

	fillPrice := decimal.NewFromFloat(2.5)
	filled := orderResultFromAlpacaOrder(nil, &alpaca.Order{
		ID:             "broker-filled",
		Status:         "filled",
		Qty:            decimalPtr(decimal.NewFromInt(1)),
		FilledQty:      decimal.NewFromInt(1),
		FilledAvgPrice: &fillPrice,
	})
	if !filled.ExecutionConfirmed || filled.FilledQty != 1 || filled.FilledAvgPrice == nil || *filled.FilledAvgPrice != 2.5 {
		t.Fatalf("filled result = %#v, want confirmed fill", filled)
	}

	terminalPartialPrice := decimal.NewFromFloat(1.75)
	terminalPartial := orderResultFromAlpacaOrder(nil, &alpaca.Order{
		ID:             "broker-canceled-partial",
		Status:         "canceled",
		Qty:            decimalPtr(decimal.NewFromInt(2)),
		FilledQty:      decimal.NewFromInt(1),
		FilledAvgPrice: &terminalPartialPrice,
	})
	if !terminalPartial.ExecutionConfirmed || terminalPartial.Status != "canceled" || terminalPartial.FilledQty != 1 {
		t.Fatalf("terminal partial result = %#v, want preserved partial fill", terminalPartial)
	}
	if !strings.Contains(terminalPartial.Message, "not fully filled") {
		t.Fatalf("terminal partial message = %q, want partial-fill wording", terminalPartial.Message)
	}

	missingID := orderResultFromAlpacaOrder(nil, &alpaca.Order{Status: "accepted"})
	if missingID.Status != "submission_uncertain" || missingID.ExecutionConfirmed {
		t.Fatalf("missing-ID result = %#v, want submission_uncertain", missingID)
	}
	unknownStatus := orderResultFromAlpacaOrder(nil, &alpaca.Order{ID: "broker-unknown", Status: "future_status"})
	if unknownStatus.Status != "submission_uncertain" || unknownStatus.ExecutionConfirmed {
		t.Fatalf("unknown-status result = %#v, want submission_uncertain", unknownStatus)
	}
}

func floatPtr(value float64) *float64 { return &value }

func decimalPtr(value decimal.Decimal) *decimal.Decimal { return &value }
