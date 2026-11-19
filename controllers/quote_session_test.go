package controllers

import (
	"context"
	"fmt"
	"errors"
	"math"
	"testing"
	"time"

	"prophet-trader/interfaces"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/gin-gonic/gin"
)

func ny(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	return loc
}

func closeTo(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-6 {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}

func TestSessionContextWithTodaysBar(t *testing.T) {
	loc := ny(t)
	now := time.Date(2026, 11, 5, 9, 45, 0, 0, loc)
	bars := []*interfaces.Bar{
		{Timestamp: time.Date(2026, 11, 3, 0, 0, 0, 0, loc), Open: 750, Close: 754.35},
		{Timestamp: time.Date(2026, 11, 4, 0, 0, 0, 0, loc), Open: 762.99, Close: 766.81},
		{Timestamp: time.Date(2026, 11, 5, 0, 0, 0, 0, loc), Open: 765.47, Close: 766.0}, // forming
	}
	trade := &interfaces.Trade{Price: 768.0, Timestamp: now}
	got := buildSessionContext(bars, "sip", trade, now, loc)
	if got.Status != "ok" || got.SessionDate != "2026-11-05" || got.BarsFeed != "sip" {
		t.Fatalf("session = %+v", got)
	}
	closeTo(t, "daily_open", got.DailyOpen, 765.47)
	closeTo(t, "previous_close", got.PreviousClose, 766.81)
	if got.PreviousCloseDate != "2026-11-04" {
		t.Fatalf("previous close date = %s", got.PreviousCloseDate)
	}
	closeTo(t, "change_from_open", got.ChangeFromOpenPct, math.Round((768.0/765.47-1)*10000)/100)
	closeTo(t, "change_from_previous_close", got.ChangeFromPrevClosePct, math.Round((768.0/766.81-1)*10000)/100)
	// a trade BELOW the open gives a negative change from the open
	below := buildSessionContext(bars, "sip", &interfaces.Trade{Price: 760.0, Timestamp: now}, now, loc)
	if below.ChangeFromOpenPct == nil || *below.ChangeFromOpenPct >= 0 {
		t.Fatalf("a price under the open must be negative: %+v", below.ChangeFromOpenPct)
	}
}

func TestSessionContextBeforeTodaysBarExistsKeepsOpenUnknown(t *testing.T) {
	loc := ny(t)
	now := time.Date(2026, 11, 5, 9, 29, 0, 0, loc)
	bars := []*interfaces.Bar{
		{Timestamp: time.Date(2026, 11, 3, 0, 0, 0, 0, loc), Open: 750, Close: 754.35},
		{Timestamp: time.Date(2026, 11, 4, 0, 0, 0, 0, loc), Open: 762.99, Close: 766.81},
	}
	got := buildSessionContext(bars, "sip", &interfaces.Trade{Price: 767}, now, loc)
	if got.Status != "partial" || got.DailyOpen != nil || got.ChangeFromOpenPct != nil {
		t.Fatalf("yesterday's open must never stand in for today's: %+v", got)
	}
	closeTo(t, "previous_close", got.PreviousClose, 766.81)
	closeTo(t, "change_from_previous_close", got.ChangeFromPrevClosePct, math.Round((767.0/766.81-1)*10000)/100)
}

func TestSessionContextUnavailableWhenNoBarsOrTrade(t *testing.T) {
	loc := ny(t)
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, loc)
	if got := buildSessionContext(nil, "iex", nil, now, loc); got.Status != "unavailable" || got.DailyOpen != nil || got.PreviousClose != nil {
		t.Fatalf("empty = %+v", got)
	}
	bars := []*interfaces.Bar{{Timestamp: time.Date(2026, 11, 5, 0, 0, 0, 0, loc), Open: 100, Close: 101}}
	got := buildSessionContext(bars, "sip", nil, now, loc)
	if got.Status != "partial" || got.ChangeFromOpenPct != nil || got.LastTradePrice != nil {
		t.Fatalf("without a trade no change is computed: %+v", got)
	}
	future := []*interfaces.Bar{{Timestamp: time.Date(2026, 11, 9, 0, 0, 0, 0, loc), Open: 100, Close: 101}}
	if got := buildSessionContext(future, "sip", &interfaces.Trade{Price: 100}, now, loc); got.Status != "unavailable" {
		t.Fatalf("a bar dated after today is unusable: %+v", got)
	}
}

type sessionQuoteData struct {
	quote *interfaces.Quote
	trade *interfaces.Trade
	bars  []*interfaces.Bar
	err   error
}

func (d *sessionQuoteData) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return d.quote, nil
}
func (d *sessionQuoteData) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	return d.trade, nil
}
func (d *sessionQuoteData) GetHistoricalBars(context.Context, string, time.Time, time.Time, string) ([]*interfaces.Bar, error) {
	return d.bars, d.err
}
func (d *sessionQuoteData) GetLatestBar(context.Context, string) (*interfaces.Bar, error) {
	return nil, nil
}
func (d *sessionQuoteData) StreamBars(context.Context, []string) (<-chan *interfaces.Bar, error) {
	return nil, nil
}

