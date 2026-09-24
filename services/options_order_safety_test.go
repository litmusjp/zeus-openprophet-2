package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
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
		_, _ = w.Write([]byte(`{"assessment_id":"fresh","decision":"PASS","signal_score":0.9,"execution_threshold":0.8,"expires_at":"2099-01-01T00:00:00Z","execution_allowed":true,"human_approval_required":false}`))
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
