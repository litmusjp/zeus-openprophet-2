package controllers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/interfaces"
)

func TestBuildQuoteResponseFlagsWideStaleAndOneSided(t *testing.T) {
	now := time.Date(2026, 11, 3, 14, 30, 0, 0, time.UTC)
	trade := &interfaces.Trade{Price: 1040.5, Size: 10, Timestamp: now}

	ok := buildQuoteResponse(&interfaces.Quote{Symbol: "SPY", BidPrice: 752.0, AskPrice: 752.1, Timestamp: now}, trade, now)
	if ok.QuoteFlag != "ok" || ok.SpreadPct == nil || *ok.SpreadPct > 0.02 {
		t.Fatalf("tight quote = %+v", ok)
	}

	wide := buildQuoteResponse(&interfaces.Quote{Symbol: "COST", BidPrice: 978.49, AskPrice: 1085.67, Timestamp: now}, trade, now)
	if wide.QuoteFlag != "wide" || wide.LastTrade == nil || wide.LastTrade.Price != 1040.5 || wide.SpreadPct == nil || *wide.SpreadPct < 10 {
		t.Fatalf("wide quote = %+v", wide)
	}

	stale := buildQuoteResponse(&interfaces.Quote{Symbol: "V", BidPrice: 401.78, AskPrice: 445.57, Timestamp: now.Add(-17 * time.Hour)}, nil, now)
	if stale.QuoteFlag != "wide_stale" || stale.LastTrade != nil {
		t.Fatalf("stale wide quote = %+v", stale)
	}

	oneSided := buildQuoteResponse(&interfaces.Quote{Symbol: "MA", BidPrice: 616.44, AskPrice: 0, Timestamp: now}, nil, now)
	if oneSided.QuoteFlag != "one_sided" || oneSided.SpreadPct != nil {
		t.Fatalf("one-sided quote = %+v", oneSided)
	}
}

type quoteTradeData struct {
	*recordingBars
	quote *interfaces.Quote
	trade *interfaces.Trade
}

func (d *quoteTradeData) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return d.quote, nil
}
func (d *quoteTradeData) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	if d.trade == nil {
		return nil, errors.New("no trade")
	}
	return d.trade, nil
}

func TestGetQuoteKeepsOriginalFieldsAndAddsQuality(t *testing.T) {
	now := time.Now()
	controller := NewOrderController(nil, &quoteTradeData{
		recordingBars: &recordingBars{},
		quote:         &interfaces.Quote{Symbol: "COST", BidPrice: 978.49, AskPrice: 1085.67, BidSize: 40, AskSize: 40, Timestamp: now},
		trade:         &interfaces.Trade{Symbol: "COST", Price: 1040.5, Size: 5, Timestamp: now},
	}, nil)
	recorder, body := getJSON(t, controller.HandleGetQuote, "/x", paramsFor("COST"))
	if recorder.Code != 200 || body["BidPrice"].(float64) != 978.49 || body["quote_flag"] != "wide" {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	last, _ := body["last_trade"].(map[string]any)
	if last == nil || last["price"].(float64) != 1040.5 {
		t.Fatalf("last_trade missing: %s", recorder.Body.String())
	}
	// a missing last trade must not fail the quote
	controller = NewOrderController(nil, &quoteTradeData{recordingBars: &recordingBars{}, quote: &interfaces.Quote{Symbol: "X", BidPrice: 10, AskPrice: 10.01, Timestamp: now}}, nil)
	recorder, body = getJSON(t, controller.HandleGetQuote, "/x", paramsFor("X"))
	if recorder.Code != 200 || body["last_trade"] != nil || body["quote_flag"] != "ok" {
		t.Fatalf("without trade: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func paramsFor(symbol string) gin.Params { return gin.Params{{Key: "symbol", Value: symbol}} }
