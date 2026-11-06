package services

import (
	"errors"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
)

func TestFetchBarsPreferSIPUsesSIPWithClampedEnd(t *testing.T) {
	now := time.Date(2026, 11, 4, 15, 0, 0, 0, time.UTC)
	start := now.AddDate(0, 0, -30)
	var feeds []marketdata.Feed
	var sipEnd time.Time
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		feeds = append(feeds, feed)
		if feed == marketdata.SIP {
			sipEnd = e
		}
		return []marketdata.Bar{{Close: 1}}, nil
	}
	bars, feed, err := fetchBarsPreferSIP(fetch, start, now, now)
	if err != nil || feed != "sip" || len(bars) != 1 || len(feeds) != 1 {
		t.Fatalf("feed=%s bars=%d feeds=%v err=%v", feed, len(bars), feeds, err)
	}
	if !sipEnd.Equal(now.Add(-sipDelay)) {
		t.Fatalf("SIP end must be clamped to now-%v, got %v", sipDelay, sipEnd)
	}
}

func TestFetchBarsPreferSIPFallsBackToIEXWhenSIPFails(t *testing.T) {
	now := time.Date(2026, 11, 4, 15, 0, 0, 0, time.UTC)
	var feeds []marketdata.Feed
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		feeds = append(feeds, feed)
		if feed == marketdata.SIP {
			return nil, errors.New("subscription does not permit querying recent SIP data")
		}
		return []marketdata.Bar{{Close: 2}}, nil
	}
	bars, feed, err := fetchBarsPreferSIP(fetch, now.AddDate(0, 0, -30), now, now)
	if err != nil || feed != "iex" || len(bars) != 1 || bars[0].Close != 2 {
		t.Fatalf("feed=%s bars=%v err=%v", feed, bars, err)
	}
	if len(feeds) != 2 || feeds[0] != marketdata.SIP || feeds[1] != marketdata.IEX {
		t.Fatalf("feeds tried = %v", feeds)
	}
}

func TestFetchBarsPreferSIPSkipsSIPForVeryRecentWindowAndReportsIEXError(t *testing.T) {
	now := time.Date(2026, 11, 4, 15, 0, 0, 0, time.UTC)
	var feeds []marketdata.Feed
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		feeds = append(feeds, feed)
		return nil, errors.New("down")
	}
	// the whole window is newer than the SIP delay, so SIP is not even attempted
	_, feed, err := fetchBarsPreferSIP(fetch, now.Add(-5*time.Minute), now, now)
	if err == nil || feed != "iex" || len(feeds) != 1 || feeds[0] != marketdata.IEX {
		t.Fatalf("feed=%s feeds=%v err=%v", feed, feeds, err)
	}
}

func TestIntradayRecentWindowIsRequestedWholeAndUnclamped(t *testing.T) {
	now := time.Date(2026, 11, 6, 15, 0, 0, 0, time.UTC)
	start := now.Add(-2 * time.Hour)
	var calls []struct {
		feed marketdata.Feed
		end  time.Time
	}
	// SIP is not permitted for recent data on this plan: it errors, IEX answers for the whole window
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		calls = append(calls, struct {
			feed marketdata.Feed
			end  time.Time
		}{feed, e})
		if feed == marketdata.SIP {
			return nil, errors.New("subscription does not permit querying recent SIP data")
		}
		return []marketdata.Bar{{Close: 1}, {Close: 2}}, nil
	}
	bars, feed, err := fetchBarsForTimeframe(fetch, start, now, now, "5Min")
	if err != nil || feed != "iex" || len(bars) != 2 {
		t.Fatalf("feed=%s bars=%d err=%v", feed, len(bars), err)
	}
	if len(calls) != 2 || calls[0].feed != marketdata.SIP || calls[1].feed != marketdata.IEX {
		t.Fatalf("expected SIP then IEX, got %+v", calls)
	}
	for _, call := range calls {
		if !call.end.Equal(now) {
			t.Fatalf("the intraday end must NOT be clamped to now-%v: %s end=%v", sipDelay, call.feed, call.end)
		}
	}
}

func TestIntradayRecentWindowUsesSIPWhenThePlanAllowsIt(t *testing.T) {
	now := time.Date(2026, 11, 6, 15, 0, 0, 0, time.UTC)
	var ends []time.Time
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		ends = append(ends, e)
		return []marketdata.Bar{{Close: 1}}, nil
	}
	_, feed, err := fetchBarsForTimeframe(fetch, now.Add(-time.Hour), now, now, "5Min")
	if err != nil || feed != "sip" || len(ends) != 1 || !ends[0].Equal(now) {
		t.Fatalf("feed=%s ends=%v err=%v", feed, ends, err)
	}
}

func TestOlderIntradayWindowsAndDailyBarsKeepTheSIPFirstPolicy(t *testing.T) {
	now := time.Date(2026, 11, 6, 15, 0, 0, 0, time.UTC)
	// an intraday window that ended an hour ago is old enough for SIP and is not widened
	var ends []time.Time
	fetch := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		ends = append(ends, e)
		return []marketdata.Bar{{Close: 1}}, nil
	}
	end := now.Add(-time.Hour)
	if _, feed, err := fetchBarsForTimeframe(fetch, now.Add(-3*time.Hour), end, now, "5Min"); err != nil || feed != "sip" || !ends[0].Equal(end) {
		t.Fatalf("old intraday: feed=%s ends=%v err=%v", feed, ends, err)
	}
	// a daily request to now is still clamped to what SIP allows, exactly as before
	ends = nil
	if _, feed, err := fetchBarsForTimeframe(fetch, now.AddDate(0, 0, -30), now, now, "1Day"); err != nil || feed != "sip" || !ends[0].Equal(now.Add(-sipDelay)) {
		t.Fatalf("daily: feed=%s ends=%v err=%v", feed, ends, err)
	}
	// and a daily SIP failure still falls back to IEX
	failSIP := func(feed marketdata.Feed, s, e time.Time) ([]marketdata.Bar, error) {
		if feed == marketdata.SIP {
			return nil, errors.New("no sip")
		}
		return []marketdata.Bar{{Close: 9}}, nil
	}
	if bars, feed, err := fetchBarsForTimeframe(failSIP, now.AddDate(0, 0, -30), now, now, "1Day"); err != nil || feed != "iex" || len(bars) != 1 {
		t.Fatalf("daily fallback: feed=%s bars=%d err=%v", feed, len(bars), err)
	}
}

func TestIsIntradayTimeframe(t *testing.T) {
	for _, tf := range []string{"1Min", "5Min", "15Min", "30Min", "1Hour", "4Hour"} {
		if !isIntradayTimeframe(tf) {
			t.Fatalf("%s should be intraday", tf)
		}
	}
	for _, tf := range []string{"1Day", "1Week", "1Month", "", "weird"} {
		if isIntradayTimeframe(tf) {
			t.Fatalf("%s should not be intraday", tf)
		}
	}
}
