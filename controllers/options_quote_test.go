package controllers

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"

	"github.com/gin-gonic/gin"
)

const heldSymbol = "NVDA261218P00158000"

// quoteTradingService is a read-only fake: any order, cancel or sizing call fails the test.
type quoteTradingService struct {
	*reconciliationTradingService
	t          *testing.T
	chain      []*interfaces.OptionContract
	positionOK bool
	positionEr error
	quote      *interfaces.OptionsQuote
	quoteErr   error
	quoteCalls int
	mark       float64
}

func (s *quoteTradingService) GetOptionsChain(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
	return s.chain, nil
}

func (s *quoteTradingService) GetOptionsPosition(_ context.Context, symbol string) (*interfaces.OptionsPosition, error) {
	if s.positionEr != nil {
		return nil, s.positionEr
	}
	if !s.positionOK {
		return nil, errors.New("options position not found: " + symbol)
	}
	return &interfaces.OptionsPosition{Symbol: symbol, Qty: 6, CurrentPrice: s.mark, MarketValue: s.mark * 600}, nil
}

func (s *quoteTradingService) GetOptionsQuote(_ context.Context, symbol string) (*interfaces.OptionsQuote, error) {
	s.quoteCalls++
	return s.quote, s.quoteErr
}

func (s *quoteTradingService) PlaceOrder(context.Context, *interfaces.Order) (*interfaces.OrderResult, error) {
	s.t.Fatal("the exact quote path must never place an order")
	return nil, nil
}

func (s *quoteTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	s.t.Fatal("the exact quote path must never place an options order")
	return nil, nil
}

func (s *quoteTradingService) CancelOrder(context.Context, string) error {
	s.t.Fatal("the exact quote path must never cancel an order")
	return nil
}

func freshQuote() *interfaces.OptionsQuote {
	return &interfaces.OptionsQuote{
		Symbol: heldSymbol, BidPrice: 11.61, BidSize: 126, AskPrice: 11.78, AskSize: 56, LastPrice: 11.7,
		Timestamp: time.Now().Add(-5 * time.Second), MarketDataFeed: "indicative", MarketDataQuality: "testing_only",
	}
}

func newQuoteController(t *testing.T, s *quoteTradingService) *OrderController {
	s.t = t
	s.reconciliationTradingService = &reconciliationTradingService{}
	return NewOrderController(s, nil, nil)
}

var quoteParams = gin.Params{{Key: "symbol", Value: heldSymbol}}

// A held contract that the chain drops (zero Greeks) is still priced by the exact tool, and the chain answer says so honestly.
func TestExactQuotePricesAHeldContractTheChainDrops(t *testing.T) {
	zeroGreeks := &interfaces.OptionContract{Symbol: heldSymbol, ContractType: "put", StrikePrice: 158, Bid: 11.61, Ask: 11.78}
	service := &quoteTradingService{chain: []*interfaces.OptionContract{zeroGreeks}, positionOK: true, quote: freshQuote(), mark: 12.65}
	controller := newQuoteController(t, service)

	recorder, chainBody := getJSON(t, controller.GetOptionsChain, "/x?expiration=2026-12-18&type=put", gin.Params{{Key: "symbol", Value: "NVDA"}})
	if recorder.Code != 200 || chainBody["filtered"] != float64(0) || chainBody["total"] != float64(1) {
		t.Fatalf("the chain must report one usable contract and none returned: %d %s", recorder.Code, recorder.Body.String())
	}
	if chainBody["status"] != "available" || chainBody["message"] != "no usable contracts returned by this request" {
		t.Fatalf("an empty answer must say no usable contracts were returned: %s", recorder.Body.String())
	}
	diag, _ := chainBody["diagnostics"].(map[string]any)
	if diag["dropped_zero_greeks"] != float64(1) || diag["dropped_by_request_filters"] != float64(0) || diag["usable_contracts_before_request_filters"] != float64(1) {
		t.Fatalf("diagnostics must name the layer that removed the contract: %v", diag)
	}

	recorder, body := getJSON(t, controller.GetOptionsQuote, "/x", quoteParams)
	if recorder.Code != 200 || body["status"] != "available" || body["source"] != "exact_contract_snapshot" {
		t.Fatalf("the held contract must be priced exactly: %d %s", recorder.Code, recorder.Body.String())
	}
	if body["bid"] != 11.61 || body["ask"] != 11.78 || body["bid_size"] != float64(126) || body["ask_size"] != float64(56) {
		t.Fatalf("quote values: %s", recorder.Body.String())
	}
	if body["market_data_feed"] != "indicative" || body["market_data_quality"] != "testing_only" {
		t.Fatalf("the honest quality must be kept: %s", recorder.Body.String())
	}
	if _, err := time.Parse(time.RFC3339Nano, body["quote_timestamp"].(string)); err != nil {
		t.Fatalf("quote time: %v", err)
	}
	if age, _ := body["quote_age_seconds"].(float64); age < 0 || age > 60 {
		t.Fatalf("quote age: %v", body["quote_age_seconds"])
	}
}

