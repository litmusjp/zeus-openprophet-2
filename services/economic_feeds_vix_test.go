package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// symbolTransport answers each Yahoo chart request by symbol and records the requested range.
type symbolTransport struct {
	ranges map[string]string
	bodies map[string]string // per-symbol override; "" means a transport error
	body   string
}

func (t *symbolTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	symbol := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	t.ranges[symbol] = r.URL.Query().Get("range")
	body := t.body
	if override, ok := t.bodies[symbol]; ok {
		if override == "" {
			return nil, errors.New("fixture transport failure")
		}
		body = override
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
}

// yahooBody builds a chart reply with one 09:30 New York bar per date; closes are raw JSON values.
func yahooBody(marketTime time.Time, dates []string, closes string) string {
	stamps := make([]string, len(dates))
	for i, date := range dates {
		day, _ := time.Parse("2006-01-02", date)
		stamps[i] = fmtInt(day.Add(14*time.Hour + 30*time.Minute).Unix())
	}
	return `{"chart":{"result":[{"meta":{"regularMarketPrice":19.5,"regularMarketTime":` + fmtInt(marketTime.Unix()) +
		`,"exchangeTimezoneName":"America/Chicago","exchangeName":"CXI","currency":"USD"},"timestamp":[` + strings.Join(stamps, ",") +
		`],"indicators":{"quote":[{"close":[` + closes + `]}]}}],"error":null}}`
}

func newVIXFixture(now time.Time, body string) (*EconomicFeedsService, *symbolTransport) {
	transport := &symbolTransport{ranges: map[string]string{}, bodies: map[string]string{}, body: body}
	// the default calendar treats every weekday as a session, so the older tests keep their meaning
	return &EconomicFeedsService{httpClient: &http.Client{Transport: transport}, clock: func() time.Time { return now }, calendar: &fakeCalendar{}}, transport
}

func completeFlags(t *testing.T, history []YFBar) []bool {
	t.Helper()
	flags := make([]bool, len(history))
	for i, bar := range history {
		if bar.Complete == nil {
			t.Fatalf("entry %s has no complete flag", bar.Date)
		}
		flags[i] = *bar.Complete
	}
	return flags
}

func TestYFDailyBarComplete(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	for _, tc := range []struct {
		name, date, now string
		want            bool
	}{
		{"today, morning", "2026-11-25", "2026-11-25T14:00:00Z", false},
		{"today, one second before 16:15", "2026-11-25", "2026-11-25T21:14:59Z", false},
		{"today, at 16:15", "2026-11-25", "2026-11-25T21:15:00Z", true},
		{"today, after 16:15", "2026-11-25", "2026-11-25T23:00:00Z", true},
		{"summer time, before 16:15", "2026-07-15", "2026-07-15T20:14:59Z", false},
		{"summer time, at 16:15", "2026-07-15", "2026-07-15T20:15:00Z", true},
		{"UTC already tomorrow, New York still today after the close", "2026-11-25", "2026-11-26T03:00:00Z", true},
		{"UTC already tomorrow, that date is still future in New York", "2026-11-26", "2026-11-26T03:00:00Z", false},
		{"Friday seen on Saturday morning", "2026-11-20", "2026-11-21T12:00:00Z", true},
		{"old date", "2026-08-27", "2026-11-25T14:00:00Z", true},
		{"yesterday before 16:15 today", "2026-11-24", "2026-11-25T14:00:00Z", true},
		{"future date, after 16:15", "2026-11-27", "2026-11-25T23:00:00Z", false},
	} {
		now, _ := time.Parse(time.RFC3339, tc.now)
		if got := yfDailyBarComplete(tc.date, now, ny); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
		if yfDailyBarComplete(tc.date, now, nil) {
			t.Errorf("%s: without the New York zone nothing may be complete", tc.name)
		}
	}
}

func TestFetchVIXMarksCompletenessAgainstTheCurrentTime(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	dates := []string{"2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"}
	// regularMarketTime is after 16:15 on purpose: only the current time may decide.
	body := yahooBody(time.Date(2026, 11, 25, 16, 30, 0, 0, ny), dates, `18,null,18.5,19.25,19.75`)
	for _, tc := range []struct {
		name string
		now  time.Time
		want []bool
	}{
		{"before 16:15", time.Date(2026, 11, 25, 16, 14, 59, 0, ny), []bool{true, true, false, false}},
		{"at 16:15", time.Date(2026, 11, 25, 16, 15, 0, 0, ny), []bool{true, true, true, false}},
		{"after 16:15", time.Date(2026, 11, 25, 18, 0, 0, 0, ny), []bool{true, true, true, false}},
	} {
		s, _ := newVIXFixture(tc.now, body)
		q, err := s.fetchYFQuote("^VIX", "VIX")
		if err != nil {
			t.Fatal(err)
		}
		// the null close of 2026-11-23 is skipped, not reported
		var got []string
		for _, bar := range q.History {
			got = append(got, bar.Date)
		}
		if want := []string{"2026-11-20", "2026-11-24", "2026-11-25", "2026-11-26"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: dates = %v", tc.name, got)
		}
		if flags := completeFlags(t, q.History); !reflect.DeepEqual(flags, tc.want) {
			t.Fatalf("%s: complete = %v, want %v", tc.name, flags, tc.want)
		}
		// prev_close keeps its rule: the latest close before the quote's own market date, complete flag or not
		if q.PrevClose != 18.5 || q.PrevCloseDate != "2026-11-24" || !q.PrevCloseAvailable {
			t.Fatalf("%s: prev close = %+v", tc.name, q)
		}
		raw, _ := json.Marshal(q)
		if strings.Count(string(raw), `"complete":`) != len(q.History) {
			t.Fatalf("%s: every entry, false ones included, must emit complete: %s", tc.name, raw)
		}
	}
}

func TestOnlyVIXGetsTheLongRangeAndTheCompleteFlag(t *testing.T) {
	marketTime := time.Date(2026, 11, 25, 21, 0, 0, 0, time.UTC)
	body := yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, `18.5,19.5`)
	s, transport := newVIXFixture(marketTime, body)
	briefing, err := s.GetYFinanceBriefing()
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, group := range yfSymbols {
		total += len(group)
	}
	if len(transport.ranges) != total {
		t.Fatalf("requested %d symbols, want %d: %v", len(transport.ranges), total, transport.ranges)
	}
	for symbol, got := range transport.ranges {
		want := "5d"
		if symbol == "^VIX" {
			want = "3mo"
		}
		if got != want {
			t.Errorf("%s range = %s, want %s", symbol, got, want)
		}
	}
	others := append(append(append(append([]YFQuote{}, briefing.Indexes...), briefing.Rates...), briefing.Commodities...), briefing.Crypto...)
	if len(others) != total-1 || len(briefing.Volatility) != 1 {
		t.Fatalf("quotes: others=%d volatility=%d", len(others), len(briefing.Volatility))
	}
	for _, q := range others {
		raw, _ := json.Marshal(q.History)
		// exact bytes of a non-VIX history, unchanged by this feature
		if string(raw) != `[{"date":"2026-11-24","close":18.5},{"date":"2026-11-25","close":19.5}]` {
			t.Fatalf("%s history = %s", q.Symbol, raw)
		}
	}
	completeFlags(t, briefing.Volatility[0].History)
	raw, _ := json.Marshal(briefing)
	if strings.Contains(string(raw), `"unavailable"`) {
		t.Fatalf("unavailable must be omitted when nothing failed: %s", raw)
	}
}

