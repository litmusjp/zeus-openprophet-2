package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxExpirationWindowDays = 90
	expirationConcurrency   = 6
)

// OptionExpiration is one date on which the underlying has listed option contracts.
type OptionExpiration struct {
	Date string `json:"date"`
	DTE  int    `json:"dte"`
}

// GetOptionExpirations lists listed expiries between minDTE and maxDTE calendar days from today
// (New York date). It probes each weekday with a one-contract snapshot request on the same data
// endpoint and credentials the chain uses, so a date appears only when contracts actually exist.
// Any probe failure fails the whole call: a partial list could hide the expiry the caller needs.
func (s *AlpacaTradingService) GetOptionExpirations(ctx context.Context, underlying string, minDTE, maxDTE int) ([]OptionExpiration, error) {
	underlying = strings.ToUpper(strings.TrimSpace(underlying))
	if underlying == "" {
		return nil, fmt.Errorf("underlying is required")
	}
	if minDTE < 0 || maxDTE < minDTE || maxDTE-minDTE > maxExpirationWindowDays {
		return nil, fmt.Errorf("invalid DTE window: need 0 <= min_dte <= max_dte and a span of at most %d days", maxExpirationWindowDays)
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return nil, fmt.Errorf("trading timezone is unavailable")
	}
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	type candidate struct {
		date string
		dte  int
	}
	var candidates []candidate
	for dte := minDTE; dte <= maxDTE; dte++ {
		day := today.AddDate(0, 0, dte)
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		candidates = append(candidates, candidate{date: day.Format("2006-01-02"), dte: dte})
	}

	type probe struct {
		exists bool
		err    error
	}
	probes := make([]probe, len(candidates))
	sem := make(chan struct{}, expirationConcurrency)
	var wg sync.WaitGroup
	for i, c := range candidates {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, date string) {
			defer wg.Done()
			defer func() { <-sem }()
			exists, probeErr := s.expirationExists(ctx, underlying, date)
			probes[i] = probe{exists: exists, err: probeErr}
		}(i, c.date)
	}
	wg.Wait()

	out := []OptionExpiration{}
	for i, p := range probes {
		if p.err != nil {
			return nil, fmt.Errorf("expiration lookup incomplete for %s: %w", candidates[i].date, p.err)
		}
		if p.exists {
			out = append(out, OptionExpiration{Date: candidates[i].date, DTE: candidates[i].dte})
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Date < out[b].Date })
	return out, nil
}

func (s *AlpacaTradingService) expirationExists(ctx context.Context, underlying, date string) (bool, error) {
	baseURL := s.optionsSnapshotBaseURL
	if baseURL == "" {
		baseURL = "https://data.alpaca.markets"
	}
	endpoint := fmt.Sprintf("%s/v1beta1/options/snapshots/%s?expiration_date=%s&type=call&limit=1&feed=indicative",
		baseURL, url.PathEscape(underlying), url.QueryEscape(date))
	client := s.optionsSnapshotHTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	body, _, err := DoProviderRequest(ctx, client, endpoint, true, func(reqCtx context.Context) (*http.Request, error) {
		req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
		if reqErr != nil {
			return nil, reqErr
		}
		req.Header.Set("APCA-API-KEY-ID", s.apiKey)
		req.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)
		req.Header.Set("Accept", "application/json")
		return req, nil
	})
	if err != nil {
		return false, err
	}
	var snapshot alpacaOptionsSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return false, fmt.Errorf("failed to parse expiration probe")
	}
	return len(snapshot.Snapshots) > 0, nil
}
