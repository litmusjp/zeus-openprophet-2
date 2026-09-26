package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

func readyAlphaRequest() AlphaDeskAssessmentRequest {
	quoted := time.Date(2026, 9, 22, 1, 0, 0, 0, time.UTC)
	d, g, th, v := 0.5, 0.1, -0.2, 0.3
	return AlphaDeskAssessmentRequest{UnderlyingSymbol: "AAPL", StrategyType: "SINGLE_LEG_OPTION", Side: "buy", Quantity: 1, LimitPrice: 1.25, Legs: []interfaces.AlphaDeskAssessmentLeg{{Symbol: "AAPL260116C00200000", Side: "buy", Quantity: 1, Price: 1.25, Bid: 1.2, Ask: 1.3, QuoteSize: 10, QuotedAt: quoted, Delta: &d, Gamma: &g, Theta: &th, Vega: &v}}, MaxLoss: 125, Greeks: map[string]float64{"delta": d, "gamma": g, "theta": th, "vega": v}, MarketEvidenceAt: quoted, ObservedAt: quoted.Add(time.Second), ExpiresAt: quoted.Add(time.Minute), TradeFingerprint: "fp"}
}

func TestAlphaDeskAssessmentUsesExactContractAndMapsLiveResponse(t *testing.T) {
	var got map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"pass":true,"decision":"PASS","assessment_id":"a-1","market_scanner_signal_score":72.5,"policy_snapshot":{"minimum_signal_score":"65"},"policy_version":"v1","market_evidence_at":"2026-09-22T01:00:00Z","observed_at":"2026-09-22T01:00:01Z","expires_at":"2026-09-22T01:01:00Z","paper_only":true,"human_approval_required":true,"execution_allowed":false}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), readyAlphaRequest())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"underlying_symbol", "strategy_type", "side", "quantity", "limit_price", "legs", "max_loss", "greeks", "market_evidence_at", "observed_at", "expires_at"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("outbound request missing %q: %#v", key, got)
		}
	}
	if _, ok := got["symbol"]; ok {
		t.Fatal("legacy symbol field leaked into AlphaDesk request")
	}
	if a.SignalScore == nil || *a.SignalScore != 72.5 || a.Threshold == nil || *a.Threshold != 65 {
		t.Fatalf("mapped assessment = %#v", a)
	}
}

func TestAlphaDeskAssessmentDecodesAutonomousPaperAuthorization(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"decision":"PASS","execution_allowed":false,"human_approval_required":true,"autonomous_paper_authorization":{"allowed":true,"reason":"approved","authorization_id":"auth-1","fingerprint":"fp-1","mode":"PAPER_ONLY","environment":"PAPER","workspace_id":"workspace-1","account_id":"account-1","issuer":"AlphaDesk","source":"strategy_assessment","issued_at":"2026-09-26T00:00:00Z","expires_at":"2099-01-01T00:00:00Z","policy_version":"v1","strategy_identity":{"underlying_symbol":"AAPL","strategy_type":"SINGLE_LEG_OPTION","side":"buy","quantity":1,"limit_price":"1.25","max_loss":"125.00","legs":[{"symbol":"AAPL260116C00200000","side":"buy","quantity":1,"price":"1.25"}]}}}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), readyAlphaRequest())
	if err != nil {
		t.Fatal(err)
	}
	if a.AutonomousPaperAuthorization == nil || !a.AutonomousPaperAuthorization.Allowed {
		t.Fatalf("authorization=%#v, want allowed autonomous paper authorization", a.AutonomousPaperAuthorization)
	}
	if a.AutonomousPaperAuthorization.AuthorizationID != "auth-1" || a.AutonomousPaperAuthorization.Fingerprint != "fp-1" {
		t.Fatalf("authorization identity=%#v, want auth-1/fp-1", a.AutonomousPaperAuthorization)
	}
	if got := a.AutonomousPaperAuthorization.StrategyIdentity.UnderlyingSymbol; got != "AAPL" {
		t.Fatalf("strategy identity underlying_symbol=%q, want AAPL", got)
	}
	if len(a.AutonomousPaperAuthorization.StrategyIdentity.Legs) != 1 || a.AutonomousPaperAuthorization.StrategyIdentity.Legs[0].Price != "1.25" {
		t.Fatalf("strategy identity=%#v, want object wire shape", a.AutonomousPaperAuthorization.StrategyIdentity)
	}
	if a.ExecutionAllowed || !a.HumanApprovalRequired {
		t.Fatalf("legacy assessment flags were not preserved: %#v", a)
	}
}

