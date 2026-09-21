package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// AlphaDeskClient is deliberately assessment-only. It never authorizes a
// broker order and never includes the API key in an error or response.
type AlphaDeskClient struct {
	Enabled bool
	URL     string
	APIKey  string
	HTTP    *http.Client
	Now     func() time.Time
}

func NewAlphaDeskClientFromEnv() *AlphaDeskClient {
	return &AlphaDeskClient{Enabled: strings.EqualFold(os.Getenv("ALPHADESK_ENABLED"), "true"), URL: strings.TrimRight(strings.TrimSpace(os.Getenv("ALPHADESK_URL")), "/"), APIKey: os.Getenv("ALPHADESK_API_KEY"), HTTP: &http.Client{Timeout: 8 * time.Second}, Now: time.Now}
}

func ValidateAlphaDeskURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("AlphaDesk URL must be an absolute HTTPS URL")
	}
	if u.User != nil {
		return fmt.Errorf("AlphaDesk URL must not include credentials")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1") {
		return nil
	}
	return fmt.Errorf("AlphaDesk URL must use HTTPS (HTTP is allowed only for localhost development)")
}

type AlphaDeskAssessmentRequest struct {
	AccountID             string   `json:"account_id"`
	SandboxID             string   `json:"sandbox_id"`
	Symbol                string   `json:"symbol"`
	Underlying            string   `json:"underlying"`
	Side                  string   `json:"side"`
	PositionIntent        string   `json:"position_intent"`
	Quantity              float64  `json:"quantity"`
	LimitPrice            *float64 `json:"limit_price,omitempty"`
	TradeFingerprint      string   `json:"trade_fingerprint"`
	MarketScannerFeatures any      `json:"market_scanner_features,omitempty"`
}

