package services

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
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

// flatBars builds count completed weekday bars that all trade 100/101/99/100 except the last,
// which the caller overrides, so every prior-window reference level is known exactly.
func flatBars(loc *time.Location, count int, last interfaces.Bar) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, 0, count)
	day := time.Date(2026, 9, 1, 0, 0, 0, 0, loc)
	for len(bars) < count-1 {
		if day.Weekday() != time.Saturday && day.Weekday() != time.Sunday {
			bars = append(bars, &interfaces.Bar{Timestamp: day, Open: 100, High: 101, Low: 99, Close: 100, Volume: 1000})
		}
		day = day.AddDate(0, 0, 1)
	}
	for day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
		day = day.AddDate(0, 0, 1)
	}
	last.Timestamp = day
	return append(bars, &last)
}

func TestComputeDailyFeaturesSignedDistances(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	// prior-20 low = 99, prior-10/20 high = 101. Last bar: low 104, close 103.5 (above its 103 open).
	above := ComputeDailyFeatures("UP", flatBars(loc, 30, interfaces.Bar{Open: 103, High: 105, Low: 104, Close: 103.5, Volume: 2000}), loc)
	if above.LowVsLow20PriorPct == nil || math.Abs(*above.LowVsLow20PriorPct-(104.0/99.0-1)*100) > 1e-3 {
		t.Fatalf("low vs prior-20 low = %v", above.LowVsLow20PriorPct)
	}
	if above.CloseVsHigh10PriorPct == nil || math.Abs(*above.CloseVsHigh10PriorPct-(103.5/101.0-1)*100) > 1e-3 ||
		above.CloseVsHigh20PriorPct == nil || math.Abs(*above.CloseVsHigh20PriorPct-(103.5/101.0-1)*100) > 1e-3 {
		t.Fatalf("close vs prior highs = %v / %v", above.CloseVsHigh10PriorPct, above.CloseVsHigh20PriorPct)
	}
	if above.CloseAboveOpen == nil || !*above.CloseAboveOpen || above.UndercutPriorLow == nil || *above.UndercutPriorLow {
		t.Fatalf("booleans = %v / %v", above.CloseAboveOpen, above.UndercutPriorLow)
	}
	// An undercut that closes BELOW its open: negative distance to the prior-20 low, flags reflect it.
	under := ComputeDailyFeatures("DN", flatBars(loc, 30, interfaces.Bar{Open: 99.5, High: 99.6, Low: 98.4, Close: 98.9, Volume: 2000}), loc)
	if under.LowVsLow20PriorPct == nil || *under.LowVsLow20PriorPct >= 0 || math.Abs(*under.LowVsLow20PriorPct-(98.4/99.0-1)*100) > 1e-3 {
		t.Fatalf("an undercut must be negative, got %v", under.LowVsLow20PriorPct)
	}
	if under.UndercutPriorLow == nil || !*under.UndercutPriorLow || under.CloseAboveOpen == nil || *under.CloseAboveOpen {
		t.Fatalf("undercut/close-above-open = %v / %v", under.UndercutPriorLow, under.CloseAboveOpen)
	}
	// close exactly at the open is NOT above the open (strict comparison)
	equal := ComputeDailyFeatures("EQ", flatBars(loc, 30, interfaces.Bar{Open: 100, High: 100.5, Low: 98.5, Close: 100, Volume: 2000}), loc)
	if equal.CloseAboveOpen == nil || *equal.CloseAboveOpen {
		t.Fatalf("close == open must not count as above, got %v", equal.CloseAboveOpen)
	}
}

