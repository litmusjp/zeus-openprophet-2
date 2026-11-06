package controllers

import (
	"math"
	"time"

	"prophet-trader/interfaces"
)

const (
	wideSpreadPct   = 1.0
	staleQuoteAfter = 15 * time.Minute
)

// lastTradeInfo is the most recent print, a better reference for "where is the stock" than a thin
// top-of-book quote.
type lastTradeInfo struct {
	Price     float64   `json:"price"`
	Size      int64     `json:"size"`
	Timestamp time.Time `json:"timestamp"`
}

// quoteResponse keeps the original quote fields and adds quality information. The quote comes from
// the IEX feed, which for many single stocks is sparse and can look far wider than the real market.
type quoteResponse struct {
	*interfaces.Quote
	LastTrade *lastTradeInfo `json:"last_trade,omitempty"`
	SpreadPct *float64       `json:"spread_pct,omitempty"`
	QuoteFlag string         `json:"quote_flag"`
	Note      string         `json:"note"`
	// Session is additive context (today's open, previous close, change from the open); omitted when not attached.
	Session *sessionContext `json:"session,omitempty"`
}

// buildQuoteResponse classifies a quote as ok, wide, stale or one_sided and attaches the last trade.
func buildQuoteResponse(quote *interfaces.Quote, trade *interfaces.Trade, now time.Time) quoteResponse {
	out := quoteResponse{Quote: quote, QuoteFlag: "ok"}
	if trade != nil && trade.Price > 0 {
		out.LastTrade = &lastTradeInfo{Price: trade.Price, Size: trade.Size, Timestamp: trade.Timestamp}
	}
	if quote != nil {
		switch {
		case quote.BidPrice <= 0 || quote.AskPrice <= 0:
			out.QuoteFlag = "one_sided"
		default:
			mid := (quote.BidPrice + quote.AskPrice) / 2
			spread := math.Round((quote.AskPrice-quote.BidPrice)/mid*10000) / 100
			out.SpreadPct = &spread
			if spread > wideSpreadPct {
				out.QuoteFlag = "wide"
			}
		}
		if !quote.Timestamp.IsZero() && now.Sub(quote.Timestamp) > staleQuoteAfter {
			if out.QuoteFlag == "ok" {
				out.QuoteFlag = "stale"
			} else {
				out.QuoteFlag += "_stale"
			}
		}
	}
	out.Note = "Bid/ask is IEX top-of-book and may be sparse or stale for single stocks. When quote_flag is not ok, judge price and distance from a level using last_trade or the latest completed bar, not the bid/ask midpoint."
	return out
}