func authorizationTestOrder() *interfaces.OptionsOrder {
	limit, maxLoss := 1.25, 125.0
	return &interfaces.OptionsOrder{
		Underlying: "aapl", StrategyType: "SINGLE_LEG_OPTION", Side: "BUY", Qty: 1,
		LimitPrice: &limit, AssessmentMaxLoss: &maxLoss,
		AssessmentExpiresAt: time.Date(2026, 9, 26, 12, 34, 56, 123456000, time.FixedZone("JST", 9*60*60)),
		AssessmentLegs:      []interfaces.AlphaDeskAssessmentLeg{{Symbol: "AAPL260116C00200000", Side: "BUY", Quantity: 1, Price: 1.25}},
	}
}

func TestAlphaDeskAuthorizationFingerprintMatchesCanonicalContract(t *testing.T) {
	identity := models.DurableIdentity{BrokerAccountID: "acct", TenantID: "tenant"}
	order := authorizationTestOrder()
	canonical := `{"account_id":"acct","environment":"PAPER","expires_at":"2026-09-26T03:34:56.123456+00:00","policy_version":"v1","strategy_identity":{"legs":[{"price":"1.25","quantity":1,"side":"buy","symbol":"AAPL260116C00200000"}],"limit_price":"1.25","max_loss":"125","quantity":1,"side":"buy","strategy_type":"SINGLE_LEG_OPTION","underlying_symbol":"AAPL"},"workspace_id":"tenant"}`
	digest := sha256.Sum256([]byte(canonical))
	want := hex.EncodeToString(digest[:])
	if got := AlphaDeskAuthorizationFingerprint(identity, order, "v1"); got != want {
		t.Fatalf("authorization fingerprint=%s, want canonical contract digest %s", got, want)
	}
}

