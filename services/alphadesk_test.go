package services

import (
	"context"
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
	return &interfaces.AlphaDeskAssessment{AssessmentID: "a-1", Decision: decision, SignalScore: &score, Threshold: &threshold, ExpiresAt: expiry, Fingerprint: fp}
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
