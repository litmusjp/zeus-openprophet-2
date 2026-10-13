package services

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

type yahooFixtureTransport struct{ body string }

func (t yahooFixtureTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(t.body)), Header: make(http.Header)}, nil
}

func TestFetchYFQuoteUsesPreviousCompletedSessionClose(t *testing.T) {
	stamp := func(v string) int64 { x, _ := time.Parse(time.RFC3339, v); return x.Unix() }
	body := `{"chart":{"result":[{"meta":{"regularMarketPrice":761.0,"regularMarketTime":` + fmtInt(stamp("2026-10-14T16:00:00Z")) + `,"exchangeTimezoneName":"America/New_York","exchangeName":"NMS","currency":"USD","chartPreviousClose":759.66},"timestamp":[` + fmtInt(stamp("2026-10-12T04:00:00Z")) + `,` + fmtInt(stamp("2026-10-13T04:00:00Z")) + `,` + fmtInt(stamp("2026-10-14T04:00:00Z")) + `],"indicators":{"quote":[{"close":[740,746,759.66]}]}}],"error":null}}`
	s := &EconomicFeedsService{httpClient: &http.Client{Transport: yahooFixtureTransport{body}}}
	q, err := s.fetchYFQuote("QQQ", "Nasdaq 100")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	b, _ := json.Marshal(q)
	_ = json.Unmarshal(b, &payload)
	if q.PrevClose != 746 || payload["prev_close_date"] != "2026-10-13" || payload["prev_close_source"] != "Yahoo Finance daily history" || payload["prev_close_available"] != true || payload["change_available"] != true || q.Change != 15 {
		t.Fatalf("quote reference = %+v", q)
	}
}

func TestFetchYFQuoteDoesNotFabricateMissingReferenceClose(t *testing.T) {
	marketTime := time.Date(2026, 10, 14, 16, 0, 0, 0, time.UTC).Unix()
	body := `{"chart":{"result":[{"meta":{"regularMarketPrice":761,"regularMarketTime":` + fmtInt(marketTime) + `,"exchangeTimezoneName":"America/New_York","chartPreviousClose":759.66},"timestamp":[` + fmtInt(marketTime) + `],"indicators":{"quote":[{"close":[759.66]}]}}],"error":null}}`
	s := &EconomicFeedsService{httpClient: &http.Client{Transport: yahooFixtureTransport{body}}}
	q, err := s.fetchYFQuote("QQQ", "Nasdaq 100")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	b, _ := json.Marshal(q)
	_ = json.Unmarshal(b, &payload)
	if payload["prev_close_available"] != false || payload["change_available"] != false || payload["prev_close_source"] != nil || payload["prev_close_date"] != nil {
		t.Fatalf("missing reference marked available: %+v", q)
	}
}

func TestFetchYFQuoteReferencesPriorSessionAcrossPremarketAfterHoursAndWeekend(t *testing.T) {
	bar13 := time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC).Unix()
	bar16 := time.Date(2026, 10, 16, 4, 0, 0, 0, time.UTC).Unix()
	bar15 := time.Date(2026, 10, 15, 4, 0, 0, 0, time.UTC).Unix()
	for _, tc := range []struct {
		name, marketTime, wantDate string
		want                       float64
	}{
		{"premarket", "2026-10-14T12:00:00Z", "2026-10-13", 746},
		{"after-hours", "2026-10-14T23:00:00Z", "2026-10-13", 746},
		{"weekend-stale-friday-quote", "2026-10-16T20:00:00Z", "2026-10-15", 750},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mt, _ := time.Parse(time.RFC3339, tc.marketTime)
			body := `{"chart":{"result":[{"meta":{"regularMarketPrice":760,"regularMarketTime":` + fmtInt(mt.Unix()) + `,"exchangeTimezoneName":"America/New_York","exchangeName":"NMS","currency":"USD","chartPreviousClose":759.66},"timestamp":[` + fmtInt(bar13) + `,` + fmtInt(bar15) + `,` + fmtInt(bar16) + `],"indicators":{"quote":[{"close":[746,750,752]}]}}],"error":null}}`
			s := &EconomicFeedsService{httpClient: &http.Client{Transport: yahooFixtureTransport{body}}}
			q, err := s.fetchYFQuote("QQQ", "Nasdaq 100")
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			b, _ := json.Marshal(q)
			_ = json.Unmarshal(b, &payload)
			if q.PrevClose != tc.want || payload["prev_close_date"] != tc.wantDate || payload["prev_close_available"] != true {
				t.Fatalf("reference=%+v", q)
			}
		})
	}
}

func fmtInt(v int64) string { return strconv.FormatInt(v, 10) }
