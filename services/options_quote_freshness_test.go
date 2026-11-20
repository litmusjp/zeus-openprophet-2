package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

// Nov 20 QA B01: the exact-contract quote time is the time of the latest QUOTE. A missing quote time is never repaired from the latest trade
// time. These run the real AlpacaTradingService.GetOptionsQuote against a loopback snapshot server.
const exactQuoteSymbol = "NVDA261218P00158000"

func exactQuoteService(t *testing.T, quoteTime, tradeTime string, bid, ask float64) (*AlpacaTradingService, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("symbols") != exactQuoteSymbol {
			t.Errorf("exact quote query=%s", r.URL.RawQuery)
		}
		quote := fmt.Sprintf(`"bp":%v,"ap":%v,"bs":126,"as":56`, bid, ask)
		if quoteTime != "" {
			quote += fmt.Sprintf(`,"t":%q`, quoteTime)
		}
		trade := `"p":11.7,"s":1`
		if tradeTime != "" {
			trade += fmt.Sprintf(`,"t":%q`, tradeTime)
		}
		fmt.Fprintf(w, `{"snapshots":{%q:{"latestQuote":{%s},"latestTrade":{%s}}}}`, exactQuoteSymbol, quote, trade)
	}))
	service := &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: server.URL, optionsSnapshotHTTP: server.Client()}
	return service, server.Close
}

func stamp(offset time.Duration) string { return time.Now().UTC().Add(offset).Format(time.RFC3339Nano) }

func TestExactQuoteFreshQuoteTimeSucceedsAndKeepsTheQuoteTime(t *testing.T) {
	quoteTime := time.Now().UTC().Add(-5 * time.Second)
	service, closeServer := exactQuoteService(t, quoteTime.Format(time.RFC3339Nano), stamp(0), 11.61, 11.78)
	defer closeServer()
	quote, err := service.GetOptionsQuote(context.Background(), exactQuoteSymbol)
	if err != nil || quote == nil {
		t.Fatalf("a fresh quote must succeed: %v", err)
	}
	if quote.BidPrice != 11.61 || quote.AskPrice != 11.78 || quote.BidSize != 126 || quote.AskSize != 56 {
		t.Fatalf("quote values: %+v", quote)
	}
	if !quote.Timestamp.Equal(quoteTime.Truncate(time.Nanosecond)) && quote.Timestamp.Sub(quoteTime) > time.Millisecond {
		t.Fatalf("the returned time must be the QUOTE time %s, got %s", quoteTime, quote.Timestamp)
	}
	if quote.MarketDataFeed != "indicative" || quote.MarketDataQuality != "testing_only" {
		t.Fatalf("honest quality must be kept: %+v", quote)
	}
}

func TestExactQuoteMissingQuoteTimeWithFreshTradeIsRefused(t *testing.T) {
	for name, tradeTime := range map[string]string{"fresh trade time": stamp(0), "no trade time either": ""} {
		service, closeServer := exactQuoteService(t, "", tradeTime, 11.61, 11.78)
		quote, err := service.GetOptionsQuote(context.Background(), exactQuoteSymbol)
		closeServer()
		if quote != nil || !errors.Is(err, ErrOptionsQuoteStaleOrInvalid) {
			t.Fatalf("%s: an undated quote must be refused, got quote=%+v err=%v", name, quote, err)
		}
		if !strings.Contains(err.Error(), exactQuoteSymbol) || !strings.HasPrefix(err.Error(), "options quote is stale or invalid for ") {
			t.Fatalf("%s: refusal text: %v", name, err)
		}
	}
}

func TestExactQuoteOldQuoteTimeWithFreshTradeIsRefused(t *testing.T) {
	for name, offset := range map[string]time.Duration{"ten minutes old": -10 * time.Minute, "just past the limit": -(brokerQuoteMaxAge + 5*time.Second)} {
		service, closeServer := exactQuoteService(t, stamp(offset), stamp(0), 11.61, 11.78)
		quote, err := service.GetOptionsQuote(context.Background(), exactQuoteSymbol)
		closeServer()
		if quote != nil || !errors.Is(err, ErrOptionsQuoteStaleOrInvalid) {
			t.Fatalf("%s: an old quote must be refused whatever the last trade says, got quote=%+v err=%v", name, quote, err)
		}
	}
}

func TestExactQuoteInvalidPricesAreRefused(t *testing.T) {
	for name, prices := range map[string][2]float64{"zero ask": {11.61, 0}, "negative bid": {-1, 11.78}} {
		service, closeServer := exactQuoteService(t, stamp(-5*time.Second), stamp(0), prices[0], prices[1])
		quote, err := service.GetOptionsQuote(context.Background(), exactQuoteSymbol)
		closeServer()
		if quote != nil || !errors.Is(err, ErrOptionsQuoteStaleOrInvalid) {
			t.Fatalf("%s: got quote=%+v err=%v", name, quote, err)
		}
	}
}

// The other consumer of the shared primitive: an opening market order without a limit price takes its final risk price from the exact
// quote. An undated quote must stop it there, even with a fresh trade, and never become a price.
func TestOpeningMarketOrderRefusesAnUndatedExactQuote(t *testing.T) {
	service, closeServer := exactQuoteService(t, "", stamp(0), 11.61, 11.78)
	defer closeServer()
	service.policy = &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true}
	order := &interfaces.OptionsOrder{Symbol: exactQuoteSymbol, Underlying: "NVDA", Side: "buy", PositionIntent: "buy_to_open", Qty: 1}
	err := service.validateOptionsPolicy(context.Background(), order)
	if err == nil || !strings.Contains(err.Error(), "options quote unavailable for final risk-policy evaluation") || !errors.Is(err, ErrOptionsQuoteStaleOrInvalid) {
		t.Fatalf("an undated quote must not price a market opening: %v", err)
	}
}
