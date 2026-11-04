package services

import (
	"math"
	"time"

	"prophet-trader/interfaces"
)

// DailyBarFacts is one completed daily bar in the New York trading calendar.
type DailyBarFacts struct {
	Date   string  `json:"date"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume int64   `json:"volume"`
}

// DailyFeatures are plain arithmetic facts about completed daily bars. They are not signals:
// the caller's strategy decides what, if anything, they mean. Prior-window values exclude the
// last completed bar so they can be compared against it.
type DailyFeatures struct {
	Symbol           string         `json:"symbol"`
	Feed             string         `json:"feed"`
	CompleteBars     int            `json:"complete_bars"`
	LastCompleteDate string         `json:"last_complete_date,omitempty"`
	Last             *DailyBarFacts `json:"last,omitempty"`
	Prior            *DailyBarFacts `json:"prior_session,omitempty"`
	SMA20            *float64       `json:"sma20,omitempty"`
	SMA20Slope5Pct   *float64       `json:"sma20_slope_5_sessions_pct,omitempty"`
	CloseVsSMA20Pct  *float64       `json:"last_close_vs_sma20_pct,omitempty"`
	High10Prior      *float64       `json:"high_prior_10_sessions,omitempty"`
	Low10Prior       *float64       `json:"low_prior_10_sessions,omitempty"`
	High20Prior      *float64       `json:"high_prior_20_sessions,omitempty"`
	Low20Prior       *float64       `json:"low_prior_20_sessions,omitempty"`
	AvgVolume20Prior *float64       `json:"avg_volume_prior_20_sessions,omitempty"`
	LastVolumeRatio  *float64       `json:"last_volume_to_avg_ratio,omitempty"`
	// Signed distances so callers read the number instead of doing the arithmetic. Each is
	// (last value - reference level) / reference level x 100 and is omitted when the history
	// needed for the reference window is missing.
	LowVsLow20PriorPct    *float64        `json:"low_vs_low_prior_20_sessions_pct,omitempty"`
	CloseVsHigh10PriorPct *float64        `json:"close_vs_high_prior_10_sessions_pct,omitempty"`
	CloseVsHigh20PriorPct *float64        `json:"close_vs_high_prior_20_sessions_pct,omitempty"`
	UndercutPriorLow      *bool           `json:"undercut_prior_session_low,omitempty"`
	CloseAboveOpen        *bool           `json:"close_above_open,omitempty"`
	Recent                []DailyBarFacts `json:"recent_completed_bars,omitempty"`
	Notes                 []string        `json:"notes,omitempty"`
	Error                 string          `json:"error,omitempty"`
}

func roundTo(value float64, places int) float64 {
	scale := math.Pow(10, float64(places))
	return math.Round(value*scale) / scale
}

func roundedPtr(value float64) *float64 {
	rounded := roundTo(value, 4)
	return &rounded
}

func meanClose(bars []*interfaces.Bar) float64 {
	total := 0.0
	for _, bar := range bars {
		total += bar.Close
	}
	return total / float64(len(bars))
}

func highLow(bars []*interfaces.Bar) (float64, float64) {
	high, low := bars[0].High, bars[0].Low
	for _, bar := range bars[1:] {
		high = math.Max(high, bar.High)
		low = math.Min(low, bar.Low)
	}
	return high, low
}

func barFacts(bar *interfaces.Bar, loc *time.Location) DailyBarFacts {
	return DailyBarFacts{
		Date: bar.Timestamp.In(loc).Format("2006-01-02"), Open: roundTo(bar.Open, 4), High: roundTo(bar.High, 4),
		Low: roundTo(bar.Low, 4), Close: roundTo(bar.Close, 4), Volume: bar.Volume,
	}
}

// ComputeDailyFeatures derives facts from COMPLETED daily bars sorted ascending. Fields that need
// more history than supplied are omitted and explained in Notes rather than approximated.
func ComputeDailyFeatures(symbol string, completed []*interfaces.Bar, loc *time.Location) DailyFeatures {
	out := DailyFeatures{Symbol: symbol, Feed: "iex", CompleteBars: len(completed)}
	n := len(completed)
	if n == 0 {
		out.Notes = append(out.Notes, "no completed daily bars returned")
		return out
	}
	last := completed[n-1]
	lastFacts := barFacts(last, loc)
	out.Last = &lastFacts
	out.LastCompleteDate = lastFacts.Date
	closeAboveOpen := last.Close > last.Open
	out.CloseAboveOpen = &closeAboveOpen
	if n >= 2 {
		prior := barFacts(completed[n-2], loc)
		out.Prior = &prior
		undercut := last.Low < completed[n-2].Low
		out.UndercutPriorLow = &undercut
	}
	if n >= 20 {
		sma := meanClose(completed[n-20:])
		out.SMA20 = roundedPtr(sma)
		out.CloseVsSMA20Pct = roundedPtr((last.Close/sma - 1) * 100)
		if n >= 25 {
			if earlier := meanClose(completed[n-25 : n-5]); earlier > 0 {
				out.SMA20Slope5Pct = roundedPtr((sma/earlier - 1) * 100)
			}
		}
	}
	if n >= 11 {
		high, low := highLow(completed[n-11 : n-1])
		out.High10Prior, out.Low10Prior = roundedPtr(high), roundedPtr(low)
		if high > 0 {
			out.CloseVsHigh10PriorPct = roundedPtr((last.Close/high - 1) * 100)
		}
	}
	if n >= 21 {
		window := completed[n-21 : n-1]
		high, low := highLow(window)
		out.High20Prior, out.Low20Prior = roundedPtr(high), roundedPtr(low)
		if high > 0 {
			out.CloseVsHigh20PriorPct = roundedPtr((last.Close/high - 1) * 100)
		}
		if low > 0 {
			out.LowVsLow20PriorPct = roundedPtr((last.Low/low - 1) * 100)
		}
		total := 0.0
		for _, bar := range window {
			total += float64(bar.Volume)
		}
		average := total / float64(len(window))
		out.AvgVolume20Prior = roundedPtr(average)
		if average > 0 {
			out.LastVolumeRatio = roundedPtr(float64(last.Volume) / average)
		}
	}
	if n < 25 {
		out.Notes = append(out.Notes, "fewer than 25 completed bars: longer-window fields are omitted, not estimated")
	}
	start := n - 5
	if start < 0 {
		start = 0
	}
	for _, bar := range completed[start:] {
		out.Recent = append(out.Recent, barFacts(bar, loc))
	}
	out.Notes = append(out.Notes, "the forming session bar is excluded; the feed field says whether highs, lows and volume are consolidated (sip) or IEX-only (iex)")
	return out
}

// CompletedDailyBars keeps only bars whose daily period has ended at now (16:00 New York).
func CompletedDailyBars(bars []*interfaces.Bar, now time.Time, loc *time.Location) []*interfaces.Bar {
	annotated, ok := AnnotateBarCompleteness(bars, "1Day", now, loc)
	if !ok {
		return nil
	}
	completed := make([]*interfaces.Bar, 0, len(annotated))
	for _, item := range annotated {
		if item.Complete {
			completed = append(completed, item.Bar)
		}
	}
	return completed
}
