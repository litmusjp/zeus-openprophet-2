package services

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"prophet-trader/interfaces"
	"strings"
	"testing"
	"time"
)

func TestManagedPositionTrailingStopContract(t *testing.T) {
	stopPrice := 95.0
	stopPercent := 5.0
	takePrice := 110.0
	partial := PartialExitConfig{Enabled: true, Percent: 50, TargetPercent: 10}

	tests := []struct {
		name string
		req  PlaceManagedPositionRequest
		want string
	}{
		{name: "stop price with trailing", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, TrailingStop: true, TrailingPercent: 2}, want: "ok"},
		{name: "stop percent with trailing", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPercent: &stopPercent, TrailingStop: true, TrailingPercent: 2}, want: "ok"},
		{name: "trailing without stop", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), TrailingStop: true, TrailingPercent: 2}, want: "stop-loss"},
		{name: "trailing with take profit", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, TakeProfitPrice: &takePrice, TrailingStop: true, TrailingPercent: 2}, want: "exactly one"},
		{name: "trailing with partial exit", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, PartialExit: &partial, TrailingStop: true, TrailingPercent: 2}, want: "exactly one"},
		{name: "stop loss with take profit", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, TakeProfitPrice: &takePrice}, want: "exactly one"},
		{name: "multiple stop forms", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, StopLossPercent: &stopPercent}, want: "exactly one"},
		{name: "trailing percent missing", req: PlaceManagedPositionRequest{Side: "buy", EntryStrategy: "limit", EntryPrice: ptr(100.0), StopLossPrice: &stopPrice, TrailingStop: true}, want: "trailing_percent"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (&PositionManager{}).validateRequest(&tt.req)
			if tt.want == "ok" {
				if err != nil {
					t.Fatalf("validateRequest() = %v, want valid", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("validateRequest() = %v, want error containing %q", err, tt.want)
			}
		})
	}
}

func ptr(value float64) *float64 { return &value }

func TestMarketClosedErrorIsAssetNeutral(t *testing.T) {
	for _, caller := range []string{"equity", "options"} {
		t.Run(caller, func(t *testing.T) {
			message := (&MarketClosedError{NextOpen: time.Date(2026, 9, 24, 13, 30, 0, 0, time.UTC)}).Error()
			if strings.Contains(message, "options session") || !strings.Contains(message, "regular trading session") {
				t.Fatalf("MarketClosedError() = %q, want asset-neutral regular trading wording", message)
			}
		})
	}
}

func TestManagedPositionNotFoundIsTyped(t *testing.T) {
	pm := &PositionManager{positions: map[string]*ManagedPosition{}}
	_, err := pm.GetManagedPosition("missing")
	var typed *ManagedPositionNotFoundError
	if !errors.As(err, &typed) || typed.PositionID != "missing" {
		t.Fatalf("error = %v, want typed missing-position error", err)
	}
}

