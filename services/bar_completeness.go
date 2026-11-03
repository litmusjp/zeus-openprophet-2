package services

import (
	"strings"
	"time"

	"prophet-trader/interfaces"
)

// AnnotatedBar is a bar plus an additive completion flag so callers can tell a
// finished bar from one still forming. It never filters or alters bar values.
type AnnotatedBar struct {
	*interfaces.Bar
	Complete bool `json:"complete"`
}

const regularSessionCloseHourNY = 16

// barPeriodEnd returns when the bar starting at ts finishes, or false for
// timeframes whose completion is not derived here (weekly/monthly).
func barPeriodEnd(ts time.Time, timeframe string, loc *time.Location) (time.Time, bool) {
	switch strings.ToLower(strings.TrimSpace(timeframe)) {
	case "1min":
		return ts.Add(time.Minute), true
	case "5min":
		return ts.Add(5 * time.Minute), true
	case "15min":
		return ts.Add(15 * time.Minute), true
	case "30min":
		return ts.Add(30 * time.Minute), true
	case "1hour":
		return ts.Add(time.Hour), true
	case "4hour":
		return ts.Add(4 * time.Hour), true
	case "1day", "1d", "":
		d := ts.In(loc)
		return time.Date(d.Year(), d.Month(), d.Day(), regularSessionCloseHourNY, 0, 0, 0, loc), true
	}
	return time.Time{}, false
}

// AnnotateBarCompleteness marks each bar complete once its period has ended at
// now. Daily bars finish at the 16:00 New York regular close, so an early-close
// day is conservatively reported incomplete until 16:00. The second return is
// false when the timeframe is not annotated.
func AnnotateBarCompleteness(bars []*interfaces.Bar, timeframe string, now time.Time, loc *time.Location) ([]AnnotatedBar, bool) {
	out := make([]AnnotatedBar, 0, len(bars))
	for _, bar := range bars {
		if bar == nil {
			continue
		}
		end, ok := barPeriodEnd(bar.Timestamp, timeframe, loc)
		if !ok {
			return nil, false
		}
		out = append(out, AnnotatedBar{Bar: bar, Complete: !end.After(now)})
	}
	return out, true
}
