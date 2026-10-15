package controllers

import (
	"context"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"testing"
)

// Unimplemented broker/account methods panic if the read-only route calls them.
type standaloneOnlyService struct {
	interfaces.TradingService
	calls         int
	unavailable   bool
	errorCategory string
	errorStage    string
	policy        map[string]any
	policyErr     bool
	policyCalls   int
	assessmentErr *services.AlphaDeskUnavailableError
}

func (s *standaloneOnlyService) ReadStandaloneAssessmentPolicy(_ context.Context) (map[string]any, error) {
	s.policyCalls++
	if s.policyErr {
		return nil, &services.AlphaDeskUnavailableError{Reason: "private upstream detail"}
	}
	return s.policy, nil
}

func (s *standaloneOnlyService) AssessOptionsTradeReadOnly(_ context.Context, p services.StandaloneTradeProposal) (map[string]any, error) {
	s.calls++
	if s.unavailable {
		if s.assessmentErr != nil {
			return nil, s.assessmentErr
		}
		return nil, &services.AlphaDeskUnavailableError{Reason: "private upstream detail", Category: s.errorCategory, Stage: s.errorStage}
	}
	return map[string]any{"decision": "FAIL", "signal_score": 40, "execution_allowed": false, "remediation": []string{"genuine stronger signal required"}}, nil
}

func TestStandaloneUnavailableProjectsOnlySafeReceiptDiagnostics(t *testing.T) {
	gin.SetMode(gin.TestMode)
	delta := int64(2)
	service := &standaloneOnlyService{unavailable: true, assessmentErr: &services.AlphaDeskUnavailableError{
		Reason: "secret body/token", Category: "response_validation", Stage: "observed_at", ProviderDecision: "PASS",
		AssessmentID: "888c17f7-e4af-408f-a8bb-50109488f262", TimestampRejection: "future",
		ProviderObservedAt: "2026-10-06T15:00:00Z", ConsumerCheckedAt: "2026-10-06T14:59:59.998Z", ClockDeltaMillis: &delta,
	}}
	controller := NewOrderController(service, nil, nil)
	router := gin.New()
	router.POST("/options/trade-assessment", controller.AssessOptionsTrade)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/options/trade-assessment", strings.NewReader(`{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":1.84,"client_reference":"op2-receipt-wire-format"}`)))
	body := w.Body.String()
	for _, want := range []string{`"decision":"UNAVAILABLE"`, `"signal_score":null`, `"execution_allowed":false`, `"provider_scalars_validated":false`, `"provider_reported_decision":"PASS"`, `"provider_reported_assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262"`, `"timestamp_rejection":"future"`, `"provider_observed_at":"2026-10-06T15:00:00Z"`, `"consumer_checked_at":"2026-10-06T14:59:59.998Z"`, `"clock_delta_millis":2`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing safe diagnostic %s: %s", want, body)
		}
	}
	for _, want := range []string{"bounded later read-only reassessment", "Never blindly retry an uncertain broker order; reconcile its status first"} {
		if !strings.Contains(body, want) {
			t.Fatalf("remediation missing %q: %s", want, body)
		}
	}
	for _, forbidden := range []string{"secret body", "token", `"pass":true`, "execution_allowed\":true"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("unsafe diagnostic leaked %q: %s", forbidden, body)
		}
	}
	unsafe := standaloneUnavailable("response_validation")
	addStandaloneErrorDiagnostics(unsafe, &services.AlphaDeskUnavailableError{ProviderDecision: "PASS\nprivate", AssessmentID: "private-id", TimestampRejection: "future\nsecret", ProviderObservedAt: "private timestamp", ConsumerCheckedAt: "private timestamp"})
	if unsafe["provider_scalars_validated"] != false {
		t.Fatalf("unvalidated scalar flag missing: %#v", unsafe)
	}
	for _, key := range []string{"provider_reported_decision", "provider_reported_assessment_id", "timestamp_rejection", "provider_observed_at", "consumer_checked_at"} {
		if _, exists := unsafe[key]; exists {
			t.Fatalf("unsafe scalar %q projected: %#v", key, unsafe[key])
		}
	}
}

func TestOptionsAssessmentPolicyRouteSerializesPolicyOnlyAndFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name      string
		policy    map[string]any
		policyErr bool
		status    int
		want      string
	}{
		{"valid", map[string]any{"kind": "assessment_policy_metadata", "decision": "POLICY_ONLY", "assessment_performed": false, "policy_version": "v", "max_investment_per_candidate": "750", "maximum_contracts_per_candidate": 3, "standard_contract_multiplier": 100, "execution_allowed": false}, false, 200, `"max_investment_per_candidate":"750"`},
		{"unavailable", nil, true, 503, `"status":"unavailable"`},
		{"missing_reader", nil, false, 503, `"decision":"POLICY_ONLY"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &standaloneOnlyService{policy: tc.policy, policyErr: tc.policyErr}
			var trading interfaces.TradingService = service
			if tc.name == "missing_reader" {
				trading = nil
			}
			controller := NewOrderController(trading, nil, nil)
			router := gin.New()
			router.GET("/options/assessment-policy", controller.ReadOptionsAssessmentPolicy)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/options/assessment-policy", nil))
			if response.Code != tc.status || !strings.Contains(response.Body.String(), tc.want) {
				t.Fatalf("unexpected policy response: status=%d body=%s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "private upstream") || strings.Contains(response.Body.String(), `"signal_score"`) || strings.Contains(response.Body.String(), `"pass"`) {
				t.Fatalf("policy endpoint exposed internal or assessment data: %s", response.Body.String())
			}
			wantCalls := 1
			if tc.name == "missing_reader" {
				wantCalls = 0
			}
			if service.policyCalls != wantCalls || service.calls != 0 {
				t.Fatalf("unexpected assessment/policy callbacks: policy=%d assessment=%d", service.policyCalls, service.calls)
			}
		})
	}
}