func TestBriefingNamesFailedAndUnusableSymbols(t *testing.T) {
	marketTime := time.Date(2026, 11, 25, 21, 0, 0, 0, time.UTC)
	good := yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, `18.5,19.5`)
	for name, vix := range map[string]string{
		"transport error": "",
		"not JSON":        "Too Many Requests",
		"provider error":  `{"chart":{"result":null,"error":{"code":"Not Found"}}}`,
		"no history":      `{"chart":{"result":[{"meta":{"regularMarketPrice":19.5}}],"error":null}}`,
		"empty history":   yahooBody(marketTime, nil, ``),
		"all closes null": yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, `null,null`),
		"no usable close": yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, `0,null`),
	} {
		t.Run(name, func(t *testing.T) {
			s, transport := newVIXFixture(marketTime, good)
			transport.bodies["^VIX"] = vix
			briefing, err := s.GetYFinanceBriefing()
			if err != nil {
				t.Fatal(err)
			}
			if len(briefing.Volatility) != 0 || !reflect.DeepEqual(briefing.Unavailable, []string{"^VIX"}) {
				t.Fatalf("volatility=%+v unavailable=%v", briefing.Volatility, briefing.Unavailable)
			}
			if len(briefing.Indexes) != 4 {
				t.Fatalf("other symbols must still be served: %+v", briefing.Indexes)
			}
			raw, _ := json.Marshal(briefing)
			if !strings.Contains(string(raw), `"unavailable":["^VIX"]`) {
				t.Fatalf("JSON = %s", raw)
			}
		})
	}
	// every failed symbol is named, in a stable order
	s, transport := newVIXFixture(marketTime, good)
	transport.bodies["^VIX"], transport.bodies["SPY"], transport.bodies["TLT"] = "", "", ""
	briefing, err := s.GetYFinanceBriefing()
	if err != nil || !reflect.DeepEqual(briefing.Unavailable, []string{"SPY", "TLT", "^VIX"}) {
		t.Fatalf("unavailable=%v err=%v", briefing.Unavailable, err)
	}
}

