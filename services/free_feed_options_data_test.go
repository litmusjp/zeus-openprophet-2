package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

func TestOptionsChainPagesAndExactQuoteUseIndicativeFeed(t *testing.T) {
	symbol := "AAPL261106C00200000"
	var chainPages int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("feed") != "indicative" {
			t.Errorf("feed=%q", r.URL.Query().Get("feed"))
		}
		if r.URL.Path != "/v1beta1/options/snapshots/AAPL" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.URL.Query().Get("expiration_date") != "2026-11-06" {
			t.Errorf("query=%s", r.URL.RawQuery)
		}
		if chainPages == 0 {
			if r.URL.Query().Get("page_token") != "" {
				t.Errorf("first page token=%s", r.URL.Query().Get("page_token"))
			}
			chainPages++
			fmt.Fprint(w, `{"snapshots":{},"next_page_token":"next"}`)
			return
		}
		if r.URL.Query().Get("page_token") != "next" {
			t.Errorf("second page query=%s", r.URL.RawQuery)
		}
		chainPages++
		fmt.Fprint(w, `{"snapshots":{}}`)
	}))
	defer server.Close()
	s := &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: server.URL, optionsSnapshotHTTP: server.Client()}
	if _, err := s.GetOptionsChain(context.Background(), "AAPL", time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if chainPages != 2 {
		t.Fatalf("pages=%d", chainPages)
	}

	quoteServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta1/options/snapshots" {
			t.Errorf("exact quote path=%s", r.URL.Path)
		}
		if r.URL.Query().Get("symbols") != symbol || r.URL.Query().Get("feed") != "indicative" {
			t.Errorf("exact quote query=%s", r.URL.RawQuery)
		}
		fmt.Fprintf(w, `{"snapshots":{%q:{"latestQuote":{"bp":1.2,"ap":1.4,"bs":2,"as":3,"t":%q},"latestTrade":{"p":1.3,"s":1,"t":%q}}}}`, symbol, time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))
	}))
	defer quoteServer.Close()
	s.optionsSnapshotBaseURL, s.optionsSnapshotHTTP = quoteServer.URL, quoteServer.Client()
	quote, err := s.GetOptionsQuote(context.Background(), symbol)
	if err != nil {
		t.Fatal(err)
	}
	if quote.MarketDataFeed != "indicative" || quote.MarketDataQuality != "testing_only" {
		t.Fatalf("misleading quote feed metadata: %#v", quote)
	}
}

func TestSecondarySnapshotUsesDocumentedExactSymbolQuery(t *testing.T) {
	symbol := "AAPL261106C00200000"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta1/options/snapshots" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.URL.Query().Get("symbols") != symbol || r.URL.Query().Get("feed") != "indicative" {
			t.Errorf("query=%s", r.URL.RawQuery)
		}
		fmt.Fprintf(w, `{"snapshots":{%q:{"latestQuote":{"bp":1,"ap":2,"t":%q}}}}`, symbol, time.Now().UTC().Format(time.RFC3339Nano))
	}))
	defer server.Close()
	s := &AlpacaOptionsDataService{baseURL: server.URL, client: server.Client(), logger: logrus.New()}
	contract, err := s.GetOptionSnapshot(context.Background(), symbol)
	if err != nil {
		t.Fatal(err)
	}
	if contract.Symbol != symbol {
		t.Fatalf("symbol=%s", contract.Symbol)
	}
	if contract.MarketDataFeed != "indicative" || contract.MarketDataQuality != "testing_only" {
		t.Fatalf("misleading option feed metadata: %#v", contract)
	}
}