func TestExactQuoteIsRefusedWhenStaleOrInvalid(t *testing.T) {
	for name, tc := range map[string]struct {
		err      error
		category string
	}{
		"stale":      {errors.New("options quote is stale or invalid for " + heldSymbol), "quote_stale_or_invalid"},
		"not found":  {errors.New("options quote not found for " + heldSymbol), "quote_not_found"},
		"provider":   {errors.New("options quote API error (HTTP 500): boom"), "provider_unavailable"},
		"no payload": {nil, "provider_unavailable"},
	} {
		service := &quoteTradingService{positionOK: true, quoteErr: tc.err, mark: 12.65}
		recorder, body := getJSON(t, newQuoteController(t, service).GetOptionsQuote, "/x", quoteParams)
		if recorder.Code != 503 || body["status"] != "unavailable" || body["category"] != tc.category {
			t.Fatalf("%s: %d %s", name, recorder.Code, recorder.Body.String())
		}
		for _, key := range []string{"bid", "ask", "bid_size", "ask_size", "quote_timestamp"} {
			if _, present := body[key]; present {
				t.Fatalf("%s: a refused quote must carry no price field (%s)", name, key)
			}
		}
	}
}

// The position mark (CurrentPrice) must never appear as a quote, in a success or in a refusal.
func TestExactQuoteNeverReturnsThePositionMark(t *testing.T) {
	const mark = 12.65
	good := &quoteTradingService{positionOK: true, quote: freshQuote(), mark: mark}
	recorder, body := getJSON(t, newQuoteController(t, good).GetOptionsQuote, "/x", quoteParams)
	for _, key := range []string{"current_price", "CurrentPrice", "mark", "market_value", "MarketValue", "last", "last_price"} {
		if _, present := body[key]; present {
			t.Fatalf("the quote answer must not carry %s: %s", key, recorder.Body.String())
		}
	}
	if strings.Contains(recorder.Body.String(), "12.65") {
		t.Fatalf("the position mark leaked into the quote answer: %s", recorder.Body.String())
	}
	stale := &quoteTradingService{positionOK: true, quoteErr: errors.New("options quote is stale or invalid for " + heldSymbol), mark: mark}
	recorder, _ = getJSON(t, newQuoteController(t, stale).GetOptionsQuote, "/x", quoteParams)
	if strings.Contains(recorder.Body.String(), "12.65") {
		t.Fatalf("a refusal must not fall back to the mark: %s", recorder.Body.String())
	}
}

