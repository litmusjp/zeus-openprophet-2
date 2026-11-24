package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestProviderAttemptCountCountsEveryAttemptIncludingRetries(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			http.Error(w, "transient", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	before := ProviderAttemptCount()
	if _, _, err := DoProviderRequest(context.Background(), ts.Client(), ts.URL+"/read", true, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/read", nil)
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := ProviderAttemptCount() - before; got != 3 {
		t.Fatalf("expected 3 counted attempts (two retries plus the success), got %d", got)
	}
	// A single clean request is one attempt.
	calls.Store(10)
	before = ProviderAttemptCount()
	if _, _, err := DoProviderRequest(context.Background(), ts.Client(), ts.URL+"/read", true, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/read", nil)
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := ProviderAttemptCount() - before; got != 1 {
		t.Fatalf("expected 1 counted attempt, got %d", got)
	}
}
