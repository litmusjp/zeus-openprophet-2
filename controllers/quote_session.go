package controllers

import (
	"math"
	"sort"
	"time"

	"prophet-trader/interfaces"
)

// sessionContext tells an agent where a stock stands against today's open and the previous close.
// AlphaDesk judges price action against today's open, so this is the same kind of fact. It is context
// only: unknown values stay unknown (never substituted) and it is not a prediction of an assessment.
type sessionContext struct {
	Status                 string   `json:"status"` // ok, partial or unavailable
	SessionDate            string   `json:"session_date"`
	BarsFeed               string   `json:"bars_feed,omitempty"`
	DailyOpen              *float64 `json:"daily_open,omitempty"`
	DailyOpenBarStart      string   `json:"daily_open_bar_start,omitempty"`
	PreviousClose          *float64 `json:"previous_close,omitempty"`
	PreviousCloseDate      string   `json:"previous_close_date,omitempty"`
	LastTradePrice         *float64 `json:"last_trade_price,omitempty"`
	LastTradeTimestamp     string   `json:"last_trade_timestamp,omitempty"`
	ChangeFromOpenPct      *float64 `json:"change_from_open_pct,omitempty"`
	ChangeFromPrevClosePct *float64 `json:"change_from_previous_close_pct,omitempty"`
	Note                   string   `json:"note"`
}

func pct2(value float64) *float64 {
	rounded := math.Round(value*100) / 100
	return &rounded
}

func sessionFloat(value float64) *float64 { return &value }

// buildSessionContext derives the session facts from daily bars (the current session's bar may still be
// forming; its open is already final) and the latest trade. It never invents a missing value.
func buildSessionContext(bars []*interfaces.Bar, feed string, trade *interfaces.Trade, now time.Time, loc *time.Location) *sessionContext {
	today := now.In(loc).Format("2006-01-02")
	out := &sessionContext{Status: "unavailable", SessionDate: today, BarsFeed: feed,
		Note: "Session facts from daily bars: daily_open is today's open once today's bar exists; previous_close is the last completed session close. Unknown values are omitted, never estimated. Context for where the stock stands, not a gate and not a prediction of an AlphaDesk result."}
	valid := make([]*interfaces.Bar, 0, len(bars))
	for _, bar := range bars {
		if bar != nil && !bar.Timestamp.IsZero() {
			valid = append(valid, bar)
		}
	}
	if len(valid) == 0 {
		return out
	}
	sort.SliceStable(valid, func(i, j int) bool { return valid[i].Timestamp.Before(valid[j].Timestamp) })
	last := valid[len(valid)-1]
	lastDate := last.Timestamp.In(loc).Format("2006-01-02")
	var previous *interfaces.Bar
	switch {
	case lastDate == today:
		if last.Open > 0 {
			out.DailyOpen = sessionFloat(last.Open)
			out.DailyOpenBarStart = last.Timestamp.UTC().Format(time.RFC3339)
		}
		if len(valid) >= 2 {
			previous = valid[len(valid)-2]
		}
	case lastDate < today:
		previous = last // today's bar does not exist yet (before the first print): only the previous close is known
	default:
		return out // a bar dated after today cannot be reasoned about
	}
	if previous != nil && previous.Close > 0 {
		out.PreviousClose = sessionFloat(previous.Close)
		out.PreviousCloseDate = previous.Timestamp.In(loc).Format("2006-01-02")
	}
	if trade != nil && trade.Price > 0 {
		out.LastTradePrice = sessionFloat(trade.Price)
		if !trade.Timestamp.IsZero() {
			out.LastTradeTimestamp = trade.Timestamp.UTC().Format(time.RFC3339Nano)
		}
		if out.DailyOpen != nil {
			out.ChangeFromOpenPct = pct2((trade.Price/(*out.DailyOpen) - 1) * 100)
		}
		if out.PreviousClose != nil {
			out.ChangeFromPrevClosePct = pct2((trade.Price/(*out.PreviousClose) - 1) * 100)
		}
	}
	switch {
	case out.DailyOpen != nil && out.PreviousClose != nil:
		out.Status = "ok"
	case out.DailyOpen != nil || out.PreviousClose != nil:
		out.Status = "partial"
	}
	return out
}