// Held contracts only: nothing is quoted for a contract the account does not hold, and the quote call is never made.
func TestExactQuoteIsRefusedForAContractNotHeld(t *testing.T) {
	service := &quoteTradingService{positionOK: false, quote: freshQuote()}
	recorder, body := getJSON(t, newQuoteController(t, service).GetOptionsQuote, "/x", quoteParams)
	if recorder.Code != 404 || body["status"] != "not_held" || body["category"] != "not_a_held_contract" {
		t.Fatalf("a contract not held must be refused: %d %s", recorder.Code, recorder.Body.String())
	}
	if service.quoteCalls != 0 {
		t.Fatalf("no quote may be read for a contract that is not held (calls=%d)", service.quoteCalls)
	}
	broken := &quoteTradingService{positionEr: errors.New("failed to get positions: boom"), quote: freshQuote()}
	recorder, body = getJSON(t, newQuoteController(t, broken).GetOptionsQuote, "/x", quoteParams)
	if recorder.Code != 503 || body["category"] != "broker_unavailable" || broken.quoteCalls != 0 {
		t.Fatalf("an unverifiable held check must refuse and read nothing: %d %s calls=%d", recorder.Code, recorder.Body.String(), broken.quoteCalls)
	}
	if recorder, body = getJSON(t, newQuoteController(t, &quoteTradingService{positionOK: true, quote: freshQuote()}).GetOptionsQuote, "/x", gin.Params{{Key: "symbol", Value: "  "}}); recorder.Code != 400 || body["category"] != "invalid_symbol" {
		t.Fatalf("a blank symbol must be refused: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestExactQuoteInertModeRefuses(t *testing.T) {
	recorder, body := getJSON(t, NewOrderController(nil, nil, nil).GetOptionsQuote, "/x", quoteParams)
	if recorder.Code != 503 || body["category"] != "provider_unavailable" {
		t.Fatalf("inert mode: %d %s", recorder.Code, recorder.Body.String())
	}
}

// The chain answer for a non-empty result keeps its exact shape (no diagnostics, no message).
func TestChainNonEmptyAnswerShapeIsUnchanged(t *testing.T) {
	live := &interfaces.OptionContract{Symbol: heldSymbol, ContractType: "put", StrikePrice: 158, Bid: 11.61, Ask: 11.78, Delta: -0.9, Gamma: 0.01, Theta: -0.05}
	service := &quoteTradingService{chain: []*interfaces.OptionContract{live}, positionOK: true}
	recorder, body := getJSON(t, newQuoteController(t, service).GetOptionsChain, "/x?expiration=2026-12-18&type=put", gin.Params{{Key: "symbol", Value: "NVDA"}})
	if recorder.Code != 200 || body["filtered"] != float64(1) {
		t.Fatalf("non-empty chain: %d %s", recorder.Code, recorder.Body.String())
	}
	if _, present := body["diagnostics"]; present {
		t.Fatalf("a non-empty answer must not carry diagnostics: %s", recorder.Body.String())
	}
	if _, present := body["message"]; present {
		t.Fatalf("a non-empty answer must not carry a message: %s", recorder.Body.String())
	}
}

// A filter that removes everything is reported as a request-filter drop, not as a provider gap.
func TestChainRequestFiltersAreCountedSeparately(t *testing.T) {
	live := &interfaces.OptionContract{Symbol: heldSymbol, ContractType: "put", StrikePrice: 158, Bid: 11.61, Ask: 11.78, Delta: -0.9, Gamma: 0.01, Theta: -0.05}
	service := &quoteTradingService{chain: []*interfaces.OptionContract{live}, positionOK: true}
	recorder, body := getJSON(t, newQuoteController(t, service).GetOptionsChain, "/x?expiration=2026-12-18&type=put&delta_max=0.5", gin.Params{{Key: "symbol", Value: "NVDA"}})
	diag, _ := body["diagnostics"].(map[string]any)
	if recorder.Code != 200 || body["filtered"] != float64(0) || diag["dropped_by_request_filters"] != float64(1) || diag["dropped_zero_greeks"] != float64(0) {
		t.Fatalf("filter drop must be counted separately: %d %s", recorder.Code, recorder.Body.String())
	}
}
