package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

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
