package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

func derefFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

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
	UnderlyingSymbol                    string                              `json:"underlying_symbol"`
	StrategyType                        string                              `json:"strategy_type"`
	Side                                string                              `json:"side"`
	Quantity                            int                                 `json:"quantity"`
	LimitPrice                          float64                             `json:"limit_price"`
	Legs                                []interfaces.AlphaDeskAssessmentLeg `json:"legs"`
	MaxLoss                             float64                             `json:"max_loss"`
	Greeks                              map[string]float64                  `json:"greeks"`
	MarketEvidenceAt                    time.Time                           `json:"market_evidence_at"`
	ObservedAt                          time.Time                           `json:"observed_at"`
	ExpiresAt                           time.Time                           `json:"expires_at"`
	MarketScannerFeatures               any                                 `json:"market_scanner_features,omitempty"`
	TradeFingerprint                    string                              `json:"-"`
	RequestAutonomousPaperAuthorization bool                                `json:"request_autonomous_paper_authorization,omitempty"`
}

type AlphaDeskUnavailableError struct {
	Reason string
	Err    error
}

type AlphaDeskConfigurationError struct{ Reason string }

func (e *AlphaDeskConfigurationError) Error() string { return e.Reason }

func (e *AlphaDeskUnavailableError) Error() string {
	if e == nil {
		return "AlphaDesk evidence is unavailable"
	}
	return e.Reason
}
func (e *AlphaDeskUnavailableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type AlphaDeskValidationError struct {
	Status int
	Err    error
}

func (e *AlphaDeskValidationError) Error() string {
	return fmt.Sprintf("AlphaDesk rejected the assessment request (HTTP %d)", e.Status)
}
func (e *AlphaDeskValidationError) Unwrap() error { return e.Err }

type AlphaDeskProviderUnavailableError struct{ Err error }

func (e *AlphaDeskProviderUnavailableError) Error() string {
	return "AlphaDesk assessment unavailable: provider is unavailable"
}

func (e *AlphaDeskProviderUnavailableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type AlphaDeskProviderResponseError struct {
	Reason string
	Err    error
}

func (e *AlphaDeskProviderResponseError) Error() string {
	if e == nil || e.Reason == "" {
		return "AlphaDesk returned an invalid assessment response"
	}
	return "AlphaDesk returned an invalid assessment response: " + e.Reason
}

func (e *AlphaDeskProviderResponseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type alphaDeskFloat float64

func (n *alphaDeskFloat) UnmarshalJSON(data []byte) error {
	value := strings.TrimSpace(string(data))
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		value = strings.TrimSpace(text)
	}
	if value == "" || value == "null" {
		return fmt.Errorf("score must be a finite number or null")
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fmt.Errorf("score must be a finite number")
	}
	*n = alphaDeskFloat(parsed)
	return nil
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
		return nil, &AlphaDeskConfigurationError{Reason: "AlphaDesk is not configured"}
	}
	if err := ValidateAlphaDeskURL(c.URL); err != nil {
		return nil, &AlphaDeskConfigurationError{Reason: err.Error()}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("encode AlphaDesk assessment: %w", err)
	}
	endpoint := c.URL + "/api/v1/desk/strategy-assessments"
	raw, _, err := DoProviderRequest(ctx, c.HTTP, endpoint, true, func(reqCtx context.Context) (*http.Request, error) {
		httpReq, reqErr := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
		if reqErr != nil {
			return nil, reqErr
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("X-AlphaDesk-API-Key", c.APIKey)
		return httpReq, nil
	})
	if err != nil {
		var providerErr *ProviderError
		if errors.As(err, &providerErr) && (providerErr.Status == http.StatusBadRequest || providerErr.Status == http.StatusUnprocessableEntity) {
			return nil, &AlphaDeskValidationError{Status: providerErr.Status, Err: err}
		}
		if errors.As(err, &providerErr) && providerErr.Status == http.StatusServiceUnavailable {
			return nil, &AlphaDeskProviderUnavailableError{Err: err}
		}
		return nil, fmt.Errorf("AlphaDesk assessment unavailable: %w", err)
	}
	var v struct {
		AssessmentID                 string                                   `json:"assessment_id"`
		Decision                     string                                   `json:"decision"`
		Pass                         *bool                                    `json:"pass"`
		SignalScore                  *alphaDeskFloat                          `json:"market_scanner_signal_score"`
		LegacySignalScore            *alphaDeskFloat                          `json:"signal_score"`
		Threshold                    *alphaDeskFloat                          `json:"execution_threshold"`
		Threshold2                   *alphaDeskFloat                          `json:"threshold"`
		Policy                       any                                      `json:"policy_snapshot"`
		Evidence                     any                                      `json:"checks"`
		FailedCheckCodes             []string                                 `json:"failed_check_codes"`
		PolicyVersion                string                                   `json:"policy_version"`
		MarketEvidenceAt             time.Time                                `json:"market_evidence_at"`
		ObservedAt                   time.Time                                `json:"observed_at"`
		ExpiresAt                    time.Time                                `json:"expires_at"`
		HumanApprovalRequired        bool                                     `json:"human_approval_required"`
		ExecutionAllowed             bool                                     `json:"execution_allowed"`
		AutonomousPaperAuthorization *interfaces.AutonomousPaperAuthorization `json:"autonomous_paper_authorization"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, &AlphaDeskProviderResponseError{Reason: "malformed score or response field", Err: err}
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
	if v.SignalScore == nil {
		v.SignalScore = v.LegacySignalScore
	}
	if threshold == nil {
		threshold = policyThreshold(v.Policy)
	}
	var signalScore, thresholdValue *float64
	if v.SignalScore != nil {
		value := float64(*v.SignalScore)
		signalScore = &value
	}
	if threshold != nil {
		value := float64(*threshold)
		thresholdValue = &value
	}
	// Keep the local request fingerprint as the audit/request binding; opening
	// authorization uses its separately validated contract fingerprint below.
	return &interfaces.AlphaDeskAssessment{AssessmentID: v.AssessmentID, Decision: v.Decision, Pass: v.Pass != nil && *v.Pass, SignalScore: signalScore, Threshold: thresholdValue, Policy: v.Policy, Evidence: v.Evidence, ExpiresAt: v.ExpiresAt, Fingerprint: req.TradeFingerprint, HumanApprovalRequired: v.HumanApprovalRequired, ExecutionAllowed: v.ExecutionAllowed, FailedCheckCodes: v.FailedCheckCodes, PolicyVersion: v.PolicyVersion, MarketEvidenceAt: v.MarketEvidenceAt, ObservedAt: v.ObservedAt, AutonomousPaperAuthorization: v.AutonomousPaperAuthorization}, nil
}

func policyThreshold(policy any) *alphaDeskFloat {
	b, err := json.Marshal(policy)
	if err != nil {
		return nil
	}
	var raw map[string]any
	if json.Unmarshal(b, &raw) != nil {
		return nil
	}
	for _, key := range []string{"minimum_signal_score", "execution_threshold", "threshold"} {
		if value, ok := raw[key]; ok {
			switch n := value.(type) {
			case float64:
				if math.IsNaN(n) || math.IsInf(n, 0) {
					return nil
				}
				parsed := alphaDeskFloat(n)
				return &parsed
			case string:
				if parsed, err := strconv.ParseFloat(n, 64); err == nil {
					if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
						return nil
					}
					value := alphaDeskFloat(parsed)
					return &value
				}
			}
		}
	}
	return nil
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
	if !a.ExecutionAllowed {
		return fmt.Errorf("AlphaDesk assessment does not allow execution")
	}
	if a.HumanApprovalRequired {
		return fmt.Errorf("AlphaDesk assessment requires human approval")
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
	if order == nil {
		return nil, &AlphaDeskUnavailableError{Reason: "required broker option evidence is unavailable"}
	}
	fp := OptionsOrderFingerprint(identity, order)
	if order == nil || len(order.AssessmentLegs) == 0 || order.AssessmentMaxLoss == nil || len(order.AssessmentGreeks) == 0 || order.MarketEvidenceAt.IsZero() || order.ObservedAt.IsZero() || order.AssessmentExpiresAt.IsZero() {
		return nil, &AlphaDeskUnavailableError{Reason: "required broker option evidence is unavailable"}
	}
	opening := strings.HasSuffix(strings.ToLower(strings.TrimSpace(order.PositionIntent)), "_to_open")
	a, err := c.Assess(ctx, AlphaDeskAssessmentRequest{UnderlyingSymbol: order.Underlying, StrategyType: order.StrategyType, Side: order.Side, Quantity: int(order.Qty), LimitPrice: derefFloat(order.LimitPrice), Legs: order.AssessmentLegs, MaxLoss: *order.AssessmentMaxLoss, Greeks: order.AssessmentGreeks, MarketEvidenceAt: order.MarketEvidenceAt, ObservedAt: order.ObservedAt, ExpiresAt: order.AssessmentExpiresAt, TradeFingerprint: fp, RequestAutonomousPaperAuthorization: opening, MarketScannerFeatures: features})
	if err != nil {
		return nil, err
	}
	if audit != nil {
		if err := audit(a); err != nil {
			return nil, fmt.Errorf("persist AlphaDesk assessment: %w", err)
		}
	}
	if opening {
		if err := ValidateAutonomousPaperAuthorization(a, identity, order, fp, c.Now()); err != nil {
			return nil, err
		}
	} else if err := ValidateAlphaDeskAssessment(a, fp, c.Now()); err != nil {
		return nil, err
	}
	return a, nil
}

func (c *AlphaDeskClient) AssessForTrade(ctx context.Context, identity models.DurableIdentity, order *interfaces.OptionsOrder, features any) (*interfaces.AlphaDeskAssessment, error) {
	if order == nil {
		return nil, &AlphaDeskUnavailableError{Reason: "required broker option evidence is unavailable"}
	}
	fp := OptionsTradeFingerprint(identity, order.Symbol, order.Underlying, order.Side, order.PositionIntent, order.Qty, order.LimitPrice)
	if order == nil || len(order.AssessmentLegs) == 0 || order.AssessmentMaxLoss == nil || len(order.AssessmentGreeks) == 0 || order.MarketEvidenceAt.IsZero() || order.ObservedAt.IsZero() || order.AssessmentExpiresAt.IsZero() {
		return nil, &AlphaDeskUnavailableError{Reason: "required broker option evidence is unavailable"}
	}
	a, err := c.Assess(ctx, AlphaDeskAssessmentRequest{UnderlyingSymbol: order.Underlying, StrategyType: order.StrategyType, Side: order.Side, Quantity: int(order.Qty), LimitPrice: derefFloat(order.LimitPrice), Legs: order.AssessmentLegs, MaxLoss: *order.AssessmentMaxLoss, Greeks: order.AssessmentGreeks, MarketEvidenceAt: order.MarketEvidenceAt, ObservedAt: order.ObservedAt, ExpiresAt: order.AssessmentExpiresAt, TradeFingerprint: fp, MarketScannerFeatures: features})
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

// OptionsOrderFingerprint binds every field that can change the meaning of a
// complex order. The legacy fingerprint remains available for compatibility,
// but opening authorization uses this complete identity.
func OptionsOrderFingerprint(identity models.DurableIdentity, order *interfaces.OptionsOrder) string {
	type fingerprintLeg struct {
		Symbol, Side, PositionIntent string
		RatioQty                     int
		Price                        float64
	}
	legs := make([]fingerprintLeg, len(order.Legs))
	for i, leg := range order.Legs {
		legs[i] = fingerprintLeg{strings.ToUpper(strings.TrimSpace(leg.Symbol)), strings.ToLower(strings.TrimSpace(leg.Side)), strings.ToLower(strings.TrimSpace(leg.PositionIntent)), leg.RatioQty, leg.Price}
	}
	v := struct {
		Account, Paper, Tenant, Sandbox, Symbol, Underlying, Strategy, Side string
		Qty                                                                 float64
		Limit, MaxLoss                                                      *float64
		Legs                                                                []fingerprintLeg
	}{identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID, strings.ToUpper(strings.TrimSpace(order.Symbol)), strings.ToUpper(strings.TrimSpace(order.Underlying)), strings.TrimSpace(order.StrategyType), strings.ToLower(strings.TrimSpace(order.Side)), order.Qty, order.LimitPrice, order.AssessmentMaxLoss, legs}
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func decimalString(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func autonomousPaperStrategyIdentity(order *interfaces.OptionsOrder) interfaces.AutonomousPaperStrategyIdentity {
	identity := interfaces.AutonomousPaperStrategyIdentity{}
	if order == nil {
		return identity
	}
	identity.UnderlyingSymbol = strings.ToUpper(strings.TrimSpace(order.Underlying))
	identity.StrategyType = strings.TrimSpace(order.StrategyType)
	identity.Side = strings.ToLower(strings.TrimSpace(order.Side))
	identity.Quantity = int(order.Qty)
	identity.LimitPrice = decimalString(derefFloat(order.LimitPrice))
	identity.MaxLoss = decimalString(derefFloat(order.AssessmentMaxLoss))
	identity.Legs = make([]interfaces.AutonomousPaperStrategyLeg, len(order.AssessmentLegs))
	for i, leg := range order.AssessmentLegs {
		identity.Legs[i] = interfaces.AutonomousPaperStrategyLeg{
			Symbol: strings.TrimSpace(leg.Symbol), Side: strings.ToLower(strings.TrimSpace(leg.Side)),
			Quantity: leg.Quantity, Price: decimalString(leg.Price),
		}
	}
	return identity
}

func strategyIdentityObject(identity interfaces.AutonomousPaperStrategyIdentity) map[string]any {
	legs := make([]map[string]any, len(identity.Legs))
	for i, leg := range identity.Legs {
		legs[i] = map[string]any{"symbol": leg.Symbol, "side": leg.Side, "quantity": leg.Quantity, "price": leg.Price}
	}
	return map[string]any{
		"underlying_symbol": identity.UnderlyingSymbol,
		"strategy_type":     identity.StrategyType,
		"side":              identity.Side,
		"quantity":          identity.Quantity,
		"limit_price":       identity.LimitPrice,
		"max_loss":          identity.MaxLoss,
		"legs":              legs,
	}
}

func pythonISO8601(value time.Time) string {
	value = value.UTC()
	return value.Format("2006-01-02T15:04:05.999999+00:00")
}

// AlphaDeskAuthorizationFingerprint reproduces AlphaDesk's canonical JSON
// binding for autonomous paper authorization. The legacy local fingerprint is
// intentionally not used for this comparison.
func AlphaDeskAuthorizationFingerprint(identity models.DurableIdentity, order *interfaces.OptionsOrder, policyVersion string) string {
	strategyIdentity := autonomousPaperStrategyIdentity(order)
	payload := map[string]any{
		"strategy_identity": strategyIdentityObject(strategyIdentity),
		"workspace_id":      identity.TenantID,
		"account_id":        identity.BrokerAccountID,
		"environment":       "PAPER",
		"policy_version":    policyVersion,
		"expires_at":        pythonISO8601(order.AssessmentExpiresAt),
	}
	b, _ := json.Marshal(payload)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func ValidateAutonomousPaperAuthorization(a *interfaces.AlphaDeskAssessment, identity models.DurableIdentity, order *interfaces.OptionsOrder, expectedFingerprint string, now time.Time) error {
	if a == nil || a.AutonomousPaperAuthorization == nil {
		return fmt.Errorf("AlphaDesk autonomous paper authorization is missing")
	}
	auth := a.AutonomousPaperAuthorization
	if !auth.Allowed {
		return fmt.Errorf("AlphaDesk autonomous paper authorization is denied")
	}
	if strings.TrimSpace(auth.AuthorizationID) == "" {
		return fmt.Errorf("AlphaDesk autonomous paper authorization ID is missing")
	}
	if strings.TrimSpace(identity.BrokerAccountID) == "" || auth.AccountID != identity.BrokerAccountID {
		return fmt.Errorf("AlphaDesk autonomous paper authorization account does not match")
	}
	if strings.TrimSpace(identity.TenantID) == "" || auth.WorkspaceID != identity.TenantID {
		return fmt.Errorf("AlphaDesk autonomous paper authorization workspace does not match")
	}
	if identity.PaperLive != "paper" || auth.Mode != "PAPER_ONLY" || auth.Environment != "PAPER" {
		return fmt.Errorf("AlphaDesk autonomous paper authorization is not paper-only")
	}
	if auth.Issuer != "AlphaDesk" {
		return fmt.Errorf("AlphaDesk autonomous paper authorization issuer is invalid")
	}
	if auth.Source != "strategy_assessment" {
		return fmt.Errorf("AlphaDesk autonomous paper authorization source is invalid")
	}
	if strings.TrimSpace(auth.PolicyVersion) == "" {
		return fmt.Errorf("AlphaDesk autonomous paper authorization policy version is missing")
	}
	if auth.IssuedAt.IsZero() || auth.ExpiresAt.IsZero() || now.Before(auth.IssuedAt) || !now.Before(auth.ExpiresAt) || auth.ExpiresAt.Before(auth.IssuedAt) {
		return fmt.Errorf("AlphaDesk autonomous paper authorization is expired or malformed")
	}
	if order == nil {
		return fmt.Errorf("AlphaDesk autonomous paper authorization strategy identity does not match")
	}
	if !auth.ExpiresAt.Equal(order.AssessmentExpiresAt) {
		return fmt.Errorf("AlphaDesk autonomous paper authorization expiry does not match the assessed order")
	}
	expectedIdentity := autonomousPaperStrategyIdentity(order)
	if !reflect.DeepEqual(auth.StrategyIdentity, expectedIdentity) {
		return fmt.Errorf("AlphaDesk autonomous paper authorization strategy identity does not match")
	}
	if strings.TrimSpace(auth.Fingerprint) == "" || auth.Fingerprint != AlphaDeskAuthorizationFingerprint(identity, order, auth.PolicyVersion) {
		return fmt.Errorf("AlphaDesk autonomous paper authorization fingerprint does not match the exact trade")
	}
	_ = expectedFingerprint // retained as the local audit/request binding
	return nil
}
