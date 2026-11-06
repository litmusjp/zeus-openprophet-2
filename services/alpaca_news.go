package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	alpacaNewsDefaultLimit = 20
	alpacaNewsMaxLimit     = 50
	alpacaNewsTextLimit    = 300
)

// AlpacaNewsRequest is one bounded read of Alpaca's symbol-tagged news. It is the same provider
// AlphaDesk reads for its own evidence, so OP2 agents can see what AlphaDesk is likely to see.
type AlpacaNewsRequest struct {
	Symbols   []string
	Start     time.Time
	End       time.Time
	Limit     int
	PageToken string
}

// AlpacaNewsArticle keeps the provider's identity and clocks. CreatedAt, UpdatedAt and the result's
// FetchedAt are different things: Alpaca sorts by UpdatedAt, so an updated old article is not a new event.
type AlpacaNewsArticle struct {
	ID        int64    `json:"id"`
	Headline  string   `json:"headline"`
	Source    string   `json:"source"`
	Author    string   `json:"author,omitempty"`
	Symbols   []string `json:"symbols"`
	URL       string   `json:"url,omitempty"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
	Summary   string   `json:"summary,omitempty"`
}

// AlpacaNewsResult states what was asked, what came back, and whether more exists. A successful empty
// result (Status "empty") is different from a provider failure, which is returned as an *AlpacaNewsError.
type AlpacaNewsResult struct {
	Provider          string              `json:"provider"`
	Status            string              `json:"status"` // available or empty
	Symbols           []string            `json:"symbols"`
	WindowStart       string              `json:"window_start"`
	WindowEnd         string              `json:"window_end"`
	FetchedAt         string              `json:"fetched_at"`
	Sort              string              `json:"sort"`
	Limit             int                 `json:"limit"`
	Count             int                 `json:"count"`
	HasMore           bool                `json:"has_more"`
	NextPageToken     string              `json:"next_page_token,omitempty"`
	DuplicatesRemoved int                 `json:"duplicates_removed"`
	Articles          []AlpacaNewsArticle `json:"articles"`
	Note              string              `json:"note"`
}

// AlpacaNewsError is a provider failure with a stable category: permission, rate_limited, timeout or
// provider_unavailable. It never carries credentials.
type AlpacaNewsError struct {
	Category string
	Status   int
}

func (e *AlpacaNewsError) Error() string {
	return fmt.Sprintf("alpaca news unavailable (%s)", e.Category)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}

// GetAlpacaNews reads one page of Alpaca news for the given symbols with this account's own credentials.
func (s *AlpacaTradingService) GetAlpacaNews(ctx context.Context, req AlpacaNewsRequest) (AlpacaNewsResult, error) {
	if len(req.Symbols) == 0 {
		return AlpacaNewsResult{}, fmt.Errorf("at least one symbol is required")
	}
	if req.End.IsZero() || req.Start.IsZero() || !req.End.After(req.Start) {
		return AlpacaNewsResult{}, fmt.Errorf("a valid start and end are required")
	}
	limit := req.Limit
	if limit <= 0 {
		limit = alpacaNewsDefaultLimit
	}
	if limit > alpacaNewsMaxLimit {
		return AlpacaNewsResult{}, fmt.Errorf("limit must be at most %d", alpacaNewsMaxLimit)
	}
	baseURL := s.optionsSnapshotBaseURL
	if baseURL == "" {
		baseURL = "https://data.alpaca.markets"
	}
	query := url.Values{}
	query.Set("symbols", strings.Join(req.Symbols, ","))
	query.Set("start", req.Start.UTC().Format(time.RFC3339))
	query.Set("end", req.End.UTC().Format(time.RFC3339))
	query.Set("limit", fmt.Sprint(limit))
	query.Set("sort", "desc")
	query.Set("include_content", "false")
	if req.PageToken != "" {
		query.Set("page_token", req.PageToken)
	}
	endpoint := baseURL + "/v1beta1/news?" + query.Encode()
	client := s.optionsSnapshotHTTP
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	body, status, err := DoProviderRequest(ctx, client, endpoint, true, func(reqCtx context.Context) (*http.Request, error) {
		httpReq, reqErr := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
		if reqErr != nil {
			return nil, reqErr
		}
		httpReq.Header.Set("APCA-API-KEY-ID", s.apiKey)
		httpReq.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)
		httpReq.Header.Set("Accept", "application/json")
		return httpReq, nil
	})
	if err != nil {
		return AlpacaNewsResult{}, classifyAlpacaNewsError(err, status)
	}
	var payload struct {
		News []struct {
			ID        int64    `json:"id"`
			Headline  string   `json:"headline"`
			Source    string   `json:"source"`
			Author    string   `json:"author"`
			Symbols   []string `json:"symbols"`
			URL       string   `json:"url"`
			CreatedAt string   `json:"created_at"`
			UpdatedAt string   `json:"updated_at"`
			Summary   string   `json:"summary"`
		} `json:"news"`
		NextPageToken *string `json:"next_page_token"`
	}
	// RawMessage tells a missing or null "news" field (invalid response) from a genuine empty array.
	var probe struct {
		News json.RawMessage `json:"news"`
	}
	if err := json.Unmarshal(body, &probe); err != nil || len(probe.News) == 0 || string(probe.News) == "null" {
		return AlpacaNewsResult{}, &AlpacaNewsError{Category: "provider_unavailable", Status: status}
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return AlpacaNewsResult{}, &AlpacaNewsError{Category: "provider_unavailable", Status: status}
	}
	result := AlpacaNewsResult{
		Provider: "alpaca", Symbols: req.Symbols, Sort: "updated_at desc", Limit: limit,
		WindowStart: req.Start.UTC().Format(time.RFC3339), WindowEnd: req.End.UTC().Format(time.RFC3339),
		FetchedAt: time.Now().UTC().Format(time.RFC3339), Articles: []AlpacaNewsArticle{},
		Note: "Alpaca symbol-tagged news (the provider AlphaDesk reads). Sorted by updated_at: created_at is the article time, and an updated_at or fetched_at never resets a catalyst clock. A tag does not make an article a company-specific event. Exact duplicate IDs are removed; syndicated copies are not independent confirmation. Check has_more before treating the list as the whole window.",
	}
	seen := map[int64]bool{}
	for _, item := range payload.News {
		if seen[item.ID] {
			result.DuplicatesRemoved++
			continue
		}
		seen[item.ID] = true
		symbols := item.Symbols
		if symbols == nil {
			symbols = []string{}
		}
		result.Articles = append(result.Articles, AlpacaNewsArticle{
			ID: item.ID, Headline: truncateRunes(strings.TrimSpace(item.Headline), alpacaNewsTextLimit), Source: item.Source,
			Author: item.Author, Symbols: symbols, URL: item.URL, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
			Summary: truncateRunes(strings.TrimSpace(item.Summary), alpacaNewsTextLimit),
		})
	}
	result.Count = len(result.Articles)
	if payload.NextPageToken != nil && *payload.NextPageToken != "" {
		result.HasMore = true
		result.NextPageToken = *payload.NextPageToken
	}
	result.Status = "available"
	if result.Count == 0 {
		result.Status = "empty"
	}
	return result, nil
}

func classifyAlpacaNewsError(err error, status int) error {
	var providerErr *ProviderError
	if errors.As(err, &providerErr) {
		if providerErr.Status != 0 {
			status = providerErr.Status
		}
		switch {
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			return &AlpacaNewsError{Category: "permission", Status: status}
		case status == http.StatusTooManyRequests:
			return &AlpacaNewsError{Category: "rate_limited", Status: status}
		case providerErr.Category == "transport" || providerErr.Category == "retry_exhausted":
			if errors.Is(providerErr.Err, context.DeadlineExceeded) || providerErr.Category == "retry_exhausted" {
				return &AlpacaNewsError{Category: "timeout", Status: status}
			}
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &AlpacaNewsError{Category: "timeout", Status: status}
	}
	return &AlpacaNewsError{Category: "provider_unavailable", Status: status}
}