func TestValidateAutonomousPaperAuthorizationBindsExactIdentityAndContext(t *testing.T) {
	identity := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant"}
	order := authorizationTestOrder()
	now := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	order.AssessmentExpiresAt = now.Add(time.Minute)
	auth := &interfaces.AutonomousPaperAuthorization{
		Allowed: true, AuthorizationID: "auth-1", Mode: "PAPER_ONLY", Environment: "PAPER", WorkspaceID: "tenant", AccountID: "acct",
		Issuer: "AlphaDesk", Source: "strategy_assessment", IssuedAt: now.Add(-time.Minute), ExpiresAt: order.AssessmentExpiresAt, PolicyVersion: "v1",
		StrategyIdentity: autonomousPaperStrategyIdentity(order),
	}
	auth.Fingerprint = AlphaDeskAuthorizationFingerprint(identity, order, auth.PolicyVersion)
	assessment := &interfaces.AlphaDeskAssessment{AutonomousPaperAuthorization: auth}
	if err := ValidateAutonomousPaperAuthorization(assessment, identity, order, "legacy-audit-binding", now); err != nil {
		t.Fatalf("valid authorization rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*interfaces.AutonomousPaperAuthorization)
	}{
		{"underlying mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.StrategyIdentity.UnderlyingSymbol = "MSFT" }},
		{"strategy mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.StrategyIdentity.StrategyType = "OTHER" }},
		{"leg price mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.StrategyIdentity.Legs[0].Price = "1.26" }},
		{"account mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.AccountID = "other" }},
		{"workspace mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.WorkspaceID = "other" }},
		{"environment mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.Environment = "LIVE" }},
		{"issuer missing", func(a *interfaces.AutonomousPaperAuthorization) { a.Issuer = "" }},
		{"source missing", func(a *interfaces.AutonomousPaperAuthorization) { a.Source = "" }},
		{"policy version missing", func(a *interfaces.AutonomousPaperAuthorization) { a.PolicyVersion = "" }},
		{"expiry does not match assessed order", func(a *interfaces.AutonomousPaperAuthorization) {
			a.ExpiresAt = order.AssessmentExpiresAt.Add(time.Second)
		}},
		{"fingerprint mismatch", func(a *interfaces.AutonomousPaperAuthorization) { a.Fingerprint = "wrong" }},
		{"expired", func(a *interfaces.AutonomousPaperAuthorization) { a.ExpiresAt = now.Add(-time.Second) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			copy := *auth
			copy.StrategyIdentity.Legs = append([]interfaces.AutonomousPaperStrategyLeg(nil), auth.StrategyIdentity.Legs...)
			tc.mutate(&copy)
			if err := ValidateAutonomousPaperAuthorization(&interfaces.AlphaDeskAssessment{AutonomousPaperAuthorization: &copy}, identity, order, "legacy-audit-binding", now); err == nil {
				t.Fatal("mismatched authorization was accepted")
			}
		})
	}
}

func TestAlphaDeskAssessmentUsesLocalFingerprintBecauseResponseHasNoIdentityField(t *testing.T) {
	request := readyAlphaRequest()
	request.TradeFingerprint = "locally-bound-fingerprint"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"decision":"PASS","market_scanner_signal_score":72.5,"policy_snapshot":{"minimum_signal_score":65}}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if a.Fingerprint != request.TradeFingerprint {
		t.Fatalf("fingerprint=%q, want local request binding %q", a.Fingerprint, request.TradeFingerprint)
	}
}

func TestAlphaDeskAssessmentAcceptsStringSignalScore(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"decision":"PASS","market_scanner_signal_score":"72.5","policy_snapshot":{"minimum_signal_score":"65"}}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), readyAlphaRequest())
	if err != nil || a.SignalScore == nil || *a.SignalScore != 72.5 {
		t.Fatalf("assessment=%#v err=%v, want string score decoded as 72.5", a, err)
	}
}

func TestAlphaDeskAssessmentAcceptsNullSignalScore(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"decision":"PASS","market_scanner_signal_score":null}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), readyAlphaRequest())
	if err != nil || a.SignalScore != nil {
		t.Fatalf("assessment=%#v err=%v, want null score preserved as absent", a, err)
	}
}

