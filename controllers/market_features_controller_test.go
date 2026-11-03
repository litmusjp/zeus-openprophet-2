package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/interfaces"
	"prophet-trader/services"
)

type featureBars struct {
	*recordingBars
	fail map[string]bool
}

func (f *featureBars) GetHistoricalBars(_ context.Context, symbol string, _, _ time.Time, _ string) ([]*interfaces.Bar, error) {
	if f.fail[symbol] {
		return nil, errors.New("provider down")
	}
	loc, _ := time.LoadLocation("America/New_York")
	var bars []*interfaces.Bar
	day := time.Date(2026, 9, 1, 0, 0, 0, 0, loc)
	for len(bars) < 30 {
		if day.Weekday() != time.Saturday && day.Weekday() != time.Sunday {
			i := float64(len(bars))
			bars = append(bars, &interfaces.Bar{Symbol: symbol, Timestamp: day, Open: 100 + i, High: 101 + i, Low: 99 + i, Close: 100.5 + i, Volume: int64(1000 + len(bars))})
		}
		day = day.AddDate(0, 0, 1)
	}
	return bars, nil
}

func getJSON(t *testing.T, handler gin.HandlerFunc, path string, params gin.Params) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = params
	ctx.Request = httptest.NewRequest(http.MethodGet, path, nil)
	handler(ctx)
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder, body
}

