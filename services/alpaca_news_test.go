package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

func newsService(serverURL string, client *http.Client) *AlpacaTradingService {
	return &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: serverURL, optionsSnapshotHTTP: client}
}

func newsWindow() (time.Time, time.Time) {
	end := time.Date(2026, 11, 6, 15, 0, 0, 0, time.UTC)
	return end.Add(-36 * time.Hour), end
}

const newsPage = `{"news":[
 {"id":115290414,"headline":"NVIDIA Plans to Convert Telecom Facilities into AI Data Centers","source":"fiscal.ai","author":"fiscal.ai","symbols":["NVDA"],"url":"https://example.test/a","created_at":"2026-11-06T00:01:31Z","updated_at":"2026-11-06T00:01:32Z","summary":"s1"},
 {"id":115290999,"headline":"Apple beats estimates","source":"benzinga","author":"A B","symbols":["AAPL","SPY"],"url":"https://example.test/b","created_at":"2026-11-05T21:00:00Z","updated_at":"2026-11-06T02:00:00Z","summary":"` + "x" + `"},
 {"id":115290414,"headline":"duplicate copy of the first","source":"benzinga","symbols":["NVDA"],"created_at":"2026-11-06T00:01:31Z","updated_at":"2026-11-06T00:01:33Z"}
],"next_page_token":"TOKEN123"}`

func TestGetAlpacaNewsKeepsIdentitySourceTimesAndPagination(t *testing.T) {
	var gotPath, gotQuery, gotKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotKey = r.URL.Path, r.URL.RawQuery, r.Header.Get("APCA-API-KEY-ID")
		_, _ = w.Write([]byte(newsPage))
	}))
	defer server.Close()
	start, end := newsWindow()
	got, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL", "NVDA", "SPY"}, Start: start, End: end})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1beta1/news" || gotKey != "key" {
		t.Fatalf("path=%s key=%s", gotPath, gotKey)
	}
	for _, want := range []string{"symbols=AAPL%2CNVDA%2CSPY", "limit=20", "sort=desc", "include_content=false", "start=2026-11-05T03%3A00%3A00Z", "end=2026-11-06T15%3A00%3A00Z"} {
		if !strings.Contains(gotQuery, want) {
			t.Fatalf("query %q is missing %q", gotQuery, want)
		}
	}
	if got.Provider != "alpaca" || got.Status != "available" || got.Count != 2 || got.DuplicatesRemoved != 1 || got.Limit != 20 {
		t.Fatalf("result = %+v", got)
	}
	if !got.HasMore || got.NextPageToken != "TOKEN123" {
		t.Fatalf("pagination must be reported honestly: %+v", got)
	}
	first := got.Articles[0]
	if first.ID != 115290414 || first.Source != "fiscal.ai" || first.CreatedAt != "2026-11-06T00:01:31Z" || first.UpdatedAt != "2026-11-06T00:01:32Z" || first.URL != "https://example.test/a" || len(first.Symbols) != 1 {
		t.Fatalf("identity and both clocks must be preserved: %+v", first)
	}
	second := got.Articles[1]
	if second.CreatedAt == second.UpdatedAt || second.Source != "benzinga" {
		t.Fatalf("created_at and updated_at stay distinct: %+v", second)
	}
	if got.FetchedAt == "" || got.WindowStart != "2026-11-05T03:00:00Z" || got.WindowEnd != "2026-11-06T15:00:00Z" {
		t.Fatalf("window and fetched_at: %+v", got)
	}
}

func TestGetAlpacaNewsEmptyIsNotAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"news":[],"next_page_token":null}`))
	}))
	defer server.Close()
	start, end := newsWindow()
	got, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end, Limit: 5})
	if err != nil || got.Status != "empty" || got.Count != 0 || got.HasMore || got.Limit != 5 || got.Articles == nil {
		t.Fatalf("empty = %+v err=%v", got, err)
	}
}

func TestGetAlpacaNewsPageTokenIsForwarded(t *testing.T) {
	var query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"news":[],"next_page_token":null}`))
	}))
	defer server.Close()
	start, end := newsWindow()
	if _, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end, PageToken: "TOKEN123"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(query, "page_token=TOKEN123") {
		t.Fatalf("query = %s", query)
	}
}

