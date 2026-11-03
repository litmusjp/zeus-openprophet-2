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
