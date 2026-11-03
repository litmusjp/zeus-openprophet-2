package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	earningsSource      = "nasdaq_calendar"
	earningsEndpoint    = "https://api.nasdaq.com/api/calendar/earnings?date="
	earningsCacheTTL    = 6 * time.Hour
	earningsConcurrency = 6
)

// EarningsEvent is one scheduled report from the calendar source.
type EarningsEvent struct {
	Symbol string
	Date   string
	Timing string
}

// EarningsFetcher returns the calendar rows for one date (YYYY-MM-DD).
type EarningsFetcher func(ctx context.Context, date string) ([]EarningsEvent, error)

// EarningsResult is the per-symbol answer. Status "unknown" means the source could not be fully
// read for the window, so absence of a date is NOT evidence that no report is scheduled.
type EarningsResult struct {
	Symbol           string `json:"symbol"`
	Status           string `json:"status"` // scheduled | none_found_in_window | unknown
	NextEarningsDate string `json:"next_earnings_date,omitempty"`
	Timing           string `json:"timing,omitempty"`
}

// EarningsLookup is the full response including how complete the read was.
type EarningsLookup struct {
	Source      string           `json:"source"`
	WindowStart string           `json:"window_start"`
	WindowEnd   string           `json:"window_end"`
	Complete    bool             `json:"complete"`
	FailedDates []string         `json:"failed_dates,omitempty"`
	Results     []EarningsResult `json:"results"`
	Note        string           `json:"note"`
}

type cachedEarningsDay struct {
	events  []EarningsEvent
	fetched time.Time
}

// EarningsCalendar reads a public earnings calendar one weekday at a time and caches each day.
// It is an optional research aid: callers must treat failures as "unknown", never as "none".
type EarningsCalendar struct {
	fetch EarningsFetcher
	mu    sync.Mutex
	cache map[string]cachedEarningsDay
	now   func() time.Time
}

// NewEarningsCalendar builds a calendar backed by the public Nasdaq endpoint (client may be nil).
func NewEarningsCalendar(client *http.Client) *EarningsCalendar {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &EarningsCalendar{fetch: nasdaqEarningsFetcher(client), cache: map[string]cachedEarningsDay{}, now: time.Now}
}

// NewEarningsCalendarWithFetcher is used by tests.
func NewEarningsCalendarWithFetcher(fetch EarningsFetcher, now func() time.Time) *EarningsCalendar {
	return &EarningsCalendar{fetch: fetch, cache: map[string]cachedEarningsDay{}, now: now}
}

func nasdaqTiming(raw string) string {
	switch raw {
	case "time-pre-market":
		return "pre_market"
	case "time-after-hours":
		return "after_hours"
	default:
		return "not_supplied"
	}
}

func nasdaqEarningsFetcher(client *http.Client) EarningsFetcher {
	return func(ctx context.Context, date string) ([]EarningsEvent, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, earningsEndpoint+date, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OpenProphet/2)")
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("earnings calendar status %d", resp.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if err != nil {
			return nil, err
		}
		var doc struct {
			Data *struct {
				Rows []struct {
					Symbol string `json:"symbol"`
					Time   string `json:"time"`
				} `json:"rows"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &doc); err != nil {
			return nil, fmt.Errorf("earnings calendar response was not valid JSON")
		}
		events := []EarningsEvent{}
		if doc.Data != nil {
			for _, row := range doc.Data.Rows {
				if symbol := strings.ToUpper(strings.TrimSpace(row.Symbol)); symbol != "" {
					events = append(events, EarningsEvent{Symbol: symbol, Date: date, Timing: nasdaqTiming(row.Time)})
				}
			}
		}
		return events, nil
	}
}

func (c *EarningsCalendar) day(ctx context.Context, date string) ([]EarningsEvent, error) {
	c.mu.Lock()
	cached, ok := c.cache[date]
	c.mu.Unlock()
	if ok && c.now().Sub(cached.fetched) < earningsCacheTTL {
		return cached.events, nil
	}
	events, err := c.fetch(ctx, date)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.cache[date] = cachedEarningsDay{events: events, fetched: c.now()}
	c.mu.Unlock()
	return events, nil
}

// Lookup checks the next `days` calendar days (weekdays only) starting at `from` for each symbol.
func (c *EarningsCalendar) Lookup(ctx context.Context, symbols []string, from time.Time, days int) EarningsLookup {
	var dates []string
	for offset := 0; offset <= days; offset++ {
		d := from.AddDate(0, 0, offset)
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		dates = append(dates, d.Format("2006-01-02"))
	}
	type dayResult struct {
		date   string
		events []EarningsEvent
		err    error
	}
	results := make([]dayResult, len(dates))
	sem := make(chan struct{}, earningsConcurrency)
	var wg sync.WaitGroup
	for i, date := range dates {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, date string) {
			defer wg.Done()
			defer func() { <-sem }()
			events, err := c.day(ctx, date)
			results[i] = dayResult{date: date, events: events, err: err}
		}(i, date)
	}
	wg.Wait()

	lookup := EarningsLookup{
		Source: earningsSource, WindowStart: from.Format("2006-01-02"), WindowEnd: from.AddDate(0, 0, days).Format("2006-01-02"),
		Complete: true,
	}
	next := map[string]EarningsEvent{}
	for _, r := range results {
		if r.err != nil {
			lookup.Complete = false
			lookup.FailedDates = append(lookup.FailedDates, r.date)
			continue
		}
		for _, event := range r.events {
			if existing, ok := next[event.Symbol]; !ok || event.Date < existing.Date {
				next[event.Symbol] = event
			}
		}
	}
	sort.Strings(lookup.FailedDates)
	for _, symbol := range symbols {
		if event, ok := next[symbol]; ok {
			lookup.Results = append(lookup.Results, EarningsResult{Symbol: symbol, Status: "scheduled", NextEarningsDate: event.Date, Timing: event.Timing})
		} else if lookup.Complete {
			lookup.Results = append(lookup.Results, EarningsResult{Symbol: symbol, Status: "none_found_in_window"})
		} else {
			lookup.Results = append(lookup.Results, EarningsResult{Symbol: symbol, Status: "unknown"})
		}
	}
	lookup.Note = "Public calendar data, not broker-verified. 'unknown' means part of the window could not be read, so no date does not mean no report. ETFs normally report no earnings."
	return lookup
}
