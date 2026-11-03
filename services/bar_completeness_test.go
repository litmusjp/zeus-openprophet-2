package services

import (
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func TestAnnotateBarCompleteness(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	day := func(d int) *interfaces.Bar {
		return &interfaces.Bar{Timestamp: time.Date(2026, 11, d, 0, 0, 0, 0, loc)}
	}
	bars := []*interfaces.Bar{day(2), day(3)}

	midSession := time.Date(2026, 11, 3, 11, 0, 0, 0, loc)
	got, ok := AnnotateBarCompleteness(bars, "1Day", midSession, loc)
	if !ok || len(got) != 2 || !got[0].Complete || got[1].Complete {
		t.Fatalf("mid-session: want prior complete and today forming, got %+v ok=%v", got, ok)
	}
	got, _ = AnnotateBarCompleteness(bars, "1D", time.Date(2026, 11, 3, 16, 0, 0, 0, loc), loc)
	if !got[1].Complete {
		t.Fatalf("after close: today's daily bar should be complete")
	}
	minute := &interfaces.Bar{Timestamp: time.Date(2026, 11, 3, 10, 59, 0, 0, loc)}
	got, _ = AnnotateBarCompleteness([]*interfaces.Bar{minute}, "1Min", time.Date(2026, 11, 3, 11, 0, 30, 0, loc), loc)
	if !got[0].Complete {
		t.Fatalf("1Min bar that ended 11:00:00 should be complete at 11:00:30")
	}
	if _, ok := AnnotateBarCompleteness(bars, "1Week", midSession, loc); ok {
		t.Fatalf("weekly timeframe must not be annotated")
	}
}
