package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
)

func TestSubmissionBoundaryEquityAndOptions(t *testing.T) {
	tests := []struct {
		name  string
		place func(*AlpacaTradingService) (*interfaces.OrderResult, error)
	}{
		{name: "equity", place: func(s *AlpacaTradingService) (*interfaces.OrderResult, error) {
			price := 100.0
			return s.PlaceOrder(context.Background(), &interfaces.Order{ClientOrderID: "equity-boundary", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: &price, Purpose: "entry"})
		}},
		{name: "options", place: func(s *AlpacaTradingService) (*interfaces.OrderResult, error) {
			price := 1.0
			return s.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{ClientOrderID: "options-boundary", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price})
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			marked := false
			s := &AlpacaTradingService{logger: logrus.New(), expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox", clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				calls++
				return nil, errors.New("provider timeout")
			}}
			s.SetSubmissionMarker(func(string) error { marked = true; return nil })
			if _, err := tt.place(s); !IsSubmissionUncertain(err) || calls != 1 || !marked {
				t.Fatalf("provider result err=%v calls=%d marked=%v, want uncertain after one call", err, calls, marked)
			}

			calls, marked = 0, false
			s.SetSubmissionMarker(func(string) error { return errors.New("durable store unavailable") })
			if _, err := tt.place(s); err == nil || calls != 0 || marked {
				t.Fatalf("marker failure err=%v calls=%d marked=%v, want no provider call", err, calls, marked)
			}

			s.SetSubmissionMarker(func(string) error { marked = true; return nil })
			s.placeOrderFn = func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				calls++
				return nil, errors.New("provider timeout")
			}
			_, err := tt.place(s)
			if !IsSubmissionUncertain(err) || calls != 1 || !marked {
				t.Fatalf("provider timeout err=%v calls=%d marked=%v, want uncertain after one call", err, calls, marked)
			}
		})
	}
}

func TestSubmissionBoundaryPreflightDoesNotMarkOrCallProvider(t *testing.T) {
	calls, marked := 0, false
	s := &AlpacaTradingService{clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: false}}, placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
		calls++
		return nil, nil
	}}
	s.SetSubmissionMarker(func(string) error { marked = true; return nil })
	price := 100.0
	_, err := s.PlaceOrder(context.Background(), &interfaces.Order{ClientOrderID: "closed-boundary", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: &price, Purpose: "entry"})
	if err == nil || strings.Contains(err.Error(), "submission") || calls != 0 || marked {
		t.Fatalf("preflight err=%v calls=%d marked=%v, want condition failure before boundary", err, calls, marked)
	}
}