func TestNonVIXSymbolWithoutHistoryIsNotTreatedAsFailed(t *testing.T) {
	s, _ := newVIXFixture(time.Now(), `{"chart":{"result":[{"meta":{"regularMarketPrice":19.5}}],"error":null}}`)
	if q, err := s.fetchYFQuote("QQQ", "Nasdaq 100"); err != nil || q.Price != 19.5 {
		t.Fatalf("existing behaviour for other symbols changed: %+v %v", q, err)
	}
}

// B01: a malformed or non-positive ^VIX row must never appear in the history, let alone as a completed close.
func TestVIXDropsInvalidRowsBesideValidOnes(t *testing.T) {
	marketTime := time.Date(2026, 11, 25, 22, 0, 0, 0, time.UTC)
	// eleven valid completed sessions: the least Barometer needs
	dates := []string{"2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"}
	closes := []string{"17.1", "17.2", "17.3", "17.4", "17.5", "17.6", "17.7", "17.8", "17.9", "18.1", "18.2"}
	stamp := func(date string) string {
		day, _ := time.Parse("2006-01-02", date)
		return fmtInt(day.Add(14*time.Hour + 30*time.Minute).Unix())
	}
	good := stamp("2026-11-25")
	for name, bad := range map[string]struct{ ts, close string }{
		"zero close":           {good, "0"},
		"negative close":       {good, "-2.5"},
		"close rounds to zero": {good, "0.004"},
		"huge close":           {good, "1e300"},
		"string close":         {good, `"not-a-number"`},
		"numeric string close": {good, `"19.5"`},
		"boolean close":        {good, "true"},
		"object close":         {good, "{}"},
		"null close":           {good, "null"},
		"string timestamp":     {`"not-a-number"`, "17"},
		"null timestamp":       {"null", "17"},
		"zero timestamp":       {"0", "17"},
		"negative timestamp":   {"-86400", "17"},
		"tiny timestamp":       {"17", "17"},
		"millisecond stamp":    {good + "000", "17"},
		"fractional timestamp": {good + ".5", "17"},
	} {
		t.Run(name, func(t *testing.T) {
			stamps := make([]string, 0, 12)
			values := make([]string, 0, 12)
			for i, date := range dates {
				stamps, values = append(stamps, stamp(date)), append(values, closes[i])
				if i == 5 { // the bad row sits among the valid ones
					stamps, values = append(stamps, bad.ts), append(values, bad.close)
				}
			}
			body := `{"chart":{"result":[{"meta":{"regularMarketPrice":18.2,"regularMarketTime":` + fmtInt(marketTime.Unix()) +
				`,"exchangeTimezoneName":"America/Chicago"},"timestamp":[` + strings.Join(stamps, ",") +
				`],"indicators":{"quote":[{"close":[` + strings.Join(values, ",") + `]}]}}],"error":null}}`
			s, _ := newVIXFixture(marketTime, body)
			q, err := s.fetchYFQuote("^VIX", "VIX")
			if err != nil {
				t.Fatal(err)
			}
			if len(q.History) != len(dates) {
				t.Fatalf("history must hold only the %d valid rows, got %d: %+v", len(dates), len(q.History), q.History)
			}
			for i, bar := range q.History {
				if bar.Date != dates[i] || bar.Close <= 0 || bar.Complete == nil || !*bar.Complete {
					t.Fatalf("row %d = %+v, want a complete positive close dated %s", i, bar, dates[i])
				}
			}
		})
	}
}

