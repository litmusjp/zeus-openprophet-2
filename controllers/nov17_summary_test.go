package controllers

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"prophet-trader/interfaces"
	"prophet-trader/services"
)

// Nov 17: the options order response carries AlphaDesk's score, real catalyst confidence, worst-leg spread and score profile for
// a final PASS only. These tests drive the public response boundary (optionsResponseWithIdentity + attachAssessmentError) and
// inspect the marshalled JSON, so they compile and fail by assertion on code that predates the fields.

const nov17Managed = `{"scope":"TRADE_ASSESSMENT","assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262","decision":"PASS","pass":true,"contract_version":"managed-assessment-v1","assessment_authority":"assessment_only","approval_gate":{"required":false,"revision":9,"scope":{"workspace_id":"a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1","assessment_key_id":"b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2"}},"policy_version":"standalone-paper-advisory-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:managed:9:False:quality:2"`

// nov17Audit appends extra top-level members to the managed PASS audit (the real Nov 16 BA receipt values by default).
func nov17Audit(extra string) string {
	if extra == "" {
		return nov17Managed + `}`
	}
	return nov17Managed + `,` + extra + `}`
}

const nov17Evidence = `"evidence":{"catalyst_confidence":0.69,"score_components":{"catalyst_confidence":0.207},"option_quotes":[{"spread_ratio":"0.02736726874657909140667761357"}]}`
const nov17Full = `"signal_score":56.38,"score_profile":"catalyst_momentum_v2",` + nov17Evidence

// nov17Response builds the response the way the controller does for an acknowledged opening.
func nov17Response(metadata string) *interfaces.OrderResult {
	intent := &interfaces.Order{ClientOrderID: "cid-n17", BrokerAccountID: "broker-n17", PaperLive: "paper", TenantID: "tenant-n17", SandboxID: "sbx-n17", Metadata: metadata}
	return (&OrderController{}).optionsResponseWithIdentity(intent, nil, "pending_new", "Broker acknowledged the order; execution is not confirmed.")
}

