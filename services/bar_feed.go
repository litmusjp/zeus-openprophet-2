package services

import (
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
)

// sipDelay is how old the end of a historical request must be for Alpaca to serve consolidated (SIP)
// data on plans without real-time SIP access.
const sipDelay = 16 * time.Minute

// barFetcher loads bars for one feed and window.
type barFetcher func(feed marketdata.Feed, start, end time.Time) ([]marketdata.Bar, error)

// sipWindowEnd clamps a request end to what SIP allows. ok is false when nothing is left to request.
func sipWindowEnd(start, end, now time.Time) (time.Time, bool) {
	limit := now.Add(-sipDelay)
	if end.After(limit) {
		end = limit
	}
	return end, end.After(start)
}

// fetchBarsPreferSIP asks for full-market (SIP) bars first and falls back to the thin IEX feed if SIP is
// not permitted or fails. The feed actually used is always returned so callers can label their data.
func fetchBarsPreferSIP(fetch barFetcher, start, end, now time.Time) ([]marketdata.Bar, string, error) {
	if sipEnd, ok := sipWindowEnd(start, end, now); ok {
		if bars, err := fetch(marketdata.SIP, start, sipEnd); err == nil {
			return bars, "sip", nil
		}
	}
	bars, err := fetch(marketdata.IEX, start, end)
	return bars, "iex", err
}