func TestVIXWithOnlyInvalidRowsIsUnavailable(t *testing.T) {
	marketTime := time.Date(2026, 11, 25, 22, 0, 0, 0, time.UTC)
	for name, closes := range map[string]string{
		"all zero or negative": `0,-1`,
		"all wrong type":       `"a",true`,
		"all round to zero":    `0.001,0.004`,
	} {
		t.Run(name, func(t *testing.T) {
			s, transport := newVIXFixture(marketTime, yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, `18.5,19.5`))
			transport.bodies["^VIX"] = yahooBody(marketTime, []string{"2026-11-24", "2026-11-25"}, closes)
			briefing, err := s.GetYFinanceBriefing()
			if err != nil || len(briefing.Volatility) != 0 || !reflect.DeepEqual(briefing.Unavailable, []string{"^VIX"}) {
				t.Fatalf("volatility=%+v unavailable=%v err=%v", briefing.Volatility, briefing.Unavailable, err)
			}
		})
	}
}

// The new validation is for ^VIX only: other symbols keep their previous output for the same rows.
func TestNonVIXHistoryIsNotFiltered(t *testing.T) {
	marketTime := time.Date(2026, 11, 25, 22, 0, 0, 0, time.UTC)
	s, _ := newVIXFixture(marketTime, yahooBody(marketTime, []string{"2026-11-23", "2026-11-24", "2026-11-25"}, `0,-2.5,"x"`))
	q, err := s.fetchYFQuote("SPY", "S&P 500")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(q.History)
	want := `[{"date":"2026-11-23","close":0},{"date":"2026-11-24","close":-2.5},{"date":"2026-11-25","close":0}]`
	if string(raw) != want {
		t.Fatalf("history = %s, want %s", raw, want)
	}
}

// ---- F1: ^VIX history on exchange sessions only ----

type calendarCall struct{ start, end time.Time }

// fakeCalendar answers like the broker: one row per weekday that is not a holiday, 09:30-16:00 (or the override).
type fakeCalendar struct {
	mu       sync.Mutex
	calls    []calendarCall
	holidays map[string]bool
	override map[string]interfaces.MarketSession // replaces or adds a row by date
	failCall int                                  // 1-based call number that fails; 0 means none
	failAll  bool
	mangle   func(rows []interfaces.MarketSession) []interfaces.MarketSession
}

func (f *fakeCalendar) GetMarketCalendar(_ context.Context, start, end time.Time) ([]interfaces.MarketSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, calendarCall{start, end})
	if f.failAll || (f.failCall != 0 && len(f.calls) == f.failCall) {
		return nil, errors.New("fixture calendar failure")
	}
	if end.Sub(start) > 14*24*time.Hour {
		return nil, errors.New("invalid market calendar range")
	}
	var rows []interfaces.MarketSession
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		if row, ok := f.override[date]; ok {
			rows = append(rows, row)
			continue
		}
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday || f.holidays[date] {
			continue
		}
		rows = append(rows, interfaces.MarketSession{Date: date, Open: "09:30", Close: "16:00"})
	}
	if f.mangle != nil {
		rows = f.mangle(rows)
	}
	return rows, nil
}

func (f *fakeCalendar) callCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

func novemberCalendar() *fakeCalendar {
	return &fakeCalendar{holidays: map[string]bool{"2026-11-26": true, "2026-09-07": true}}
}

