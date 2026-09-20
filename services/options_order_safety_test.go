package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
	"prophet-trader/interfaces"
)

type fakeMarketClock struct {
	clock *alpaca.Clock
	err   error
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
