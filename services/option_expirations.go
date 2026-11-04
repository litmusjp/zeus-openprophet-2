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

// UncheckedExpiration is a weekday whose probe failed, so whether it lists contracts is unknown.
type UncheckedExpiration struct {
	Date   string `json:"date"`
	DTE    int    `json:"dte"`
	Reason string `json:"reason"`
}

// OptionExpirationsResult is a possibly partial expiry list: Expirations are confirmed dates and
// Unchecked are dates that could not be verified (unknown, not absent).
type OptionExpirationsResult struct {
	Expirations []OptionExpiration    `json:"expirations"`
	Unchecked   []UncheckedExpiration `json:"unchecked,omitempty"`
}

// GetOptionExpirations is the strict form: any unchecked date fails the whole call.
func (s *AlpacaTradingService) GetOptionExpirations(ctx context.Context, underlying string, minDTE, maxDTE int) ([]OptionExpiration, error) {
	result, err := s.ListOptionExpirations(ctx, underlying, minDTE, maxDTE)
	if err != nil {
		return nil, err
	}
	if len(result.Unchecked) > 0 {
		return nil, fmt.Errorf("expiration lookup incomplete for %s", result.Unchecked[0].Date)
	}
	return result.Expirations, nil
}

// ListOptionExpirations lists listed expiries between minDTE and maxDTE calendar days from today
// (New York date). It probes each weekday with a one-contract snapshot request on the same data
// endpoint and credentials the chain uses, so a date appears only when contracts actually exist.
// A probe that fails is reported under Unchecked instead of hiding the dates that were confirmed;
// the call fails only when every probe fails (or the request is invalid).
func (s *AlpacaTradingService) ListOptionExpirations(ctx context.Context, underlying string, minDTE, maxDTE int) (OptionExpirationsResult, error) {
	underlying = strings.ToUpper(strings.TrimSpace(underlying))
	if underlying == "" {
		return OptionExpirationsResult{}, fmt.Errorf("underlying is required")
	}
	if minDTE < 0 || maxDTE < minDTE || maxDTE-minDTE > maxExpirationWindowDays {
		return OptionExpirationsResult{}, fmt.Errorf("invalid DTE window: need 0 <= min_dte <= max_dte and a span of at most %d days", maxExpirationWindowDays)
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return OptionExpirationsResult{}, fmt.Errorf("trading timezone is unavailable")
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

	result := OptionExpirationsResult{Expirations: []OptionExpiration{}}
	var firstErr error
	for i, p := range probes {
		if p.err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("expiration lookup incomplete for %s: %w", candidates[i].date, p.err)
			}
			result.Unchecked = append(result.Unchecked, UncheckedExpiration{Date: candidates[i].date, DTE: candidates[i].dte, Reason: "provider request failed"})
			continue
		}
		if p.exists {
			result.Expirations = append(result.Expirations, OptionExpiration{Date: candidates[i].date, DTE: candidates[i].dte})
		}
	}
	if firstErr != nil && len(result.Unchecked) == len(candidates) {
		// every probe failed: nothing was confirmed, so there is no usable list at all
		return OptionExpirationsResult{}, firstErr
	}
	sort.Slice(result.Expirations, func(a, b int) bool { return result.Expirations[a].Date < result.Expirations[b].Date })
	return result, nil
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