func withCalendar(s *EconomicFeedsService, cal MarketCalendarReader) *EconomicFeedsService {
	s.calendar = cal
	return s
}

func mustNY(t *testing.T) *time.Location {
	t.Helper()
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	return ny
}

// weekdayRange lists every weekday date from first to last, holidays included (Yahoo-style padding).
func weekdayRange(first, last string) ([]string, string) {
	day, _ := time.Parse("2006-01-02", first)
	end, _ := time.Parse("2006-01-02", last)
	var dates, closes []string
	for n := 0; !day.After(end); day = day.AddDate(0, 0, 1) {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		dates = append(dates, day.Format("2006-01-02"))
		closes = append(closes, fmt.Sprintf("%d.%02d", 15+n%10, n%100))
		n++
	}
	return dates, strings.Join(closes, ",")
}

func vixHistoryDates(q *YFQuote) []string {
	var out []string
	for _, bar := range q.History {
		out = append(out, bar.Date)
	}
	return out
}

func containsDate(dates []string, date string) bool {
	for _, d := range dates {
		if d == date {
			return true
		}
	}
	return false
}

func latestCompleteDate(q *YFQuote) string {
	latest := ""
	for _, bar := range q.History {
		if bar.Complete != nil && *bar.Complete && bar.Date > latest {
			latest = bar.Date
		}
	}
	return latest
}

func assertNoUsableVIX(t *testing.T, q *YFQuote) {
	t.Helper()
	if q.CalendarStatus != "unavailable" {
		t.Fatalf("calendar_status = %q, want unavailable", q.CalendarStatus)
	}
	if len(q.History) == 0 {
		t.Fatal("history should still be returned, all incomplete")
	}
	for _, bar := range q.History {
		if bar.Complete == nil || *bar.Complete {
			t.Fatalf("row %s must be complete=false: %+v", bar.Date, bar)
		}
	}
	if q.PrevCloseAvailable || q.PrevClose != 0 || q.PrevCloseDate != "" || q.ChangeAvailable {
		t.Fatalf("prev_close must be withheld: %+v", q)
	}
	raw, _ := json.Marshal(q)
	if !strings.Contains(string(raw), `"calendar_status":"unavailable"`) {
		t.Fatalf("JSON lacks calendar metadata: %s", raw)
	}
}

func TestVIXThreeMonthHistoryUsesAtMostFourteenDayCalendarChunks(t *testing.T) {
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-09-01", "2026-11-27")
	now := time.Date(2026, 11, 27, 17, 0, 0, 0, ny)
	s, _ := newVIXFixture(now, yahooBody(now, dates, closes))
	cal := novemberCalendar()
	withCalendar(s, cal)
	q, err := s.fetchYFQuote("^VIX", "VIX")
	if err != nil {
		t.Fatal(err)
	}
	if cal.callCount() < 6 {
		t.Fatalf("expected several chunks for ~3 months, got %d", cal.callCount())
	}
	first, _ := time.Parse("2006-01-02", "2026-09-01")
	last, _ := time.Parse("2006-01-02", "2026-11-27")
	cursor := first
	for i, call := range cal.calls {
		if call.end.Sub(call.start) > 14*24*time.Hour {
			t.Fatalf("call %d spans more than 14 days: %v..%v", i, call.start, call.end)
		}
		if !call.start.Equal(cursor) {
			t.Fatalf("call %d starts %v, want contiguous %v", i, call.start, cursor)
		}
		cursor = call.end.AddDate(0, 0, 1)
	}
	if !cal.calls[len(cal.calls)-1].end.Equal(last) {
		t.Fatalf("coverage ends %v, want %v", cal.calls[len(cal.calls)-1].end, last)
	}
	got := vixHistoryDates(q)
	for _, holiday := range []string{"2026-09-07", "2026-11-26"} {
		if containsDate(got, holiday) {
			t.Fatalf("%s must be dropped", holiday)
		}
	}
	for _, kept := range []string{"2026-11-25", "2026-11-27"} {
		if !containsDate(got, kept) {
			t.Fatalf("%s must stay", kept)
		}
	}
	if q.CalendarStatus != "ok" || len(got) != len(dates)-2 {
		t.Fatalf("status=%s kept=%d want %d", q.CalendarStatus, len(got), len(dates)-2)
	}
	if latestCompleteDate(q) != "2026-11-27" {
		t.Fatalf("latest complete = %s", latestCompleteDate(q))
	}
}

