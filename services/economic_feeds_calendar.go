package services

import (
	"context"
	"fmt"
	"regexp"
	"sync"
	"time"

	"prophet-trader/interfaces"
)

// MarketCalendarReader is the read-only exchange calendar the VIX history is checked against.
// *AlpacaTradingService satisfies it; GetMarketCalendar refuses spans longer than 14 days.
type MarketCalendarReader interface {
	GetMarketCalendar(ctx context.Context, start, end time.Time) ([]interfaces.MarketSession, error)
}

var _ MarketCalendarReader = (*AlpacaTradingService)(nil)

const (
	calendarChunkDays    = 14 // days from start to end of one request; the reader refuses more than 14*24h
	calendarReadTimeout  = 10 * time.Second
	calendarStatusOK     = "ok"
	calendarStatusFailed = "unavailable"
)

var calendarClockPattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// NewEconomicFeedsServiceWithTrading is the production constructor: the existing trading service is the calendar
// reader, so no new credential or provider is used. A nil trading service means no calendar, so VIX stays unusable.
func NewEconomicFeedsServiceWithTrading(trading *AlpacaTradingService) *EconomicFeedsService {
	s := NewEconomicFeedsService()
	if trading != nil {
		s.calendar = trading
	}
	return s
}

// calendarCache holds only fully validated session sets, keyed by New York date and covered interval.
type calendarCache struct {
	mu      sync.Mutex
	entries map[string]map[string]bool
}

func (c *calendarCache) get(key string) (map[string]bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	sessions, ok := c.entries[key]
	return sessions, ok
}

// put stores one validated entry; the key carries the New York date, and older entries are dropped.
func (c *calendarCache) put(key string, sessions map[string]bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = map[string]map[string]bool{key: sessions}
}

// vixSessionDates returns the exchange session dates covering [first, last] (YYYY-MM-DD), read in chunks of at most
// 14 days. Any failure, malformed row or empty coverage returns an error and caches nothing.
func (s *EconomicFeedsService) vixSessionDates(first, last string, now time.Time, newYork *time.Location) (map[string]bool, error) {
	if s.calendar == nil {
		return nil, fmt.Errorf("no calendar reader configured")
	}
	if newYork == nil {
		return nil, fmt.Errorf("New York time zone unavailable")
	}
	start, err := time.Parse("2006-01-02", first)
	if err != nil {
		return nil, fmt.Errorf("bad history start date")
	}
	end, err := time.Parse("2006-01-02", last)
	if err != nil || end.Before(start) {
		return nil, fmt.Errorf("bad history end date")
	}
	key := now.In(newYork).Format("2006-01-02") + "|1d|" + first + "|" + last
	if cached, ok := s.calendarCache.get(key); ok {
		return cached, nil
	}
	sessions := map[string]bool{}
	for chunkStart := start; !chunkStart.After(end); {
		chunkEnd := chunkStart.AddDate(0, 0, calendarChunkDays-1)
		if chunkEnd.After(end) {
			chunkEnd = end
		}
		ctx, cancel := context.WithTimeout(context.Background(), calendarReadTimeout)
		rows, err := s.calendar.GetMarketCalendar(ctx, chunkStart, chunkEnd)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("calendar read failed")
		}
		seen := map[string]bool{}
		for _, row := range rows {
			day, perr := time.Parse("2006-01-02", row.Date)
			if perr != nil || day.Before(chunkStart) || day.After(chunkEnd) || seen[row.Date] ||
				!calendarClockPattern.MatchString(row.Open) || !calendarClockPattern.MatchString(row.Close) || row.Close <= row.Open {
				return nil, fmt.Errorf("calendar returned a malformed row")
			}
			seen[row.Date] = true
			sessions[row.Date] = true
		}
		// A window of five or more days always holds sessions; none means partial coverage.
		if len(seen) == 0 && int(chunkEnd.Sub(chunkStart).Hours()/24)+1 >= 5 {
			return nil, fmt.Errorf("calendar returned no sessions for a full window")
		}
		chunkStart = chunkEnd.AddDate(0, 0, 1)
	}
	if len(sessions) == 0 {
		return nil, fmt.Errorf("calendar returned no sessions")
	}
	s.calendarCache.put(key, sessions)
	return sessions, nil
}