func TestQuoteEndpointKeepsOriginalFieldsAndNeverFailsOnSessionErrors(t *testing.T) {
	quote := &interfaces.Quote{Symbol: "SPY", BidPrice: 100, AskPrice: 100.02, Timestamp: time.Now()}
	trade := &interfaces.Trade{Price: 100.01, Size: 10, Timestamp: time.Now()}

	failing := NewOrderController(nil, &sessionQuoteData{quote: quote, trade: trade, err: errors.New("bars down")}, nil)
	recorder, body := getJSON(t, failing.HandleGetQuote, "/x", gin.Params{{Key: "symbol", Value: "SPY"}})
	if recorder.Code != 200 || body["quote_flag"] != "ok" || body["last_trade"] == nil {
		t.Fatalf("a session failure must not change the quote: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	session, ok := body["session"].(map[string]interface{})
	if !ok || session["status"] != "unavailable" {
		t.Fatalf("session block should say unavailable: %s", recorder.Body.String())
	}
	if _, has := session["daily_open"]; has {
		t.Fatalf("an unavailable session must not invent an open: %v", session)
	}

	loc := ny(t)
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	working := NewOrderController(nil, &sessionQuoteData{quote: quote, trade: trade, bars: []*interfaces.Bar{
		{Timestamp: today.AddDate(0, 0, -1), Open: 99, Close: 99.5},
		{Timestamp: today, Open: 99.8, Close: 100},
	}}, nil)
	recorder, body = getJSON(t, working.HandleGetQuote, "/x", gin.Params{{Key: "symbol", Value: "SPY"}})
	session, _ = body["session"].(map[string]interface{})
	if recorder.Code != 200 || session == nil || session["status"] != "ok" || session["daily_open"].(float64) != 99.8 || session["previous_close"].(float64) != 99.5 {
		t.Fatalf("session = %v body=%s", session, recorder.Body.String())
	}
	if body["Symbol"] != "SPY" || body["BidPrice"].(float64) != 100 {
		t.Fatalf("original quote fields must be preserved: %s", recorder.Body.String())
	}
}

type blockingBarsData struct {
	*sessionQuoteData
	release chan struct{}
}

func (d *blockingBarsData) GetHistoricalBars(context.Context, string, time.Time, time.Time, string) ([]*interfaces.Bar, error) {
	<-d.release // a provider that ignores the context and answers far too slowly
	return nil, nil
}

func TestSlowSessionEnrichmentDoesNotDelayTheQuote(t *testing.T) {
	previous := quoteSessionTimeout
	quoteSessionTimeout = 80 * time.Millisecond
	defer func() { quoteSessionTimeout = previous }()
	release := make(chan struct{})
	defer close(release)
	quote := &interfaces.Quote{Symbol: "SPY", BidPrice: 100, AskPrice: 100.02, Timestamp: time.Now()}
	trade := &interfaces.Trade{Price: 100.01, Size: 10, Timestamp: time.Now()}
	controller := NewOrderController(nil, &blockingBarsData{sessionQuoteData: &sessionQuoteData{quote: quote, trade: trade}, release: release}, nil)
	started := time.Now()
	recorder, body := getJSON(t, controller.HandleGetQuote, "/x", gin.Params{{Key: "symbol", Value: "SPY"}})
	elapsed := time.Since(started)
	if elapsed > 2*time.Second {
		t.Fatalf("the quote waited %v for a slow provider; the enrichment deadline must be enforced", elapsed)
	}
	session, _ := body["session"].(map[string]interface{})
	if recorder.Code != 200 || body["quote_flag"] != "ok" || body["Symbol"] != "SPY" || body["last_trade"] == nil {
		t.Fatalf("the original quote must be intact: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if session == nil || session["status"] != "unavailable" {
		t.Fatalf("session should be unavailable after the timeout: %s", recorder.Body.String())
	}
	if _, has := session["daily_open"]; has {
		t.Fatalf("a timed-out session must not invent an open: %v", session)
	}
}

type quoteErrData struct {
	sessionQuoteData
	quoteErr error
}

func (d *quoteErrData) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return nil, d.quoteErr
}

// A typed provider 400 is invalid input (400, one attempt for the caller); every other quote failure stays a 500 so genuine
// transient-server retries are unchanged. Text that merely contains "400" is never treated as a typed 400.
func TestQuoteEndpointMapsTypedProviderBadRequestToInvalidInput(t *testing.T) {
	params := gin.Params{{Key: "symbol", Value: "AMD261218P00500000"}}
	typed := &alpaca.APIError{StatusCode: 400, Code: 40010001, Message: "invalid symbol: AMD261218P00500000"}
	wrapped := fmt.Errorf("failed to get latest quote: %w", typed)
	recorder, body := getJSON(t, NewOrderController(nil, &quoteErrData{quoteErr: wrapped}, nil).HandleGetQuote, "/x", params)
	if recorder.Code != 400 || body["status"] != "invalid_request" || body["category"] != "invalid_symbol" {
		t.Fatalf("typed provider 400 must be invalid input: %d %s", recorder.Code, recorder.Body.String())
	}
	server := fmt.Errorf("failed to get latest quote: %w", &alpaca.APIError{StatusCode: 503, Code: 50310000, Message: "unavailable"})
	if recorder, _ = getJSON(t, NewOrderController(nil, &quoteErrData{quoteErr: server}, nil).HandleGetQuote, "/x", params); recorder.Code != 500 {
		t.Fatalf("a provider 5xx must stay a 500: %d", recorder.Code)
	}
	textOnly := errors.New("failed to get latest quote: code=400, message=invalid symbol (HTTP 400)")
	if recorder, _ = getJSON(t, NewOrderController(nil, &quoteErrData{quoteErr: textOnly}, nil).HandleGetQuote, "/x", params); recorder.Code != 500 {
		t.Fatalf("untyped text containing 400 must not be trusted: %d", recorder.Code)
	}
}
