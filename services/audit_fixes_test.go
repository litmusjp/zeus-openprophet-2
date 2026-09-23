package services

import (
	"errors"
	"net/http"
	"net/http/httptest"
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