func TestDailyFeaturesValidationAndPartialFailure(t *testing.T) {
	controller := NewOrderController(nil, &featureBars{recordingBars: &recordingBars{}, fail: map[string]bool{"QQQ": true}}, nil)
	for _, path := range []string{
		"/x", "/x?symbols=", "/x?symbols=SPY,bad%20sym",
		"/x?symbols=" + distinctSymbols(26),
	} {
		if recorder, _ := getJSON(t, controller.HandleGetDailyFeatures, path, nil); recorder.Code != 400 {
			t.Fatalf("%s should be rejected with 400, got %d", path, recorder.Code)
		}
	}
	recorder, body := getJSON(t, controller.HandleGetDailyFeatures, "/x?symbols=spy,QQQ,spy", nil)
	if recorder.Code != 200 || body["count"].(float64) != 2 {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	features := body["features"].([]any)
	spy, qqq := features[0].(map[string]any), features[1].(map[string]any)
	if spy["symbol"] != "SPY" || spy["sma20"] == nil || spy["error"] != nil {
		t.Fatalf("SPY features = %v", spy)
	}
	if qqq["symbol"] != "QQQ" || qqq["error"] == nil {
		t.Fatalf("a failing symbol must carry an error and not fail the batch: %v", qqq)
	}
	if recorder, _ := getJSON(t, NewOrderController(nil, nil, nil).HandleGetDailyFeatures, "/x?symbols=SPY", nil); recorder.Code != 503 {
		t.Fatalf("inert mode should be 503, got %d", recorder.Code)
	}
}

type expirationTradingService struct {
	*reconciliationTradingService
	err error
}

func (s *expirationTradingService) GetOptionExpirations(_ context.Context, underlying string, minDTE, maxDTE int) ([]services.OptionExpiration, error) {
	if s.err != nil {
		return nil, s.err
	}
	return []services.OptionExpiration{{Date: "2026-12-18", DTE: minDTE + 10}}, nil
}

func TestOptionExpirationsEndpoint(t *testing.T) {
	controller := NewOrderController(&expirationTradingService{reconciliationTradingService: &reconciliationTradingService{}}, nil, nil)
	recorder, body := getJSON(t, controller.GetOptionExpirations, "/x?min_dte=14&max_dte=60", gin.Params{{Key: "symbol", Value: "spy"}})
	if recorder.Code != 200 || body["symbol"] != "SPY" || body["count"].(float64) != 1 {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder, _ := getJSON(t, controller.GetOptionExpirations, "/x?min_dte=abc", gin.Params{{Key: "symbol", Value: "SPY"}}); recorder.Code != 400 {
		t.Fatalf("bad min_dte should be 400, got %d", recorder.Code)
	}
	if recorder, _ := getJSON(t, controller.GetOptionExpirations, "/x", gin.Params{{Key: "symbol", Value: "bad symbol"}}); recorder.Code != 400 {
		t.Fatalf("bad symbol should be 400, got %d", recorder.Code)
	}
	failing := NewOrderController(&expirationTradingService{reconciliationTradingService: &reconciliationTradingService{}, err: errors.New("expiration lookup incomplete")}, nil, nil)
	if recorder, _ := getJSON(t, failing.GetOptionExpirations, "/x", gin.Params{{Key: "symbol", Value: "SPY"}}); recorder.Code != 503 {
		t.Fatalf("provider failure should be 503, got %d", recorder.Code)
	}
	plain := NewOrderController(&reconciliationTradingService{}, nil, nil)
	if recorder, _ := getJSON(t, plain.GetOptionExpirations, "/x", gin.Params{{Key: "symbol", Value: "SPY"}}); recorder.Code != 503 {
		t.Fatalf("service without expirations support should be 503, got %d", recorder.Code)
	}
}

type costChainService struct {
	*reconciliationTradingService
}

func (s *costChainService) GetOptionsChain(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
	return []*interfaces.OptionContract{
		{Symbol: "XLF261218C00050000", Delta: 0.55, Gamma: 0.1, Theta: -0.01, Bid: 1.9, Ask: 2.0},
		{Symbol: "XLF261218C00052000", Delta: 0.40, Gamma: 0.1, Theta: -0.01, Bid: 0.9, Ask: 1.0},
		{Symbol: "XLF261218C00054000", Delta: 0.25, Gamma: 0.1, Theta: -0.01, Bid: 0.2, Ask: 0.3},
	}, nil
}

func TestOptionsChainMaxCostFiltersByAskTimes100(t *testing.T) {
	controller := NewOrderController(&costChainService{reconciliationTradingService: &reconciliationTradingService{}}, nil, nil)
	recorder, body := getJSON(t, controller.GetOptionsChain, "/x?expiration=2026-12-18&max_cost=150&type=call", gin.Params{{Key: "symbol", Value: "XLF"}})
	if recorder.Code != 200 || body["filtered"].(float64) != 2 {
		t.Fatalf("max_cost=150 should keep asks <= 1.50: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder, body = getJSON(t, controller.GetOptionsChain, "/x?expiration=2026-12-18", gin.Params{{Key: "symbol", Value: "XLF"}})
	if recorder.Code != 200 || body["filtered"].(float64) != 3 {
		t.Fatalf("without max_cost nothing is filtered: %s", recorder.Body.String())
	}
	if recorder, _ := getJSON(t, controller.GetOptionsChain, "/x?expiration=2026-12-18&max_cost=-5", gin.Params{{Key: "symbol", Value: "XLF"}}); recorder.Code != 400 {
		t.Fatalf("non-positive max_cost should be 400, got %d", recorder.Code)
	}
}

func TestEarningsEndpointValidatesAndReturnsLookup(t *testing.T) {
	earningsCalendarOnce.Do(func() {})
	previous := earningsCalendar
	earningsCalendar = services.NewEarningsCalendarWithFetcher(func(_ context.Context, date string) ([]services.EarningsEvent, error) {
		return nil, nil
	}, time.Now)
	t.Cleanup(func() { earningsCalendar = previous })
	controller := NewOrderController(nil, nil, nil)
	for _, path := range []string{"/x", "/x?symbols=AAPL&days=0", "/x?symbols=AAPL&days=99", "/x?symbols=A%20B"} {
		if recorder, _ := getJSON(t, controller.HandleGetEarnings, path, nil); recorder.Code != 400 {
			t.Fatalf("%s should be 400, got %d", path, recorder.Code)
		}
	}
	recorder, body := getJSON(t, controller.HandleGetEarnings, "/x?symbols=spy&days=7", nil)
	results, _ := body["results"].([]any)
	if recorder.Code != 200 || body["complete"] != true || len(results) != 1 || results[0].(map[string]any)["status"] != "none_found_in_window" {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func distinctSymbols(n int) string {
	names := make([]string, 0, n)
	for i := 0; i < n; i++ {
		names = append(names, string(rune('A'+i/26))+string(rune('A'+i%26)))
	}
	return strings.Join(names, ",")
}

type sipBars struct {
	*featureBars
	feed string
}

func (s *sipBars) GetHistoricalBarsWithFeed(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, string, error) {
	bars, err := s.featureBars.GetHistoricalBars(ctx, symbol, start, end, timeframe)
	return bars, s.feed, err
}

func TestResponsesReportTheFeedThatServedTheBars(t *testing.T) {
	data := &sipBars{featureBars: &featureBars{recordingBars: &recordingBars{}}, feed: "sip"}
	controller := NewOrderController(nil, data, nil)

	_, body := getJSON(t, controller.HandleGetDailyFeatures, "/x?symbols=SPY", nil)
	first := body["features"].([]any)[0].(map[string]any)
	if first["feed"] != "sip" {
		t.Fatalf("daily features feed = %v", first["feed"])
	}

	_, bars := getJSON(t, controller.HandleGetBars, "/x?start=2026-09-01&end=2026-10-01&timeframe=1Day", gin.Params{{Key: "symbol", Value: "SPY"}})
	if bars["feed"] != "sip" {
		t.Fatalf("bars feed = %v", bars["feed"])
	}
	if note, _ := bars["completeness_note"].(string); !strings.Contains(note, "consolidated") {
		t.Fatalf("note should describe SIP data: %q", note)
	}

	data.feed = "iex"
	_, bars = getJSON(t, controller.HandleGetBars, "/x?start=2026-09-01&end=2026-10-01&timeframe=1Day", gin.Params{{Key: "symbol", Value: "SPY"}})
	if note, _ := bars["completeness_note"].(string); bars["feed"] != "iex" || !strings.Contains(note, "IEX-only") {
		t.Fatalf("iex response = %v", bars)
	}
}
