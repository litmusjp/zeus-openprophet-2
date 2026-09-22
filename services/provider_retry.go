package services

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ProviderRetryPolicy is deliberately small and bounded. It is for reads and
// assessment-only requests; broker order submission and cancellation must not
// use it because an HTTP failure can follow a provider-side state change.
type ProviderRetryPolicy struct {
	MaxAttempts int
	InitialWait time.Duration
	MaxWait     time.Duration
	Total       time.Duration
}

var defaultProviderRetryPolicy = ProviderRetryPolicy{MaxAttempts: 3, InitialWait: 100 * time.Millisecond, MaxWait: 750 * time.Millisecond, Total: 3 * time.Second}

// ProviderError is a sanitized upstream failure. It intentionally excludes
// provider response bodies, which may contain credentials or account data.
type ProviderError struct {
	Endpoint  string
	Status    int
	Category  string
	Attempts  int
	Retryable bool
	Err       error
}

func (e *ProviderError) Error() string {
	if e == nil {
		return "provider error"
	}
	status := "transport"
	if e.Status > 0 {
		status = fmt.Sprintf("HTTP %d", e.Status)
	}
	return fmt.Sprintf("provider %s at %s (%s; attempts=%d; retryable=%t)", status, e.Endpoint, e.Category, e.Attempts, e.Retryable)
}
func (e *ProviderError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func providerEndpoint(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "provider"
	}
	if u.Path == "" {
		return u.Host
	}
	return u.Host + u.Path
}

func retryableProviderStatus(status int, safe bool) bool {
	return safe && (status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout || status == http.StatusInternalServerError)
}

// DoProviderRequest retries only transport failures and explicitly safe
// transient statuses. It returns a bounded, sanitized error on exhaustion.
func DoProviderRequest(ctx context.Context, client *http.Client, endpoint string, safe bool, makeRequest func(context.Context) (*http.Request, error)) ([]byte, int, error) {
	policy := defaultProviderRetryPolicy
	callCtx, cancel := context.WithTimeout(ctx, policy.Total)
	defer cancel()
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		req, err := makeRequest(callCtx)
		if err != nil {
			return nil, 0, &ProviderError{Endpoint: providerEndpoint(endpoint), Category: "request_build", Attempts: attempt, Err: err}
		}
		resp, doErr := client.Do(req)
		if doErr != nil {
			if safe && attempt < policy.MaxAttempts && callCtx.Err() == nil {
				if err := providerBackoff(callCtx, policy, attempt); err == nil {
					continue
				}
			}
			return nil, 0, &ProviderError{Endpoint: providerEndpoint(endpoint), Category: "transport", Attempts: attempt, Retryable: safe, Err: doErr}
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		if readErr != nil {
			return nil, resp.StatusCode, &ProviderError{Endpoint: providerEndpoint(endpoint), Status: resp.StatusCode, Category: "read", Attempts: attempt, Retryable: true, Err: readErr}
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return body, resp.StatusCode, nil
		}
		retryable := retryableProviderStatus(resp.StatusCode, safe)
		if retryable && attempt < policy.MaxAttempts && callCtx.Err() == nil {
			if err := providerBackoff(callCtx, policy, attempt); err == nil {
				continue
			}
		}
		return nil, resp.StatusCode, &ProviderError{Endpoint: providerEndpoint(endpoint), Status: resp.StatusCode, Category: "http", Attempts: attempt, Retryable: retryable, Err: fmt.Errorf("upstream status %d", resp.StatusCode)}
	}
	return nil, 0, &ProviderError{Endpoint: providerEndpoint(endpoint), Category: "retry_exhausted", Attempts: policy.MaxAttempts, Retryable: true}
}

func providerBackoff(ctx context.Context, policy ProviderRetryPolicy, attempt int) error {
	wait := policy.InitialWait << (attempt - 1)
	if wait > policy.MaxWait {
		wait = policy.MaxWait
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