func TestVIXCalendarFailureLeavesNoUsableRows(t *testing.T) {
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-09-01", "2026-11-27")
	now := time.Date(2026, 11, 27, 17, 0, 0, 0, ny)
	for name, cal := range map[string]*fakeCalendar{
		"failure in the middle chunk": {holidays: map[string]bool{"2026-11-26": true}, failCall: 3},
		"failure on the first chunk":  {failCall: 1},
		"failure on every chunk":      {failAll: true},
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := newVIXFixture(now, yahooBody(now, dates, closes))
			withCalendar(s, cal)
			q, err := s.fetchYFQuote("^VIX", "VIX")
			if err != nil {
				t.Fatal(err)
			}
			assertNoUsableVIX(t, q)
			if len(q.History) != len(dates) {
				t.Fatalf("no weekday inference or silent filtering: %d rows, want %d", len(q.History), len(dates))
			}
			if latestCompleteDate(q) != "" {
				t.Fatalf("no completed date may exist, got %s", latestCompleteDate(q))
			}
			if len(s.calendarCache.entries) != 0 {
				t.Fatalf("a failure must not be cached: %v", s.calendarCache.entries)
			}
		})
	}
}

func TestVIXMalformedCalendarRowLeavesNoUsableRows(t *testing.T) {
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-11-02", "2026-11-27")
	now := time.Date(2026, 11, 27, 17, 0, 0, 0, ny)
	outside := interfaces.MarketSession{Date: "2026-11-25", Open: "09:30", Close: "16:00"}
	type rows = []interfaces.MarketSession
	for name, mangle := range map[string]func(rows) rows{
		"unparsable date":     func(r rows) rows { r[1].Date = "11/04/2026"; return r },
		"empty date":          func(r rows) rows { r[1].Date = ""; return r },
		"date outside window": func(r rows) rows { return append(r, outside) },
		"duplicate date":      func(r rows) rows { return append(r, r[0]) },
		"missing open":        func(r rows) rows { r[0].Open = ""; return r },
		"missing close":       func(r rows) rows { r[0].Close = ""; return r },
		"close before open":   func(r rows) rows { r[0].Close = "09:00"; return r },
		"non-time open":       func(r rows) rows { r[0].Open = "soon"; return r },
		"empty window":        func(r rows) rows { return nil },
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := newVIXFixture(now, yahooBody(now, dates, closes))
			cal := novemberCalendar()
			cal.mangle = func(r rows) rows {
				if len(r) < 3 {
					return r
				}
				return mangle(r)
			}
			withCalendar(s, cal)
			q, err := s.fetchYFQuote("^VIX", "VIX")
			if err != nil {
				t.Fatal(err)
			}
			assertNoUsableVIX(t, q)
			if len(s.calendarCache.entries) != 0 {
				t.Fatal("malformed coverage must not be cached")
			}
		})
	}
}

func TestVIXFailedLookupRecoversOnALaterSuccess(t *testing.T) {
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-11-02", "2026-11-27")
	now := time.Date(2026, 11, 27, 17, 0, 0, 0, ny)
	s, _ := newVIXFixture(now, yahooBody(now, dates, closes))
	cal := novemberCalendar()
	cal.failCall = 1
	withCalendar(s, cal)
	q, err := s.fetchYFQuote("^VIX", "VIX")
	if err != nil {
		t.Fatal(err)
	}
	assertNoUsableVIX(t, q)
	callsAfterFailure := cal.callCount()
	q, err = s.fetchYFQuote("^VIX", "VIX")
	if err != nil {
		t.Fatal(err)
	}
	if q.CalendarStatus != "ok" || latestCompleteDate(q) != "2026-11-27" || containsDate(vixHistoryDates(q), "2026-11-26") {
		t.Fatalf("no recovery: status=%s latest=%s dates=%v", q.CalendarStatus, latestCompleteDate(q), vixHistoryDates(q))
	}
	if cal.callCount() <= callsAfterFailure {
		t.Fatal("the failed lookup was cached: the second request never asked the calendar again")
	}
	// the success is cached: a third request makes no calendar call
	before := cal.callCount()
	if _, err = s.fetchYFQuote("^VIX", "VIX"); err != nil || cal.callCount() != before {
		t.Fatalf("validated coverage must be cached: calls %d -> %d err=%v", before, cal.callCount(), err)
	}
}