func TestAlphaDeskAssessmentRejectsMalformedOrNonFiniteSignalScore(t *testing.T) {
	for _, score := range []string{`"not-a-number"`, `"NaN"`, `"+Inf"`, `NaN`, `1e999`} {
		t.Run(score, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"decision":"PASS","market_scanner_signal_score":` + score + `}`))
			}))
			defer ts.Close()
			c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
			if _, err := c.Assess(context.Background(), readyAlphaRequest()); err == nil {
				t.Fatalf("score %s was accepted", score)
			}
		})
	}
}

func TestAlphaDesk422IsValidationNotGatewayFailure(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnprocessableEntity) }))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	_, err := c.Assess(context.Background(), readyAlphaRequest())
	var validation *AlphaDeskValidationError
	if !errors.As(err, &validation) || validation.Status != http.StatusUnprocessableEntity {
		t.Fatalf("err=%T %v, want typed 422 validation", err, err)
	}
}

func TestAlphaDesk400IsProviderValidationNotUnavailable(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadRequest) }))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: "secret", HTTP: ts.Client(), Now: time.Now}
	_, err := c.Assess(context.Background(), readyAlphaRequest())
	var validation *AlphaDeskValidationError
	if !errors.As(err, &validation) || validation.Status != http.StatusBadRequest {
		t.Fatalf("err=%T %v, want typed 400 validation", err, err)
	}
}

func TestAlphaDeskMissingEvidenceIsStructuredUnavailable(t *testing.T) {
	c := &AlphaDeskClient{Enabled: true, URL: "http://localhost:1", APIKey: "secret", HTTP: http.DefaultClient, Now: time.Now}
	_, err := c.AssessForTrade(context.Background(), models.DurableIdentity{}, &interfaces.OptionsOrder{Underlying: "AAPL"}, nil)
	var unavailable *AlphaDeskUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("err=%T %v, want typed unavailable", err, err)
	}
}

func testAssessment(fp, decision string, score, threshold float64, expiry time.Time) *interfaces.AlphaDeskAssessment {
	return &interfaces.AlphaDeskAssessment{AssessmentID: "a-1", Decision: decision, SignalScore: &score, Threshold: &threshold, ExpiresAt: expiry, Fingerprint: fp, ExecutionAllowed: true}
}

func TestValidateAlphaDeskAssessment(t *testing.T) {
	id := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	fp := OptionsTradeFingerprint(id, "AAPL240119C00100000", "AAPL", "buy", "buy_to_open", 1, nil)
	now := time.Now()
	tests := []struct {
		name       string
		assessment *interfaces.AlphaDeskAssessment
		want       bool
	}{
		{"PASS", testAssessment(fp, "PASS", .8, .7, now.Add(time.Minute)), true},
		{"PASS with execution disallowed", func() *interfaces.AlphaDeskAssessment {
			a := testAssessment(fp, "PASS", .8, .7, now.Add(time.Minute))
			a.ExecutionAllowed = false
			return a
		}(), false},
		{"PASS with human approval required", func() *interfaces.AlphaDeskAssessment {
			a := testAssessment(fp, "PASS", .8, .7, now.Add(time.Minute))
			a.HumanApprovalRequired = true
			return a
		}(), false},
		{"FAIL", testAssessment(fp, "FAIL", .8, .7, now.Add(time.Minute)), false},
		{"missing score", func() *interfaces.AlphaDeskAssessment {
			a := testAssessment(fp, "PASS", .8, .7, now.Add(time.Minute))
			a.SignalScore = nil
			return a
		}(), false},
		{"below threshold", testAssessment(fp, "PASS", .6, .7, now.Add(time.Minute)), false},
		{"wrong fingerprint", testAssessment("other", "PASS", .8, .7, now.Add(time.Minute)), false},
		{"expired replay", testAssessment(fp, "PASS", .8, .7, now.Add(-time.Second)), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAlphaDeskAssessment(tt.assessment, fp, now)
			if (err == nil) != tt.want {
				t.Fatalf("err=%v want=%v", err, tt.want)
			}
		})
	}
}

func TestAlphaDeskAssessmentClientRedactsSecret(t *testing.T) {
	secret := "alpha-secret-never-log-me"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-AlphaDesk-API-Key") != secret {
			t.Errorf("missing API key header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"assessment_id":"a-1","pass":true,"signal_score":0.9,"execution_threshold":0.8,"expires_at":"2099-01-01T00:00:00Z","policy":{"name":"test"},"evidence":{"source":"scanner"}}`))
	}))
	defer ts.Close()
	c := &AlphaDeskClient{Enabled: true, URL: ts.URL, APIKey: secret, HTTP: ts.Client(), Now: time.Now}
	a, err := c.Assess(context.Background(), AlphaDeskAssessmentRequest{TradeFingerprint: "fp"})
	if err != nil || a.Decision != "PASS" || a.Threshold == nil {
		t.Fatalf("assessment=%#v err=%v", a, err)
	}
	if strings.Contains(assessmentMetadata(a), secret) {
		t.Fatal("assessment metadata leaked API key")
	}
}

func TestValidateAlphaDeskURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		ok   bool
	}{
		{"https", "https://alphadesk.example", true},
		{"localhost development", "http://localhost:8080", true},
		{"loopback development", "http://127.0.0.1:8080", true},
		{"plain http remote", "http://alphadesk.example", false},
		{"userinfo", "https://user:secret@alphadesk.example", false},
		{"relative", "alphadesk.example", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAlphaDeskURL(tt.url)
			if (err == nil) != tt.ok {
				t.Fatalf("ValidateAlphaDeskURL(%q) error = %v, want ok=%v", tt.url, err, tt.ok)
			}
		})
	}
}