func TestRSSDatesAndRealtimeStaleMetadata(t *testing.T) {
	old := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<rss><channel><item><title>Old</title><pubDate>` + old + `</pubDate></item><item><title>Fresh</title><pubDate>Wed, 23 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`))
	}))
	defer server.Close()
	ns := &NewsService{httpClient: server.Client()}
	items, err := ns.fetchRSSFeed(server.URL)
	if err != nil || len(items) != 2 {
		t.Fatalf("fetch = %d, %v", len(items), err)
	}
	if items[0].PublishedAt.IsZero() || items[1].PublishedAt.IsZero() {
		t.Fatalf("supported RSS dates were not parsed: %#v", items)
	}
	marked := markMarketWatchRealtimeStale(items, time.Now())
	if !marked[0].Stale || marked[0].Status != "stale" || marked[0].Realtime {
		t.Fatalf("old realtime item = %#v, want explicit stale non-realtime metadata", marked[0])
	}
}

func TestMarketNewsNormalizesSearchesAndDeduplicates(t *testing.T) {
	queries := []string{}
	ns := &NewsService{searchSymbol: func(symbol string) ([]NewsItem, error) {
		queries = append(queries, symbol)
		if symbol == "TSLA" {
			return []NewsItem{
				{GUID: "tsla-guid-1", Link: "https://news/story", Title: "Story one"},
				{GUID: "tsla-guid-2", Link: "https://news/second", Title: "Shared title"},
				{GUID: "tsla-distinct", Link: "https://news/distinct", Title: "Distinct story"},
			}, nil
		}
		return []NewsItem{
			{GUID: "nvda-guid-1", Link: "https://news/story", Title: "Story one"},
			{GUID: "nvda-guid-2", Link: "https://news/other-second", Title: "  shared   title "},
			{GUID: "nvda-distinct", Link: "https://news/another", Title: "Another distinct story"},
		}, nil
	}}
	items, symbols, err := ns.GetGoogleNewsSearchBySymbols(" tsla, NVDA, tsla, , nvda ")
	if err != nil || strings.Join(symbols, ",") != "TSLA,NVDA" || strings.Join(queries, ",") != "TSLA,NVDA" {
		t.Fatalf("symbols=%v queries=%v err=%v", symbols, queries, err)
	}
	if len(items) != 4 {
		t.Fatalf("got %d items, want GUID/link/title deduplication across symbol searches: %#v", len(items), items)
	}
}

func TestMarketPulseFreshnessKeepsStaleItemsInformational(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	items := markMarketPulseFreshness([]NewsItem{{Title: "fresh", PublishedAt: now.Add(-time.Hour)}, {Title: "old", PublishedAt: now.Add(-3 * time.Hour)}, {Title: "unknown"}}, now)
	if items[0].Status != "current" || items[0].Stale || items[1].Status != "stale" || !items[1].Stale || items[2].StaleReason == "" {
		t.Fatalf("freshness metadata = %#v", items)
	}
}

type analysisDataService struct {
	quote *interfaces.Quote
	bar   *interfaces.Bar
	bars  []*interfaces.Bar
	err   error
}

func (s *analysisDataService) GetHistoricalBars(context.Context, string, time.Time, time.Time, string) ([]*interfaces.Bar, error) {
	return s.bars, s.err
}
func (s *analysisDataService) GetLatestBar(context.Context, string) (*interfaces.Bar, error) {
	if s.bar == nil {
		return nil, errors.New("latest bar unavailable")
	}
	return s.bar, nil
}
func (s *analysisDataService) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return s.quote, nil
}
func (s *analysisDataService) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	return nil, errors.New("not used")
}
func (s *analysisDataService) StreamBars(context.Context, []string) (<-chan *interfaces.Bar, error) {
	return nil, errors.New("not used")
}

func TestStockAnalysisUsesOneReferencePriceAndFallsBack(t *testing.T) {
	svc := &analysisDataService{
		quote: &interfaces.Quote{BidPrice: 99},
		bar:   &interfaces.Bar{Close: 123, Volume: 10},
		bars:  []*interfaces.Bar{{Close: 100, High: 101, Low: 99}, {Close: 120, High: 121, Low: 119}},
	}
	analysis, err := NewStockAnalysisService(svc, nil, nil).AnalyzeStock(context.Background(), "TSLA")
	if err != nil || analysis.CurrentPrice != 120 || analysis.Technical.Price != 120 || analysis.TradeSetup.Entry != 120 || analysis.MarketCap != "Mid to Large-cap (likely $3B-$50B)" {
		t.Fatalf("analysis=%#v err=%v; valid historical daily close should override differing latest bar", analysis, err)
	}
	svc.bar = &interfaces.Bar{Close: math.NaN(), Volume: 10}
	analysis, err = NewStockAnalysisService(svc, nil, nil).AnalyzeStock(context.Background(), "TSLA")
	if err != nil || analysis.CurrentPrice != 120 || analysis.Technical.Price != 120 || analysis.TradeSetup.Entry != 120 {
		t.Fatalf("analysis=%#v err=%v; malformed latest bar must not override valid historical close", analysis, err)
	}
	svc.bar = nil
	analysis, err = NewStockAnalysisService(svc, nil, nil).AnalyzeStock(context.Background(), "TSLA")
	if err != nil || analysis.CurrentPrice != 120 || analysis.Technical.Price != 120 || analysis.TradeSetup.Entry != 120 {
		t.Fatalf("fallback analysis=%#v err=%v; should use latest valid historical close", analysis, err)
	}
	svc.bars = nil
	analysis, err = NewStockAnalysisService(svc, nil, nil).AnalyzeStock(context.Background(), "TSLA")
	if err != nil || analysis.CurrentPrice != 99 || analysis.Technical.Price != 99 || analysis.TradeSetup.Entry != 99 {
		t.Fatalf("quote fallback analysis=%#v err=%v; should use quote only when bars are unavailable", analysis, err)
	}
}

func TestStockAnalysisIgnoresBarsReturnedWithHistoricalError(t *testing.T) {
	svc := &analysisDataService{
		quote: &interfaces.Quote{BidPrice: 99},
		bar:   &interfaces.Bar{Close: 123, High: 124, Low: 122, Volume: 10},
		bars:  []*interfaces.Bar{{Close: 999, High: 1000, Low: 998, Volume: 10}},
		err:   errors.New("historical unavailable"),
	}
	analysis, err := NewStockAnalysisService(svc, nil, nil).AnalyzeStock(context.Background(), "TSLA")
	if err != nil || analysis.CurrentPrice != 123 || analysis.Technical.Price != 123 || analysis.Technical.Trend != "UNKNOWN" {
		t.Fatalf("analysis=%#v err=%v; bars-plus-error must use latest bar only", analysis, err)
	}
}

func TestCalculateTechnicalIndicatorsSkipsNilAndMalformedBars(t *testing.T) {
	svc := NewStockAnalysisService(nil, nil, nil)
	tech := svc.calculateTechnicalIndicators([]*interfaces.Bar{
		nil,
		{Close: math.NaN(), High: 101, Low: 99},
		{Close: 100, High: 99, Low: 101},
		{Close: 101, High: 102, Low: 100, Volume: 10},
	})
	if tech.Price != 101 || tech.Support != 100 || tech.Resistance != 102 || math.IsNaN(tech.Volatility) {
		t.Fatalf("technical indicators=%#v; nil/malformed bars must be skipped safely", tech)
	}
	if empty := svc.calculateTechnicalIndicators([]*interfaces.Bar{nil, {Close: math.NaN()}}); empty != (TechnicalAnalysis{}) {
		t.Fatalf("invalid-only bars produced indicators: %#v", empty)
	}
}

func TestEconomicFeedRetriesAndPreservesEmptyComtrade(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			http.Error(w, "temporary", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":null}`))
	}))
	defer server.Close()
	s := &EconomicFeedsService{httpClient: server.Client()}
	got, err := s.fetchJSON(server.URL)
	if err != nil || attempts != 2 || got["data"] != nil {
		t.Fatalf("fetch = %#v, attempts=%d, err=%v", got, attempts, err)
	}
	var availability *FeedAvailabilityError
	if err := classifyFeedError(strings.NewReader(""), "x"); err == nil || !errors.As(err, &availability) {
		t.Fatalf("malformed/availability error = %v, want typed availability", err)
	}
}
