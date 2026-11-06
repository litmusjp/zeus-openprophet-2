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

// isIntradayTimeframe reports whether bars are shorter than a day. Recent intraday windows are time
// sensitive: clamping them to now-16m would hide the newest completed bars.
func isIntradayTimeframe(timeframe string) bool {
	switch timeframe {
	case "1Min", "5Min", "15Min", "30Min", "1Hour", "4Hour":
		return true
	}
	return false
}

// fetchBarsForTimeframe is the feed policy used for historical bars. Daily and older windows keep the
// SIP-first behaviour (SIP clamped to what it allows). A recent INTRADAY window (its end inside the SIP
// delay) is requested whole and unclamped: SIP first in case the plan allows it, otherwise the whole
// window from IEX. Feeds are never stitched, so volume stays comparable inside one response, and the
// feed actually used is returned.
func fetchBarsForTimeframe(fetch barFetcher, start, end, now time.Time, timeframe string) ([]marketdata.Bar, string, error) {
	if isIntradayTimeframe(timeframe) && end.After(now.Add(-sipDelay)) {
		if bars, err := fetch(marketdata.SIP, start, end); err == nil {
			return bars, "sip", nil
		}
		bars, err := fetch(marketdata.IEX, start, end)
		return bars, "iex", err
	}
	return fetchBarsPreferSIP(fetch, start, end, now)
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
