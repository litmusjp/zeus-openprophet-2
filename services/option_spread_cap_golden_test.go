package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// The golden receipts are produced by AlphaDesk itself (v1: the evaluator that is live; v2: the new evaluator),
// so these tests cross the real wire format: policy state, receipt validation, the spread cap and both order guards.
func TestRealAlphaDeskReceiptsCrossTheSpreadCapAndEvaluatorGuards(t *testing.T) {
	now := time.Date(2026, 10, 6, 15, 0, 1, 0, time.UTC)
	const reference = "op2-receipt-wire-format"
	for _, tc := range []struct {
		file, profile string
		policyNamesIt bool
	}{
		{"testdata/op2-pass-receipt.json", scoreProfileV1, false},
		{"testdata/op2-pass-receipt-v2.json", scoreProfileV2, true},
	} {
		t.Run(tc.profile, func(t *testing.T) {
			golden, err := os.ReadFile(tc.file)
			if err != nil {
				t.Fatal(err)
			}
			var receipt map[string]any
			if err := json.Unmarshal(golden, &receipt); err != nil {
				t.Fatal(err)
			}
			if receipt["score_profile"] != tc.profile {
				t.Fatalf("golden is %v, want %s", receipt["score_profile"], tc.profile)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					policy := map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": receipt["policy_version"], "policy_snapshot": receipt["policy_snapshot"], "minimum_passing_score": receipt["minimum_passing_score"]}
					if tc.policyNamesIt {
						policy["score_profile"] = tc.profile
					}
					_ = json.NewEncoder(w).Encode(policy)
					return
				}
				_, _ = w.Write(golden)
			}))
			defer server.Close()
			client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
			price := 1.84
			newOrder := func(audits *int) *interfaces.OptionsOrder {
				return &interfaces.OptionsOrder{Symbol: "AAPL261106C00200000", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price, ClientOrderID: reference,
					AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { *audits++; return nil }}
			}
			service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: "paper", expectedTenantID: "tenant", expectedSandboxID: "sandbox", policy: &TradingPolicy{}, alphaDesk: client}

			// AlphaDesk's own observation on the golden is a 5.00% spread.
			for _, capPct := range []float64{10, 5.01, 5} {
				audits := 0
				order := newOrder(&audits)
				if err := service.SetOptionSpreadCapPct(capPct); err != nil {
					t.Fatal(err)
				}
				if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil || audits != 1 || order.AlphaDeskAssessment == nil || order.AlphaDeskAssessment.ScoreProfile != tc.profile {
					t.Fatalf("cap %v refused a 5%% spread on a real receipt: %v", capPct, err)
				}
				if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); err != nil {
					t.Fatalf("cap %v: submission guard refused: %v", capPct, err)
				}
			}
			for _, capPct := range []float64{4.99, 4} {
				audits := 0
				order := newOrder(&audits)
				if err := service.SetOptionSpreadCapPct(capPct); err != nil {
					t.Fatal(err)
				}
				err := service.requirePaperAdvisoryQualification(context.Background(), order)
				if spreadCapCode(err) != optionSpreadAboveCapCode || audits != 0 || order.AlphaDeskAssessment != nil {
					t.Fatalf("cap %v accepted a 5%% spread: err=%v audits=%d", capPct, err, audits)
				}
			}
		})
	}
}
