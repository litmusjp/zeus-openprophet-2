package services

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
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
	return &EconomicFeedsService{httpClient: &http.Client{Transport: transport}, clock: func() time.Time { return now }}, transport
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
		"all round to zero":    `0.001,0.009`,
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