func OptionsTradeFingerprint(identity models.DurableIdentity, symbol, underlying, side, intent string, qty float64, limit *float64) string {
	v := struct {
		Account, Paper, Tenant, Sandbox, Symbol, Underlying, Side, Intent string
		Qty                                                               float64
		Limit                                                             *float64
	}{identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID, strings.ToUpper(strings.TrimSpace(symbol)), strings.ToUpper(strings.TrimSpace(underlying)), strings.ToLower(strings.TrimSpace(side)), strings.ToLower(strings.TrimSpace(intent)), qty, limit}
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (c *AlphaDeskClient) Assess(ctx context.Context, req AlphaDeskAssessmentRequest) (*interfaces.AlphaDeskAssessment, error) {
	if !c.Enabled {
		return nil, fmt.Errorf("AlphaDesk hard gate is disabled")
	}
	if c.URL == "" || c.APIKey == "" {
		return nil, fmt.Errorf("AlphaDesk is not configured")
	}
	if err := ValidateAlphaDeskURL(c.URL); err != nil {
		return nil, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("encode AlphaDesk assessment: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+"/api/v1/desk/strategy-assessments", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create AlphaDesk assessment request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-AlphaDesk-API-Key", c.APIKey)
	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("AlphaDesk assessment unavailable: %w", err)
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if readErr != nil {
		return nil, fmt.Errorf("read AlphaDesk assessment: %w", readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("AlphaDesk assessment unavailable (HTTP %d)", resp.StatusCode)
	}
	var v struct {
		AssessmentID          string    `json:"assessment_id"`
		Decision              string    `json:"decision"`
		Pass                  *bool     `json:"pass"`
		SignalScore           *float64  `json:"signal_score"`
		Threshold             *float64  `json:"execution_threshold"`
		Threshold2            *float64  `json:"threshold"`
		Policy                any       `json:"policy"`
		Evidence              any       `json:"evidence"`
		ExpiresAt             time.Time `json:"expires_at"`
		HumanApprovalRequired bool      `json:"human_approval_required"`
		ExecutionAllowed      bool      `json:"execution_allowed"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("invalid AlphaDesk assessment response")
	}
	if v.Decision == "" && v.Pass != nil {
		if *v.Pass {
			v.Decision = "PASS"
		} else {
			v.Decision = "FAIL"
		}
	}
	threshold := v.Threshold
	if threshold == nil {
		threshold = v.Threshold2
	}
	return &interfaces.AlphaDeskAssessment{AssessmentID: v.AssessmentID, Decision: v.Decision, SignalScore: v.SignalScore, Threshold: threshold, Policy: v.Policy, Evidence: v.Evidence, ExpiresAt: v.ExpiresAt, Fingerprint: req.TradeFingerprint, HumanApprovalRequired: v.HumanApprovalRequired, ExecutionAllowed: v.ExecutionAllowed}, nil
}

func assessmentMetadata(a *interfaces.AlphaDeskAssessment) string {
	b, _ := json.Marshal(a)
	return string(b)
}

func DecodeAlphaDeskAssessment(metadata string) (*interfaces.AlphaDeskAssessment, error) {
	var a interfaces.AlphaDeskAssessment
	if strings.TrimSpace(metadata) == "" {
		return nil, fmt.Errorf("AlphaDesk assessment is missing")
	}
	if err := json.Unmarshal([]byte(metadata), &a); err != nil {
		return nil, fmt.Errorf("invalid AlphaDesk assessment metadata")
	}
	return &a, nil
}

func ValidateAlphaDeskAssessment(a *interfaces.AlphaDeskAssessment, expectedFingerprint string, now time.Time) error {
	if a == nil {
		return fmt.Errorf("fresh AlphaDesk PASS is required")
	}
	if a.Decision != "PASS" {
		return fmt.Errorf("AlphaDesk assessment decision is not PASS")
	}
	if a.SignalScore == nil || a.Threshold == nil {
		return fmt.Errorf("AlphaDesk assessment lacks a reliable score or execution threshold")
	}
	if *a.SignalScore < *a.Threshold {
		return fmt.Errorf("AlphaDesk signal score is below the execution threshold")
	}
	if a.ExpiresAt.IsZero() || !now.Before(a.ExpiresAt) {
		return fmt.Errorf("AlphaDesk assessment is expired")
	}
	if a.Fingerprint == "" || a.Fingerprint != expectedFingerprint {
		return fmt.Errorf("AlphaDesk assessment fingerprint does not match the exact trade")
	}
	return nil
}

func (c *AlphaDeskClient) AssessAndValidate(ctx context.Context, identity models.DurableIdentity, order *interfaces.OptionsOrder, features any) (*interfaces.AlphaDeskAssessment, error) {
	return c.assessAndValidate(ctx, identity, order, features, nil)
}

func (c *AlphaDeskClient) AssessAndValidateWithAudit(ctx context.Context, identity models.DurableIdentity, order *interfaces.OptionsOrder, features any, audit func(*interfaces.AlphaDeskAssessment) error) (*interfaces.AlphaDeskAssessment, error) {
	return c.assessAndValidate(ctx, identity, order, features, audit)
}

func (c *AlphaDeskClient) assessAndValidate(ctx context.Context, identity models.DurableIdentity, order *interfaces.OptionsOrder, features any, audit func(*interfaces.AlphaDeskAssessment) error) (*interfaces.AlphaDeskAssessment, error) {
	fp := OptionsTradeFingerprint(identity, order.Symbol, order.Underlying, order.Side, order.PositionIntent, order.Qty, order.LimitPrice)
	a, err := c.Assess(ctx, AlphaDeskAssessmentRequest{AccountID: identity.BrokerAccountID, SandboxID: identity.SandboxID, Symbol: order.Symbol, Underlying: order.Underlying, Side: order.Side, PositionIntent: order.PositionIntent, Quantity: order.Qty, LimitPrice: order.LimitPrice, TradeFingerprint: fp, MarketScannerFeatures: features})
	if err != nil {
		return nil, err
	}
	if audit != nil {
		if err := audit(a); err != nil {
			return nil, fmt.Errorf("persist AlphaDesk assessment: %w", err)
		}
	}
	if err := ValidateAlphaDeskAssessment(a, fp, c.Now()); err != nil {
		return nil, err
	}
	return a, nil
}

func (c *AlphaDeskClient) AssessForTrade(ctx context.Context, identity models.DurableIdentity, order *interfaces.OptionsOrder, features any) (*interfaces.AlphaDeskAssessment, error) {
	fp := OptionsTradeFingerprint(identity, order.Symbol, order.Underlying, order.Side, order.PositionIntent, order.Qty, order.LimitPrice)
	a, err := c.Assess(ctx, AlphaDeskAssessmentRequest{AccountID: identity.BrokerAccountID, SandboxID: identity.SandboxID, Symbol: order.Symbol, Underlying: order.Underlying, Side: order.Side, PositionIntent: order.PositionIntent, Quantity: order.Qty, LimitPrice: order.LimitPrice, TradeFingerprint: fp, MarketScannerFeatures: features})
	if err != nil {
		return nil, err
	}
	a.Qualified = ValidateAlphaDeskAssessment(a, fp, c.Now()) == nil
	if a.Qualified {
		a.QualificationStatus = "qualified"
	} else {
		a.QualificationStatus = "not_qualified"
	}
	return a, nil
}
