package services

import (
	"math"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func syntheticBars(loc *time.Location, count int) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, 0, count)
	day := time.Date(2026, 9, 1, 0, 0, 0, 0, loc)
	for len(bars) < count {
		if day.Weekday() != time.Saturday && day.Weekday() != time.Sunday {
			i := float64(len(bars))
			bars = append(bars, &interfaces.Bar{Timestamp: day, Open: 100 + i, High: 101 + i, Low: 99 + i, Close: 100.5 + i, Volume: int64(1000 + len(bars)*10)})
		}
		day = day.AddDate(0, 0, 1)
	}
	return bars
}

func TestComputeDailyFeaturesFacts(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	got := ComputeDailyFeatures("TEST", syntheticBars(loc, 30), loc)
	if got.CompleteBars != 30 || got.Last == nil || got.Prior == nil || got.SMA20 == nil {
		t.Fatalf("missing facts: %+v", got)
	}
	// closes are 100.5+i; SMA20 of the last 20 closes (i=10..29) = 120.0
	if math.Abs(*got.SMA20-120.0) > 1e-9 {
		t.Fatalf("sma20 = %v", *got.SMA20)
	}
	// prior windows exclude the last bar (i=29)
	if got.High20Prior == nil || *got.High20Prior != 129 || *got.Low20Prior != 108 {
		t.Fatalf("prior-20 range = %v/%v", got.High20Prior, got.Low20Prior)
	}
	if got.High10Prior == nil || *got.High10Prior != 129 || *got.Low10Prior != 118 {
		t.Fatalf("prior-10 range = %v/%v", got.High10Prior, got.Low10Prior)
	}
	// avg prior-20 volume over i=9..28 is 1000 + 10*18.5 = 1185; last volume is 1290
	if got.AvgVolume20Prior == nil || math.Abs(*got.AvgVolume20Prior-1185) > 1e-9 || math.Abs(*got.LastVolumeRatio-1290.0/1185.0) > 1e-3 {
		t.Fatalf("volume facts = %v / %v", got.AvgVolume20Prior, got.LastVolumeRatio)
	}
	if got.SMA20Slope5Pct == nil || *got.SMA20Slope5Pct <= 0 {
		t.Fatalf("expected positive slope, got %v", got.SMA20Slope5Pct)
	}
	if len(got.Recent) != 5 || got.Recent[4].Date != got.LastCompleteDate {
		t.Fatalf("recent bars = %+v", got.Recent)
	}
}

func TestComputeDailyFeaturesOmitsInsufficientHistory(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	got := ComputeDailyFeatures("TEST", syntheticBars(loc, 12), loc)
	if got.SMA20 != nil || got.High20Prior != nil || got.High10Prior == nil {
		t.Fatalf("short history handled wrongly: %+v", got)
	}
	empty := ComputeDailyFeatures("TEST", nil, loc)
	if empty.Last != nil || len(empty.Notes) == 0 {
		t.Fatalf("empty = %+v", empty)
	}
}

func TestCompletedDailyBarsDropsFormingBar(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	bars := []*interfaces.Bar{
		{Timestamp: time.Date(2026, 11, 2, 0, 0, 0, 0, loc)},
		{Timestamp: time.Date(2026, 11, 3, 0, 0, 0, 0, loc)},
	}
	if got := CompletedDailyBars(bars, time.Date(2026, 11, 3, 11, 0, 0, 0, loc), loc); len(got) != 1 {
		t.Fatalf("mid-session should drop today's bar, got %d", len(got))
	}
	if got := CompletedDailyBars(bars, time.Date(2026, 11, 3, 16, 5, 0, 0, loc), loc); len(got) != 2 {
		t.Fatalf("after close should keep both, got %d", len(got))
	}
}