func TestGetAlpacaNewsClassifiesProviderFailures(t *testing.T) {
	for _, tc := range []struct {
		status   int
		category string
	}{{401, "permission"}, {403, "permission"}, {429, "rate_limited"}, {500, "provider_unavailable"}, {503, "provider_unavailable"}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", tc.status) }))
		start, end := newsWindow()
		_, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end})
		server.Close()
		var newsErr *AlpacaNewsError
		if !errors.As(err, &newsErr) || newsErr.Category != tc.category {
			t.Fatalf("status %d: got %v, want category %s", tc.status, err, tc.category)
		}
		if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "key") {
			t.Fatalf("an error must never carry credentials: %v", err)
		}
	}
}

func TestGetAlpacaNewsTimeoutAndGarbageAreUnavailableNotEmpty(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()
	start, end := newsWindow()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := newsService(slow.URL, slow.Client()).GetAlpacaNews(ctx, AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end})
	var newsErr *AlpacaNewsError
	if !errors.As(err, &newsErr) || newsErr.Category != "timeout" {
		t.Fatalf("slow provider: %v", err)
	}
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("not json")) }))
	defer garbage.Close()
	_, err = newsService(garbage.URL, garbage.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end})
	if !errors.As(err, &newsErr) || newsErr.Category != "provider_unavailable" {
		t.Fatalf("garbage body must not look like an empty result: %v", err)
	}
}

func TestGetAlpacaNewsValidatesInput(t *testing.T) {
	s := newsService("http://unused", nil)
	start, end := newsWindow()
	if _, err := s.GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: end, End: start}); err == nil {
		t.Fatal("an inverted window must be rejected")
	}
	if _, err := s.GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end, Limit: 500}); err == nil {
		t.Fatal("an oversized limit must be rejected")
	}
}

func TestAlpacaNewsTextIsBounded(t *testing.T) {
	long := strings.Repeat("é", 1000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"news":[{"id":1,"headline":"` + long + `","source":"benzinga","symbols":[],"created_at":"2026-11-06T00:00:00Z","updated_at":"2026-11-06T00:00:00Z","summary":"` + long + `"}]}`))
	}))
	defer server.Close()
	start, end := newsWindow()
	got, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end})
	if err != nil || len([]rune(got.Articles[0].Headline)) > alpacaNewsTextLimit+1 || len([]rune(got.Articles[0].Summary)) > alpacaNewsTextLimit+1 {
		t.Fatalf("text must be bounded: err=%v", err)
	}
}

func TestGetAlpacaNewsRejectsResponsesWithoutANewsArray(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"news":null}`, `{"next_page_token":null}`, `[]`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		start, end := newsWindow()
		_, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Symbols: []string{"AAPL"}, Start: start, End: end})
		server.Close()
		var newsErr *AlpacaNewsError
		if !errors.As(err, &newsErr) || newsErr.Category != "provider_unavailable" {
			t.Fatalf("body %s must be provider_unavailable, got %v", body, err)
		}
		if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), body) {
			t.Fatalf("error must be sanitized: %v", err)
		}
	}
}

func TestGetAlpacaNewsWithoutSymbolsIsMarketWide(t *testing.T) {
	var query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		_, _ = w.Write([]byte(newsPage))
	}))
	defer server.Close()
	start, end := newsWindow()
	got, err := newsService(server.URL, server.Client()).GetAlpacaNews(context.Background(), AlpacaNewsRequest{Start: start, End: end, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(query, "symbols=") {
		t.Fatalf("a market-wide read must not send a symbols filter: %s", query)
	}
	for _, want := range []string{"limit=50", "sort=desc", "include_content=false"} {
		if !strings.Contains(query, want) {
			t.Fatalf("query %q is missing %q", query, want)
		}
	}
	if got.Symbols == nil || len(got.Symbols) != 0 || got.Status != "available" || got.Count != 2 || got.DuplicatesRemoved != 1 {
		t.Fatalf("market-wide result = %+v", got)
	}
}
