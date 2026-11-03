package controllers

import (
	"context"
	"time"

	"prophet-trader/interfaces"
)

// barsWithFeedProvider is implemented by data services that can say which market-data feed served a
// request (consolidated "sip" or thin "iex").
type barsWithFeedProvider interface {
	GetHistoricalBarsWithFeed(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, string, error)
}

// historicalBarsWithFeed returns bars and the feed used. Services that cannot report a feed are
// labelled "iex", the conservative assumption.
func historicalBarsWithFeed(ctx context.Context, data interfaces.DataService, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, string, error) {
	if provider, ok := data.(barsWithFeedProvider); ok {
		return provider.GetHistoricalBarsWithFeed(ctx, symbol, start, end, timeframe)
	}
	bars, err := data.GetHistoricalBars(ctx, symbol, start, end, timeframe)
	return bars, "iex", err
}

func volumeBasisNote(feed string) string {
	if feed == "sip" {
		return "Feed is sip: consolidated market data, so highs, lows and volume reflect the whole market."
	}
	return "Feed is iex: IEX-only data, so highs, lows and volume are a small share of the market and can differ from the real market."
}