func nov17Map(t *testing.T, result *interfaces.OrderResult) map[string]any {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("response is not JSON serializable: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

var nov17SummaryKeys = []string{"assessment_signal_score", "assessment_catalyst_confidence", "assessment_observed_spread_pct", "assessment_score_profile"}

func nov17Expect(t *testing.T, m map[string]any, want map[string]any) {
	t.Helper()
	for _, key := range nov17SummaryKeys {
		wantValue, wanted := want[key]
		got, present := m[key]
		if wanted != present {
			t.Fatalf("%s: present=%v, want present=%v (response %v)", key, present, wanted, m)
		}
		if wanted && got != wantValue {
			t.Fatalf("%s = %v, want %v", key, got, wantValue)
		}
	}
}

func TestOrderResponseCarriesAssessmentSummaryOnPass(t *testing.T) {
	m := nov17Map(t, nov17Response(nov17Audit(nov17Full)))
	if m["assessment_decision"] != "PASS" {
		t.Fatalf("decision = %v", m["assessment_decision"])
	}
	nov17Expect(t, m, map[string]any{
		"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69,
		"assessment_observed_spread_pct": 2.74, "assessment_score_profile": "catalyst_momentum_v2",
	})
	if m["status"] != "pending_new" || m["message"] != "Broker acknowledged the order; execution is not confirmed." {
		t.Fatalf("status or message changed: %v / %v", m["status"], m["message"])
	}
}

func TestOrderResponseSummaryEdgeCases(t *testing.T) {
	cases := []struct {
		name  string
		extra string
		want  map[string]any
	}{
		{"worst leg of two", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0.69,"option_quotes":[{"spread_ratio":"0.0139"},{"spread_ratio":"0.0498"}]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_observed_spread_pct": 4.98, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"numeric spread ratio", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0.69,"option_quotes":[{"spread_ratio":0.0139}]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_observed_spread_pct": 1.39, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"one invalid leg leaves the spread unset", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0.69,"option_quotes":[{"spread_ratio":"0.0139"},{"spread_ratio":"abc"}]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"negative spread ratio leaves the spread unset", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0.69,"option_quotes":[{"spread_ratio":"-0.1"}]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"empty quotes leave the spread unset", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0.69,"option_quotes":[]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"no evidence block", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2"`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"valid zero values survive", `"signal_score":0,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":0,"option_quotes":[{"spread_ratio":"0"}]}`,
			map[string]any{"assessment_signal_score": 0.0, "assessment_catalyst_confidence": 0.0, "assessment_observed_spread_pct": 0.0, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"out-of-range score and confidence are omitted", `"signal_score":150,"score_profile":"catalyst_momentum_v2","evidence":{"catalyst_confidence":1.5,"option_quotes":[{"spread_ratio":"0.0139"}]}`,
			map[string]any{"assessment_observed_spread_pct": 1.39, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"the weighted score component is never the confidence", `"signal_score":56.38,"score_profile":"catalyst_momentum_v2","evidence":{"score_components":{"catalyst_confidence":0.207},"option_quotes":[{"spread_ratio":"0.0139"}]}`,
			map[string]any{"assessment_signal_score": 56.38, "assessment_observed_spread_pct": 1.39, "assessment_score_profile": "catalyst_momentum_v2"}},
		{"overlong profile is omitted", `"signal_score":56.38,"score_profile":"` + strings.Repeat("x", 65) + `"`,
			map[string]any{"assessment_signal_score": 56.38}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := nov17Map(t, nov17Response(nov17Audit(tc.extra)))
			if m["assessment_decision"] != "PASS" {
				t.Fatalf("decision = %v", m["assessment_decision"])
			}
			nov17Expect(t, m, tc.want)
		})
	}
}

func TestOrderResponseSummaryAbsentWhenAuditIsNotAValidPass(t *testing.T) {
	managed := nov17Audit(nov17Full)
	legacy := `{"scope":"TRADE_ASSESSMENT","assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262","decision":"PASS","pass":true,"execution_allowed":false,"human_approval_required":true}`
	for name, audit := range map[string]string{
		"gate required":          strings.Replace(managed, `"required":false`, `"required":true`, 1),
		"wrong authority":        strings.Replace(managed, `"assessment_authority":"assessment_only"`, `"assessment_authority":"trade_authority"`, 1),
		"approval claim":         strings.Replace(managed, `"assessment_authority":"assessment_only"`, `"assessment_authority":"assessment_only","human_approval_required":true`, 1),
		"revision mismatch":      strings.Replace(managed, `:managed:9:False`, `:managed:8:False`, 1),
		"decision FAIL":          strings.Replace(managed, `"decision":"PASS","pass":true`, `"decision":"FAIL","pass":false`, 1),
		"not an assessment":      `{"reason":"exit order","signal_score":56.38}`,
		"malformed metadata":     `{"signal_score":`,
		"empty metadata":         ``,
		"legacy audit (no data)": legacy,
	} {
		m := nov17Map(t, nov17Response(audit))
		decision, _ := m["assessment_decision"].(string)
		if name == "legacy audit (no data)" {
			if decision != "PASS" {
				t.Fatalf("%s: legacy audit semantics changed, decision %q", name, decision)
			}
		} else if decision != "" {
			t.Fatalf("%s: contradictory or non-assessment audit projected %q", name, decision)
		}
		nov17Expect(t, m, map[string]any{})
	}
}

func TestOrderResponseWithoutAssessmentIsByteIdenticalToTheLiveBuild(t *testing.T) {
	// Captured from 6b65eb1 (unpatched) for an intent with no assessment metadata, and for a non-assessment metadata blob.
	const want = `{"broker_account_id":"broker-n17","paper_live":"paper","tenant_id":"tenant-n17","sandbox_id":"sbx-n17","status":"pending_new","message":"Broker acknowledged the order; execution is not confirmed.","client_order_id":"cid-n17","filled_qty":0,"submitted_at":"0001-01-01T00:00:00Z","execution_confirmed":false,"fully_filled":false}`
	for name, metadata := range map[string]string{"no metadata": "", "exit metadata": `{"reason":"exit order","signal_score":56.38}`} {
		raw, err := json.Marshal(nov17Response(metadata))
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != want {
			t.Fatalf("%s: response changed:\n got %s\nwant %s", name, raw, want)
		}
	}
}

func nov17PassResult(t *testing.T) *interfaces.OrderResult {
	t.Helper()
	result := nov17Response(nov17Audit(nov17Full))
	if result.AssessmentDecision != "PASS" {
		t.Fatalf("fixture is not a PASS: %q", result.AssessmentDecision)
	}
	// The summary must be there before the final verdict is applied, or clearing it would prove nothing.
	nov17Expect(t, nov17Map(t, result), map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_observed_spread_pct": 2.74, "assessment_score_profile": "catalyst_momentum_v2"})
	return result
}

func TestFinalVerdictReplacingPassClearsTheSummary(t *testing.T) {
	for _, decision := range []string{"FAIL", "UNAVAILABLE"} {
		result := nov17PassResult(t)
		attachAssessmentError(result, &services.AlphaDeskUnavailableError{Decision: decision, Category: "assessment_rejected", Stage: "decision", Reason: "refused"})
		m := nov17Map(t, result)
		if m["assessment_decision"] != decision {
			t.Fatalf("decision = %v, want %s", m["assessment_decision"], decision)
		}
		nov17Expect(t, m, map[string]any{})
	}
}

func TestUnknownDecisionKeepsAPriorPassAndItsSummary(t *testing.T) {
	// Existing semantics: only an explicit FAIL or UNAVAILABLE replaces a prior PASS.
	result := nov17PassResult(t)
	before := nov17Map(t, result)
	attachAssessmentError(result, &services.AlphaDeskUnavailableError{Decision: "MAYBE", Category: "upstream_service_error", Stage: "decision", Reason: "odd"})
	after := nov17Map(t, result)
	if after["assessment_decision"] != "PASS" {
		t.Fatalf("an unknown decision replaced a prior PASS: %v", after["assessment_decision"])
	}
	nov17Expect(t, after, map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_observed_spread_pct": 2.74, "assessment_score_profile": "catalyst_momentum_v2"})
	for _, key := range []string{"status", "message", "execution_confirmed"} {
		if before[key] != after[key] {
			t.Fatalf("%s changed: %v -> %v", key, before[key], after[key])
		}
	}
}

func TestUnknownDecisionWithoutAPriorPassIsUnavailableWithNoSummary(t *testing.T) {
	result := nov17Response("")
	attachAssessmentError(result, &services.AlphaDeskUnavailableError{Decision: "MAYBE", Category: "upstream_service_error", Stage: "decision", Reason: "odd"})
	m := nov17Map(t, result)
	if m["assessment_decision"] != "UNAVAILABLE" {
		t.Fatalf("decision = %v, want UNAVAILABLE", m["assessment_decision"])
	}
	nov17Expect(t, m, map[string]any{})
}

func TestRetainedPassKeepsSummaryAndEveryOtherFieldOnExecutionBlockOrBrokerUncertainty(t *testing.T) {
	want := map[string]any{"assessment_signal_score": 56.38, "assessment_catalyst_confidence": 0.69, "assessment_observed_spread_pct": 2.74, "assessment_score_profile": "catalyst_momentum_v2"}
	blocked := nov17PassResult(t)
	before := nov17Map(t, blocked)
	attachAssessmentError(blocked, &services.PreSubmissionRejectionError{Err: errors.New("the entry spread cap changed after confirmation")})
	after := nov17Map(t, blocked)
	if after["assessment_decision"] != "PASS" || after["assessment_category"] != "execution_blocked" {
		t.Fatalf("execution block changed the verdict: %v / %v", after["assessment_decision"], after["assessment_category"])
	}
	nov17Expect(t, after, want)
	for _, key := range []string{"status", "message", "execution_confirmed", "fully_filled"} {
		if before[key] != after[key] {
			t.Fatalf("%s changed: %v -> %v", key, before[key], after[key])
		}
	}

	uncertain := nov17PassResult(t)
	before = nov17Map(t, uncertain)
	attachAssessmentError(uncertain, &services.SubmissionUncertainError{Err: errors.New("broker timeout")})
	after = nov17Map(t, uncertain)
	if after["assessment_decision"] != "PASS" {
		t.Fatalf("broker uncertainty changed the verdict: %v", after["assessment_decision"])
	}
	nov17Expect(t, after, want)
	for key, value := range before {
		if after[key] != value {
			t.Fatalf("%s changed on broker uncertainty: %v -> %v", key, value, after[key])
		}
	}
	for key := range after {
		if _, existed := before[key]; !existed {
			t.Fatalf("broker uncertainty added %s", key)
		}
	}
}
