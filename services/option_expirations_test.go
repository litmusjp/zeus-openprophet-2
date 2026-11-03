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