func TestStandaloneUnavailableOmitsUnrecognizedValidationStages(t *testing.T) {
	result := standaloneUnavailable("response_validation", "private-upstream-value")
	if _, exists := result["validation_stage"]; exists {
		t.Fatalf("unallowlisted stage leaked: %#v", result["validation_stage"])
	}
	if result := standaloneUnavailable("response_validation", "market_data.source_quote_times"); result["validation_stage"] != "market_data.source_quote_times" {
		t.Fatalf("new safe quote timestamp stage omitted: %#v", result)
	}
}
func TestStandaloneHTTPControllerReadOnlyValidationAndFeedback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, body    string
		status, calls int
		unavailable   bool
		category      string
		stage         string
	}{
		{"feedback", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2}`, 200, 1, false, "", ""},
		{"outage", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2}`, 200, 1, true, "transport_error", ""},
		{"response_validation_stage", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2}`, 200, 1, true, "response_validation", "trade"},
		{"caller_score", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2,"signal_score":100}`, 400, 0, false, "", ""},
		{"invalid_quantity", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":0,"limit_price":2}`, 400, 0, false, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &standaloneOnlyService{unavailable: tc.unavailable, errorCategory: tc.category, errorStage: tc.stage}
			controller := NewOrderController(s, nil, nil)
			r := gin.New()
			r.POST("/options/trade-assessment", controller.AssessOptionsTrade)
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/options/trade-assessment", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			r.ServeHTTP(w, req)
			if w.Code != tc.status || s.calls != tc.calls {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, s.calls, w.Body.String())
			}
			if tc.unavailable && (strings.Contains(w.Body.String(), "private upstream") || !strings.Contains(w.Body.String(), `"decision":"UNAVAILABLE"`)) {
				t.Fatal("unsanitized or misleading outage")
			}
			if tc.unavailable && !strings.Contains(w.Body.String(), `"blocking_reasons":["`+tc.category+`"]`) {
				t.Fatalf("category missing: %s", w.Body.String())
			}
			if tc.stage != "" && !strings.Contains(w.Body.String(), `"validation_stage":"`+tc.stage+`"`) {
				t.Fatalf("safe validation stage missing: %s", w.Body.String())
			}
			if tc.unavailable && (!strings.Contains(w.Body.String(), `"source":"unknown"`) || !strings.Contains(w.Body.String(), `"requested_feed":"indicative"`)) {
				t.Fatal("outage claimed an observed provider source")
			}
			if tc.unavailable && (!strings.Contains(w.Body.String(), `"advisory_policy_profile":"paper_advisory_greeks_v1"`) || !strings.Contains(w.Body.String(), `"human_approval_required":true`)) {
				t.Fatal("outage omitted advisory safety metadata")
			}
			if tc.name == "feedback" && !strings.Contains(w.Body.String(), "genuine stronger signal required") {
				t.Fatal("lost assessment feedback")
			}
		})
	}
}
