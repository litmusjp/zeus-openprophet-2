package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

func TestGetOptionExpirationsListsOnlyDatesWithContracts(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	today := time.Now().In(loc)
	// choose two upcoming weekdays that "have" contracts
	var listed []string
	for dte := 1; len(listed) < 2 && dte < 30; dte++ {
		day := today.AddDate(0, 0, dte)
		if day.Weekday() != time.Saturday && day.Weekday() != time.Sunday && dte >= 7 {
			listed = append(listed, day.Format("2006-01-02"))
			dte += 6
		}
	}
	var mu sync.Mutex
	probed := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		date := r.URL.Query().Get("expiration_date")
		mu.Lock()
		probed[date] = true
		mu.Unlock()
		if r.Header.Get("APCA-API-KEY-ID") != "key" || r.URL.Query().Get("limit") != "1" {
			http.Error(w, "bad probe", http.StatusBadRequest)
			return
		}
		for _, d := range listed {
			if d == date {
				_, _ = w.Write([]byte(`{"snapshots":{"SPY261231C00700000":{}}}`))
				return
			}
		}
		_, _ = w.Write([]byte(`{"snapshots":{}}`))
	}))
	defer server.Close()

	s := &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: server.URL, optionsSnapshotHTTP: server.Client()}
	got, err := s.GetOptionExpirations(context.Background(), "spy", 5, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(listed) {
		t.Fatalf("expirations = %+v, want dates %v", got, listed)
	}
	for i, e := range got {
		if e.Date != listed[i] || e.DTE < 5 || e.DTE > 30 {
			t.Fatalf("expiration %d = %+v", i, e)
		}
	}
	for date := range probed {
		parsed, _ := time.Parse("2006-01-02", date)
		if parsed.Weekday() == time.Saturday || parsed.Weekday() == time.Sunday {
			t.Fatalf("weekend date probed: %s", date)
		}
	}
}

func TestListOptionExpirationsReturnsPartialListWhenSomeProbesFail(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	today := time.Now().In(loc)
	var weekdays []string
	for dte := 1; len(weekdays) < 3 && dte < 30; dte++ {
		day := today.AddDate(0, 0, dte)
		if day.Weekday() != time.Saturday && day.Weekday() != time.Sunday {
			weekdays = append(weekdays, day.Format("2006-01-02"))
		}
	}
	failing, listed := weekdays[1], weekdays[2]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("expiration_date") {
		case failing:
			http.Error(w, "boom", http.StatusBadRequest)
		case listed:
			_, _ = w.Write([]byte(`{"snapshots":{"SPY261231C00700000":{}}}`))
		default:
			_, _ = w.Write([]byte(`{"snapshots":{}}`))
		}
	}))
	defer server.Close()
	s := &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: server.URL, optionsSnapshotHTTP: server.Client()}
	result, err := s.ListOptionExpirations(context.Background(), "SPY", 1, 12)
	if err != nil {
		t.Fatalf("a partial failure must not fail the call: %v", err)
	}
	if len(result.Expirations) != 1 || result.Expirations[0].Date != listed {
		t.Fatalf("confirmed dates = %+v, want only %s", result.Expirations, listed)
	}
	if len(result.Unchecked) != 1 || result.Unchecked[0].Date != failing || result.Unchecked[0].Reason == "" {
		t.Fatalf("unchecked = %+v, want only %s", result.Unchecked, failing)
	}
	// the strict form still refuses a list with unchecked dates
	if _, strictErr := s.GetOptionExpirations(context.Background(), "SPY", 1, 12); strictErr == nil || !strings.Contains(strictErr.Error(), "incomplete") {
		t.Fatalf("strict form must fail on an unchecked date, got %v", strictErr)
	}
}

func TestGetOptionExpirationsFailsClosedOnProbeErrorAndBadWindow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusBadRequest)
	}))
	defer server.Close()
	s := &AlpacaTradingService{apiKey: "key", apiSecret: "secret", logger: logrus.New(), optionsSnapshotBaseURL: server.URL, optionsSnapshotHTTP: server.Client()}
	if _, err := s.GetOptionExpirations(context.Background(), "SPY", 1, 10); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("probe failure must fail the call, got %v", err)
	}
	if _, err := s.GetOptionExpirations(context.Background(), "SPY", 10, 5); err == nil {
		t.Fatal("inverted window must be rejected")
	}
	if _, err := s.GetOptionExpirations(context.Background(), "SPY", 0, 200); err == nil {
		t.Fatal("oversized window must be rejected")
	}
}
