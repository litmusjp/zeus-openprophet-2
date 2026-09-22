package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDoProviderRequestRetriesSafeTransientStatus(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			http.Error(w, "secret provider body", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	body, _, err := DoProviderRequest(context.Background(), ts.Client(), ts.URL+"/read", true, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/read", nil)
	})
	if err != nil || string(body) != `{"ok":true}` || calls.Load() != 3 {
		t.Fatalf("body=%s err=%v calls=%d", body, err, calls.Load())
	}
}

func TestDoProviderRequestExhaustionIsSanitizedAndBounded(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "provider secret response", http.StatusBadGateway)
	}))
	defer ts.Close()
	_, _, err := DoProviderRequest(context.Background(), ts.Client(), ts.URL+"/assessment", true, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/assessment", nil)
	})
	var providerErr *ProviderError
	if err == nil || !strings.Contains(err.Error(), "attempts=3") || strings.Contains(err.Error(), "provider secret") || !AsProviderError(err, &providerErr) || !providerErr.Retryable || calls.Load() != 3 {
		t.Fatalf("err=%v provider=%#v calls=%d", err, providerErr, calls.Load())
	}
}

func TestDoProviderRequestDoesNotRetryUnsafeTransientStatus(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "ambiguous order response", http.StatusBadGateway)
	}))
	defer ts.Close()
	_, _, err := DoProviderRequest(context.Background(), ts.Client(), ts.URL+"/order", false, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/order", nil)
	})
	if err == nil || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d; unsafe operation was retried", err, calls.Load())
	}
}

func AsProviderError(err error, target **ProviderError) bool {
	if providerErr, ok := err.(*ProviderError); ok {
		*target = providerErr
		return true
	}
	return false
}