func TestVIXCalendarCacheBoundaries(t *testing.T) {
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-11-02", "2026-11-27")
	body := yahooBody(time.Date(2026, 11, 27, 17, 0, 0, 0, ny), dates, closes)
	cal := novemberCalendar()
	var clockNow time.Time
	s, _ := newVIXFixture(time.Now(), body)
	s.clock = func() time.Time { return clockNow }
	withCalendar(s, cal)
	fetch := func(at time.Time) {
		t.Helper()
		clockNow = at
		if q, err := s.fetchYFQuote("^VIX", "VIX"); err != nil || q.CalendarStatus != "ok" {
			t.Fatalf("fetch at %v: %v %+v", at, err, q)
		}
	}
	fetch(time.Date(2026, 11, 27, 9, 0, 0, 0, ny))
	base := cal.callCount()
	fetch(time.Date(2026, 11, 27, 23, 59, 59, 0, ny)) // same New York date: cached
	if cal.callCount() != base {
		t.Fatalf("same NY date must hit the cache: %d -> %d", base, cal.callCount())
	}
	// UTC has already rolled to 28 Nov while New York is still 27 Nov: same key
	fetch(time.Date(2026, 11, 28, 4, 59, 59, 0, time.UTC))
	if cal.callCount() != base {
		t.Fatalf("the New York date, not UTC, keys the cache: %d -> %d", base, cal.callCount())
	}
	fetch(time.Date(2026, 11, 28, 0, 0, 0, 0, ny)) // next New York date: refetched
	if cal.callCount() == base {
		t.Fatal("a new NY date must refetch")
	}
	// a different covered interval is a different key
	more, moreCloses := weekdayRange("2026-10-26", "2026-11-27")
	s.httpClient = &http.Client{Transport: &symbolTransport{ranges: map[string]string{}, bodies: map[string]string{}, body: yahooBody(time.Date(2026, 11, 27, 17, 0, 0, 0, ny), more, moreCloses)}}
	before := cal.callCount()
	fetch(time.Date(2026, 11, 28, 9, 0, 0, 0, ny))
	if cal.callCount() == before {
		t.Fatal("a different interval must not reuse the cached coverage")
	}
}

func TestProductionConstructorBindsTheTradingServiceAsCalendar(t *testing.T) {
	trading := &AlpacaTradingService{}
	s := NewEconomicFeedsServiceWithTrading(trading)
	if got, ok := s.calendar.(*AlpacaTradingService); !ok || got != trading {
		t.Fatalf("calendar = %#v, want the trading service", s.calendar)
	}
	if s.httpClient == nil {
		t.Fatal("constructor must keep the normal service setup")
	}
	if none := NewEconomicFeedsServiceWithTrading(nil); none.calendar != nil {
		t.Fatal("a nil trading service must leave no calendar (not a typed nil)")
	}
	// the production binary uses this constructor
	src, err := os.ReadFile("../cmd/bot/main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "services.NewEconomicFeedsServiceWithTrading(tradingService)") || strings.Contains(string(src), "services.NewEconomicFeedsService()") {
		t.Fatal("cmd/bot/main.go must build the economic feeds service from the trading service")
	}
	// and without a calendar no VIX row is usable
	ny := mustNY(t)
	dates, closes := weekdayRange("2026-11-02", "2026-11-27")
	now := time.Date(2026, 11, 27, 17, 0, 0, 0, ny)
	fixture, _ := newVIXFixture(now, yahooBody(now, dates, closes))
	fixture.calendar = NewEconomicFeedsServiceWithTrading(nil).calendar
	q, err := fixture.fetchYFQuote("^VIX", "VIX")
	if err != nil {
		t.Fatal(err)
	}
	assertNoUsableVIX(t, q)
}

