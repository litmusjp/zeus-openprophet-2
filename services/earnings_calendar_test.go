package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestEarningsLookupReportsScheduledNoneAndUnknown(t *testing.T) {
	from := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC) // Tuesday
	calls := map[string]int{}
	var mu sync.Mutex
	fetch := func(_ context.Context, date string) ([]EarningsEvent, error) {
		mu.Lock()
		calls[date]++
		mu.Unlock()
		if date == "2026-11-05" {
			return []EarningsEvent{{Symbol: "AAPL", Date: date, Timing: "after_hours"}}, nil
		}
		return nil, nil
	}
	calendar := NewEarningsCalendarWithFetcher(fetch, func() time.Time { return from })
	got := calendar.Lookup(context.Background(), []string{"AAPL", "SPY"}, from, 7)
	if !got.Complete || len(got.Results) != 2 {
		t.Fatalf("unexpected lookup: %+v", got)
	}
	if got.Results[0].Status != "scheduled" || got.Results[0].NextEarningsDate != "2026-11-05" || got.Results[0].Timing != "after_hours" {
		t.Fatalf("AAPL = %+v", got.Results[0])
	}
	if got.Results[1].Status != "none_found_in_window" {
		t.Fatalf("SPY = %+v", got.Results[1])
	}
	if _, weekend := calls["2026-11-07"]; weekend {
		t.Fatal("weekend dates must not be queried")
	}
	// second lookup is served from the per-day cache
	calendar.Lookup(context.Background(), []string{"AAPL"}, from, 7)
	if calls["2026-11-05"] != 1 {
		t.Fatalf("expected cache hit, calls = %d", calls["2026-11-05"])
	}
}

func TestEarningsLookupFailureIsUnknownNotNone(t *testing.T) {
	from := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	fetch := func(_ context.Context, date string) ([]EarningsEvent, error) {
		if date == "2026-11-04" {
			return nil, errors.New("blocked")
		}
		return nil, nil
	}
	got := NewEarningsCalendarWithFetcher(fetch, time.Now).Lookup(context.Background(), []string{"MSFT"}, from, 3)
	if got.Complete || len(got.FailedDates) != 1 || got.Results[0].Status != "unknown" {
		t.Fatalf("a failed day must yield unknown: %+v", got)
	}
}