func TestComputeDailyFeaturesDistancesOmittedWithShortHistory(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	short := ComputeDailyFeatures("S", flatBars(loc, 15, interfaces.Bar{Open: 103, High: 105, Low: 104, Close: 103.5, Volume: 2000}), loc)
	if short.CloseVsHigh10PriorPct == nil {
		t.Fatal("15 bars is enough for the prior-10 distance")
	}
	if short.CloseVsHigh20PriorPct != nil || short.LowVsLow20PriorPct != nil {
		t.Fatalf("20-session distances must be omitted with 15 bars: %v / %v", short.CloseVsHigh20PriorPct, short.LowVsLow20PriorPct)
	}
	one := ComputeDailyFeatures("O", flatBars(loc, 1, interfaces.Bar{Open: 1, High: 2, Low: 1, Close: 2, Volume: 1}), loc)
	if one.UndercutPriorLow != nil || one.CloseAboveOpen == nil {
		t.Fatalf("one bar: undercut must be omitted (no prior session), close-above-open present: %v / %v", one.UndercutPriorLow, one.CloseAboveOpen)
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

const sma200Note = "fewer than 200 completed bars: sma200 and last_close_vs_sma200_pct are omitted"

func countNote(notes []string, want string) int {
	n := 0
	for _, note := range notes {
		if note == want {
			n++
		}
	}
	return n
}

func TestComputeDailyFeaturesSMA200(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	// closes are 100.5+i. 200 bars: mean = 100.5+99.5 = 200, last 299.5. 250 bars: mean of i=50..249 = 250, last 349.5.
	for _, tc := range []struct {
		count     int
		sma, dist float64
	}{{200, 200, 49.75}, {250, 250, 39.8}} {
		got := ComputeDailyFeatures("TEST", syntheticBars(loc, tc.count), loc)
		if got.SMA200 == nil || got.CloseVsSMA200Pct == nil || *got.SMA200 != tc.sma || *got.CloseVsSMA200Pct != tc.dist {
			t.Fatalf("%d bars: sma200=%v distance=%v", tc.count, got.SMA200, got.CloseVsSMA200Pct)
		}
		if countNote(got.Notes, sma200Note) != 0 {
			t.Fatalf("%d bars must not carry the short-history note: %v", tc.count, got.Notes)
		}
		if got.CompleteBars != tc.count || len(got.Recent) != 5 {
			t.Fatalf("%d bars: complete=%d recent=%d", tc.count, got.CompleteBars, len(got.Recent))
		}
		raw, _ := json.Marshal(got)
		if !strings.Contains(string(raw), `"sma200":`) || !strings.Contains(string(raw), `"last_close_vs_sma200_pct":`) {
			t.Fatalf("JSON names missing: %s", raw)
		}
	}
	// four-decimal rounding: mean = (199*100 + 103.5)/200 = 100.0175; distance = 3.48189... -> 3.4819
	got := ComputeDailyFeatures("R", flatBars(loc, 200, interfaces.Bar{Open: 103, High: 105, Low: 102, Close: 103.5, Volume: 2000}), loc)
	if got.SMA200 == nil || *got.SMA200 != 100.0175 || *got.CloseVsSMA200Pct != 3.4819 {
		t.Fatalf("rounded = %v / %v", got.SMA200, got.CloseVsSMA200Pct)
	}
}

func TestComputeDailyFeaturesSMA200OmittedBelow200Bars(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	for _, count := range []int{1, 24, 30, 199} {
		got := ComputeDailyFeatures("TEST", syntheticBars(loc, count), loc)
		if got.SMA200 != nil || got.CloseVsSMA200Pct != nil {
			t.Fatalf("%d bars must omit sma200: %v / %v", count, got.SMA200, got.CloseVsSMA200Pct)
		}
		if countNote(got.Notes, sma200Note) != 1 {
			t.Fatalf("%d bars need exactly one note: %v", count, got.Notes)
		}
		raw, _ := json.Marshal(got)
		if strings.Contains(string(raw), `"sma200":`) || strings.Contains(string(raw), `"last_close_vs_sma200_pct":`) {
			t.Fatalf("%d bars: keys must be absent: %s", count, raw)
		}
	}
}

func TestComputeDailyFeaturesExistingFieldsIgnoreOlderHistory(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	long := syntheticBars(loc, 290)
	// Make the older history wildly different: any leak into a shorter window would show.
	for _, bar := range long[:220] {
		bar.Open, bar.High, bar.Low, bar.Close, bar.Volume = 9000, 9999, 1, 9000, 99999999
	}
	facts := func(bars []*interfaces.Bar) map[string]any {
		raw, _ := json.Marshal(ComputeDailyFeatures("TEST", bars, loc))
		out := map[string]any{}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"complete_bars", "sma200", "last_close_vs_sma200_pct", "notes"} {
			delete(out, key)
		}
		return out
	}
	short, full := facts(long[len(long)-70:]), facts(long)
	if !reflect.DeepEqual(short, full) {
		t.Fatalf("existing fields changed with older history:\n70 bars: %v\n290 bars: %v", short, full)
	}
}