func TestVIXHalfDayCutoffAfterHolidayFiltering(t *testing.T) {
	ny := mustNY(t)
	dates := []string{"2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"}
	body := yahooBody(time.Date(2026, 11, 27, 13, 0, 0, 0, ny), dates, `17.1,17.2,28.29,99,27.5`)
	for _, tc := range []struct {
		name       string
		now        time.Time
		wantLatest string
	}{
		{"13:15 ET half day: 27 Nov not final yet", time.Date(2026, 11, 27, 13, 15, 0, 0, ny), "2026-11-25"},
		{"16:05 ET: still short of the VIX cutoff", time.Date(2026, 11, 27, 16, 5, 0, 0, ny), "2026-11-25"},
		{"16:15 ET: 27 Nov complete", time.Date(2026, 11, 27, 16, 15, 0, 0, ny), "2026-11-27"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newVIXFixture(tc.now, body)
			withCalendar(s, &fakeCalendar{
				holidays: map[string]bool{"2026-11-26": true},
				override: map[string]interfaces.MarketSession{"2026-11-27": {Date: "2026-11-27", Open: "09:30", Close: "13:00"}},
			})
			q, err := s.fetchYFQuote("^VIX", "VIX")
			if err != nil {
				t.Fatal(err)
			}
			if containsDate(vixHistoryDates(q), "2026-11-26") {
				t.Fatalf("26 Nov must be dropped: %v", vixHistoryDates(q))
			}
			if got := latestCompleteDate(q); got != tc.wantLatest {
				t.Fatalf("latest complete = %s, want %s", got, tc.wantLatest)
			}
		})
	}
}

func TestVIXRoundsHalfAwayFromZeroAndKeepsRejections(t *testing.T) {
	stamp := float64(1795000000) // inside 2000..2100
	for _, tc := range []struct {
		name  string
		close interface{}
		want  float64
		ok    bool
	}{
		{"26.7999 rounds up", 26.7999, 26.80, true},
		{"26.794 rounds down", 26.794, 26.79, true},
		{"26.995 rounds up", 26.995, 27.0, true},
		{"half cent rounds up", 0.005, 0.01, true},
		{"below half cent is zero and rejected", 0.0049, 0, false},
		{"tiny", 1e-9, 0, false},
		{"zero", 0.0, 0, false},
		{"negative", -3.2, 0, false},
		{"huge", 1e6, 0, false},
		{"string", "19.5", 0, false},
		{"nil", nil, 0, false},
		{"bool", true, 0, false},
	} {
		bar, ok := yfVIXBar(stamp, tc.close, time.UTC)
		if ok != tc.ok || (ok && bar.Close != tc.want) {
			t.Errorf("%s: got %+v ok=%v, want %v ok=%v", tc.name, bar, ok, tc.want, tc.ok)
		}
	}
	for _, bad := range []interface{}{nil, "1795000000", 0.0, -1.0, 1795000000.5, 1795000000000.0} {
		if _, ok := yfVIXBar(bad, 19.5, time.UTC); ok {
			t.Errorf("timestamp %v must be rejected", bad)
		}
	}
}

func TestNonVIXSymbolsNeverTouchTheCalendar(t *testing.T) {
	now := time.Date(2026, 11, 25, 22, 0, 0, 0, time.UTC)
	s, _ := newVIXFixture(now, yahooBody(now, []string{"2026-11-24", "2026-11-25"}, `18.5,19.255`))
	cal := &fakeCalendar{failAll: true}
	withCalendar(s, cal)
	q, err := s.fetchYFQuote("SPY", "S&P 500")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(q)
	if cal.callCount() != 0 || strings.Contains(string(raw), "calendar_status") {
		t.Fatalf("other symbols must be unchanged: calls=%d %s", cal.callCount(), raw)
	}
	if q.History[1].Close != 19.25 { // still truncated, not rounded
		t.Fatalf("non-VIX rounding changed: %+v", q.History)
	}
}
