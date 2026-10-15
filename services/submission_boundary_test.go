package services

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/database"
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
			return s.PlaceOptionsOrder(context.Background(), &interfaces.OptionsOrder{ClientOrderID: "options-boundary", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price})
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

func TestOptionsPostMarkerAbortIsKnownPreRPCAndKeepsMarketClosedType(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		abort func(*AlpacaTradingService, context.CancelFunc)
		check func(error) bool
	}{
		{name: "canceled context", abort: func(_ *AlpacaTradingService, cancel context.CancelFunc) { cancel() }, check: IsPreSubmissionRejection},
		{name: "market closes after marker", abort: func(s *AlpacaTradingService, _ context.CancelFunc) {
			s.clockReader = fakeMarketClock{clock: &alpaca.Clock{IsOpen: false, NextOpen: time.Now().Add(time.Hour)}}
		}, check: func(err error) bool {
			var closed *MarketClosedError
			return errors.As(err, &closed) && !IsPreSubmissionRejection(err)
		}},
		{name: "clock lookup fails after marker", abort: func(s *AlpacaTradingService, _ context.CancelFunc) {
			s.clockReader = fakeMarketClock{err: errors.New("clock unavailable")}
		}, check: IsPreSubmissionRejection},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			calls, marked := 0, false
			s := &AlpacaTradingService{logger: logrus.New(), expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox", clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				calls++
				return nil, errors.New("should not submit")
			}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.SetSubmissionMarker(func(string) error { marked = true; testCase.abort(s, cancel); return nil })
			price := 1.25
			_, err := s.PlaceOptionsOrder(ctx, &interfaces.OptionsOrder{ClientOrderID: "post-marker-options", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price})
			if !testCase.check(err) || calls != 0 || !marked {
				t.Fatalf("err=%v calls=%d marked=%v, want known pre-RPC abort after durable marker", err, calls, marked)
			}
		})
	}
}

func TestOptionsPostMarkerAbortWithRealDurableMarkerSurvivesReopen(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		abort func(*AlpacaTradingService, context.CancelFunc)
	}{
		{name: "clock lookup failure", abort: func(s *AlpacaTradingService, _ context.CancelFunc) {
			s.clockReader = fakeMarketClock{err: errors.New("clock unavailable after durable marker")}
		}},
		{name: "context cancellation", abort: func(_ *AlpacaTradingService, cancel context.CancelFunc) { cancel() }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "real-submission-marker.db")
			storage, err := database.NewLocalStorage(path)
			if err != nil {
				t.Fatal(err)
			}
			order := &interfaces.Order{ClientOrderID: "real-clock-error", Symbol: "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "sell", Type: "limit", TimeInForce: "day", Status: "pending", AssetClass: "us_option", PositionIntent: "sell_to_close", Purpose: "close"}
			if err := storage.SaveOrder(order); err != nil {
				t.Fatal(err)
			}
			calls := 0
			s := &AlpacaTradingService{logger: logrus.New(), expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox", clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				calls++
				return nil, errors.New("unexpected broker call")
			}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.SetSubmissionMarker(func(clientOrderID string) error {
				marked, err := storage.GetOrderByClientOrderID(clientOrderID)
				if err != nil || marked == nil {
					return errors.New("durable order missing at marker")
				}
				marked.SubmissionAttempted = true
				if err := storage.SaveOrder(marked); err != nil {
					return err
				}
				testCase.abort(s, cancel)
				return nil
			})
			price := 1.25
			_, err = s.PlaceOptionsOrder(ctx, &interfaces.OptionsOrder{ClientOrderID: order.ClientOrderID, Symbol: order.Symbol, Underlying: order.Underlying, Qty: order.Qty, Side: order.Side, PositionIntent: order.PositionIntent, Type: order.Type, TimeInForce: order.TimeInForce, LimitPrice: &price})
			if !IsPreSubmissionRejection(err) || calls != 0 {
				t.Fatalf("PlaceOptionsOrder() err=%v broker calls=%d; want typed known pre-RPC abort and zero calls", err, calls)
			}
			if err := storage.Close(); err != nil {
				t.Fatal(err)
			}
			storage = nil
			storage, err = database.NewLocalStorage(path)
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()
			saved, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
			if err != nil || saved == nil || !saved.SubmissionAttempted || saved.Status != "pending" {
				t.Fatalf("reopened real marker state = %#v, %v; want attempted unresolved intent for controller terminalization", saved, err)
			}
		})
	}
}
