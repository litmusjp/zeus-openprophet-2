package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
)

func TestOptionsOrderRequestHasNoClientAssessmentAuthorizationField(t *testing.T) {
	if _, ok := reflect.TypeOf(OptionsOrderRequest{}).FieldByName("Assessment"); ok {
		t.Fatal("OptionsOrderRequest must not accept a client-supplied AlphaDesk assessment")
	}
}

func TestManagedAuditProjectionUsesGateContractAndRejectsLegacyClaims(t *testing.T) {
	managed := `{"scope":"TRADE_ASSESSMENT","assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262","decision":"PASS","pass":true,"contract_version":"managed-assessment-v1","assessment_authority":"assessment_only","approval_gate":{"required":false,"revision":9,"scope":{"workspace_id":"a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1","assessment_key_id":"b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2"}},"policy_version":"standalone-paper-advisory-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:managed:9:False:quality:2"}`
	if got := assessmentDecisionFromAudit(managed); got != "PASS" {
		t.Fatalf("managed audited PASS not projected: %q", got)
	}
	for _, invalid := range []string{
		strings.Replace(managed, `"required":false`, `"required":true`, 1),
		strings.Replace(managed, `"assessment_authority":"assessment_only"`, `"assessment_authority":"trade_authority"`, 1),
		strings.Replace(managed, `"assessment_authority":"assessment_only"`, `"assessment_authority":"assessment_only","human_approval_required":true`, 1),
		strings.Replace(managed, `:managed:9:False`, `:managed:8:False`, 1),
		strings.Replace(managed, `:managed:9:False`, `:managed:9:True`, 1),
	} {
		if got := assessmentDecisionFromAudit(invalid); got != "" {
			t.Fatalf("contradictory managed audit projected PASS: %q", got)
		}
	}
	legacy := `{"scope":"TRADE_ASSESSMENT","assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262","decision":"PASS","pass":true,"execution_allowed":false,"human_approval_required":true}`
	if got := assessmentDecisionFromAudit(legacy); got != "PASS" {
		t.Fatalf("legacy audit semantics changed: %q", got)
	}
	for _, invalid := range []string{
		strings.Replace(legacy, `,"assessment_id":"888c17f7-e4af-408f-a8bb-50109488f262"`, "", 1),
		strings.Replace(legacy, `"execution_allowed":false`, `"contract_version":"managed-assessment-v9","execution_allowed":false`, 1),
		strings.Replace(legacy, `"execution_allowed":false`, `"approval_gate":{},"execution_allowed":false`, 1),
	} {
		if got := assessmentDecisionFromAudit(invalid); got != "" {
			t.Fatalf("invalid legacy/unknown contract projected PASS: %q", got)
		}
	}
}

type plannedOptionsTradingService struct {
	*reconciliationTradingService
	nextOpen time.Time
	calls    int
}

type optionsResultTradingService struct {
	*reconciliationTradingService
	result *interfaces.OrderResult
}

type emptyOptionsChainTradingService struct {
	*reconciliationTradingService
	clock *interfaces.MarketClock
}

type recordingOptionsTradingService struct {
	*reconciliationTradingService
	identity    *interfaces.OptionsOrder
	result      *interfaces.OrderResult
	auditCalled bool
}

type postMarkerAbortOptionsService struct {
	*reconciliationTradingService
	marker         func(string) error
	finalAbort     error
	brokerCallback func()
}

type failingRejectedOptionsStorage struct{ interfaces.StorageService }

func (s *failingRejectedOptionsStorage) SaveOrder(order *interfaces.Order) error {
	if order != nil && order.Status == "rejected_before_submission" {
		return errors.New("simulated terminal persistence failure")
	}
	return s.StorageService.SaveOrder(order)
}

type diagnosticOptionsService struct {
	*reconciliationTradingService
	err        error
	recordPass bool
	audit      *interfaces.AlphaDeskAssessment
}

func (s *diagnosticOptionsService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	if s.recordPass {
		if err := order.AssessmentAuditSink(s.audit); err != nil {
			return nil, err
		}
	}
	return nil, s.err
}

func TestOptionsOrderHTTPPreservesAssessmentOutcomeDiagnostics(t *testing.T) {
	receipt, err := os.ReadFile("../services/testdata/op2-pass-receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	assessmentTime := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(receipt) }))
	defer fixture.Close()
	alphaDesk := &services.AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: fixture.URL, APIKey: "offline-fixture", HTTP: fixture.Client(), Now: func() time.Time { return assessmentTime }}
	clientReference := "op2-receipt-wire-format"
	validated, err := alphaDesk.AssessOptionsTrade(context.Background(), services.StandaloneTradeProposal{Legs: []services.StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("1.84"), ClientReference: &clientReference})
	if err != nil || validated["decision"] != "PASS" {
		t.Fatalf("producer fixture validation failed: decision=%v err=%v", validated["decision"], err)
	}
	scoreNumber, ok := validated["signal_score"].(json.Number)
	if !ok {
		t.Fatalf("validated score type=%T", validated["signal_score"])
	}
	score, err := scoreNumber.Float64()
	if err != nil {
		t.Fatal(err)
	}
	observedAt, err := time.Parse(time.RFC3339Nano, validated["observed_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, validated["expires_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	audit := &interfaces.AlphaDeskAssessment{Scope: "TRADE_ASSESSMENT", AssessmentID: validated["assessment_id"].(string), Decision: "PASS", Pass: true, SignalScore: &score,
		Evidence: validated, ExpiresAt: expiresAt, ObservedAt: observedAt, ExecutionAllowed: false, HumanApprovalRequired: true}
	for _, tc := range []struct {
		name, decision, category, stage string
		err                             error
		recordPass                      bool
		status                          int
	}{
		{name: "AlphaDesk FAIL", decision: "FAIL", category: "assessment_rejected", stage: "decision", err: &services.AlphaDeskUnavailableError{Reason: "AlphaDesk assessment returned FAIL", Decision: "FAIL", Category: "assessment_rejected", Stage: "decision"}, recordPass: true, status: http.StatusBadGateway},
		{name: "managed human review lock", decision: "UNAVAILABLE", category: "managed_review_required", stage: "approval_gate", err: &services.AlphaDeskUnavailableError{Reason: "AlphaDesk human-review lock is ON", Decision: "UNAVAILABLE", Category: "managed_review_required", Stage: "approval_gate"}, status: http.StatusBadGateway},
		{name: "managed revised OFF policy", decision: "UNAVAILABLE", category: "response_validation", stage: "approval_gate", err: &services.AlphaDeskUnavailableError{Reason: "Managed AlphaDesk receipt changed", Decision: "UNAVAILABLE", Category: "response_validation", Stage: "approval_gate"}, status: http.StatusBadGateway},
		{name: "managed unknown policy", decision: "UNAVAILABLE", category: "upstream_service_error", stage: "approval_gate", err: &services.AlphaDeskUnavailableError{Reason: "Managed AlphaDesk policy unavailable", Decision: "UNAVAILABLE", Category: "upstream_service_error", Stage: "approval_gate"}, status: http.StatusBadGateway},
		{name: "evidence unavailable", decision: "UNAVAILABLE", category: "response_validation", stage: "expires_at", err: &services.AlphaDeskUnavailableError{Reason: "Standalone evidence is unavailable", Decision: "UNAVAILABLE", Category: "response_validation", Stage: "expires_at"}, recordPass: true, status: http.StatusBadGateway},
		{name: "receipt clock rejection diagnostics", decision: "UNAVAILABLE", category: "response_validation", stage: "observed_at", err: &services.AlphaDeskUnavailableError{Reason: "private body and token", Category: "response_validation", Stage: "observed_at", ProviderDecision: "PASS", AssessmentID: "888c17f7-e4af-408f-a8bb-50109488f262", TimestampRejection: "future", ProviderObservedAt: "2026-10-06T15:00:00Z", ConsumerCheckedAt: "2026-10-06T14:59:59.998Z", ClockDeltaMillis: func() *int64 { value := int64(2); return &value }()}, status: http.StatusBadGateway},
		{name: "validated PASS then session block", decision: "PASS", category: "execution_blocked", stage: "market_session", recordPass: true, err: &services.MarketClosedError{}, status: http.StatusAccepted},
		{name: "validated PASS then evidence deadline block", decision: "PASS", category: "execution_blocked", stage: "evidence_observed_at", recordPass: true, err: &services.PreSubmissionRejectionError{Err: &services.AlphaDeskUnavailableError{Reason: "OP2 market evidence deadline expired", Category: "response_validation", Stage: "evidence_observed_at"}}, status: http.StatusConflict},
		{name: "validated PASS then context cancellation", decision: "PASS", category: "execution_blocked", stage: "submission_boundary", recordPass: true, err: &services.PreSubmissionRejectionError{Err: context.Canceled}, status: http.StatusConflict},
		{name: "validated PASS then policy lookup failure", decision: "PASS", category: "execution_blocked", stage: "policy_version", recordPass: true, err: &services.PreSubmissionRejectionError{Err: &services.AlphaDeskUnavailableError{Reason: "policy unavailable", Category: "configuration", Stage: "policy_version"}}, status: http.StatusConflict},
		{name: "PASS audit with broker uncertainty", decision: "PASS", category: "", stage: "", recordPass: true, err: &services.SubmissionUncertainError{Err: errors.New("stub broker timeout")}, status: http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dbPath := filepath.Join(t.TempDir(), "diagnostics.db")
			storage, err := database.NewLocalStorage(dbPath)
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()
			trading := &diagnosticOptionsService{reconciliationTradingService: &reconciliationTradingService{}, err: tc.err, recordPass: tc.recordPass, audit: audit}
			controller := NewOrderController(trading, nil, storage)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"op2-receipt-wire-format","symbol":"AAPL261106C00200000","underlying":"AAPL","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1.84}`))
			ctx.Request.Header.Set("Content-Type", "application/json")
			controller.PlaceOptionsOrder(ctx)
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			categoryMatches := body["assessment_category"] == tc.category
			stageMatches := body["assessment_stage"] == tc.stage
			if tc.category == "" {
				categoryMatches = body["assessment_category"] == nil
			}
			if tc.stage == "" {
				stageMatches = body["assessment_stage"] == nil
			}
			if recorder.Code != tc.status || body["assessment_decision"] != tc.decision || !categoryMatches || !stageMatches {
				t.Fatalf("HTTP %d response %#v; want decision=%s category=%s stage=%s", recorder.Code, body, tc.decision, tc.category, tc.stage)
			}
			if tc.name == "validated PASS then evidence deadline block" && !strings.Contains(body["assessment_reason"].(string), "evidence deadline expired") {
				t.Fatalf("evidence rejection reason=%v", body["assessment_reason"])
			}
			if tc.name == "validated PASS then policy lookup failure" && !strings.Contains(body["assessment_reason"].(string), "policy") {
				t.Fatalf("policy rejection reason=%v", body["assessment_reason"])
			}
			if tc.name == "AlphaDesk FAIL" && !strings.Contains(body["assessment_reason"].(string), "re-assess") {
				t.Fatalf("FAIL response lacks actionable safe remediation: %#v", body)
			}
			if tc.name == "managed human review lock" && !strings.Contains(body["assessment_reason"].(string), "human-review lock is ON") {
				t.Fatalf("managed gate response did not explain the operator lock safely: %#v", body)
			}
			if strings.HasPrefix(tc.name, "managed ") && tc.name != "managed human review lock" {
				reason := body["assessment_reason"].(string)
				if !strings.Contains(reason, "refresh current policy and requalify") || strings.Contains(reason, "human-review lock is ON") {
					t.Fatalf("changed/unknown gate must request requalification without claiming ON: %q", reason)
				}
			}
			if tc.name == "receipt clock rejection diagnostics" {
				reason := body["assessment_reason"].(string)
				for _, safe := range []string{"provider-reported decision PASS is unvalidated", "provider-reported assessment ID 888c17f7-e4af-408f-a8bb-50109488f262 is unvalidated", "observed_at rejected as future", "2 ms ahead", "2026-10-06T15:00:00Z", "2026-10-06T14:59:59.998Z"} {
					if !strings.Contains(reason, safe) {
						t.Fatalf("opening projection missing %q: %s", safe, reason)
					}
				}
				if strings.Contains(reason, "private body") || body["assessment_decision"] == "PASS" {
					t.Fatalf("opening projection leaked or promoted provider data: %#v", body)
				}
			}
			if strings.Contains(recorder.Body.String(), "private upstream") || strings.Contains(recorder.Body.String(), "fixture token") {
				t.Fatalf("unsafe assessment details leaked: %s", recorder.Body.String())
			}
			reopened, err := database.NewLocalStorage(dbPath)
			if err != nil {
				t.Fatal(err)
			}
			saved, err := reopened.GetOrderByClientOrderID("op2-receipt-wire-format")
			_ = reopened.Close()
			if err != nil || saved == nil {
				t.Fatalf("reopened controller order=%#v error=%v", saved, err)
			}
			if tc.recordPass && !strings.Contains(saved.Metadata, `"decision":"PASS"`) {
				t.Fatalf("validated assessment audit missing after reopen: %s", saved.Metadata)
			}
		})
	}
}

func (s *postMarkerAbortOptionsService) SetSubmissionMarker(marker func(string) error) {
	s.marker = marker
}

func (s *postMarkerAbortOptionsService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	if err := s.marker(order.ClientOrderID); err != nil {
		return nil, err
	}
	// This models a final local policy/context abort after durable marking and
	// before the stubbed broker callback.
	if s.finalAbort != nil {
		return nil, s.finalAbort
	}
	if s.brokerCallback != nil {
		s.brokerCallback()
	}
	return nil, errors.New("stub broker callback returned unexpectedly")
}

func TestPlaceOptionsOrderPostMarkerPreRPCAbortIsTerminalAndNotRisk(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "post-marker-abort.db")
	storage, err := database.NewLocalStorage(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if storage != nil {
			_ = storage.Close()
		}
	}()
	brokerCalls := 0
	trading := &postMarkerAbortOptionsService{reconciliationTradingService: &reconciliationTradingService{}, finalAbort: &services.PreSubmissionRejectionError{Err: context.Canceled}, brokerCallback: func() { brokerCalls++ }}
	controller := NewOrderController(trading, nil, storage)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"post-marker-abort","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1.25}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusConflict, recorder.Body.String())
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	storage = nil
	storage, err = database.NewLocalStorage(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := storage.GetOrderByClientOrderID("post-marker-abort")
	if err != nil {
		t.Fatal(err)
	}
	if saved.Status != "rejected_before_submission" || !saved.SubmissionAttempted {
		t.Fatalf("saved post-marker abort = %#v, want durable terminal pre-RPC outcome with attempted bit retained", saved)
	}
	if brokerCalls != 0 || services.IsRiskRelevantLocalOrder(saved) {
		t.Fatalf("broker calls=%d; risk relevant=%v, want zero calls and no broker risk", brokerCalls, services.IsRiskRelevantLocalOrder(saved))
	}
	reconciliation, err := storage.GetOrdersNeedingReconciliation()
	if err != nil || len(reconciliation) != 0 {
		t.Fatalf("reconciliation = %#v, %v; want no unresolved order", reconciliation, err)
	}
}

func TestPlaceOptionsOrderPostMarkerRejectionPersistenceFailureStaysUncertain(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "post-marker-abort-failure.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	trading := &postMarkerAbortOptionsService{reconciliationTradingService: &reconciliationTradingService{}, finalAbort: &services.PreSubmissionRejectionError{Err: context.Canceled}}
	controller := NewOrderController(trading, nil, &failingRejectedOptionsStorage{StorageService: storage})
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"post-marker-abort-failure","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1.25}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}
	saved, err := storage.GetOrderByClientOrderID("post-marker-abort-failure")
	if err != nil || saved == nil || saved.Status != "pending" || !saved.SubmissionAttempted {
		t.Fatalf("durable marker after rejected-state persistence failure = %#v, %v; want unresolved attempted intent", saved, err)
	}
}

func (s *recordingOptionsTradingService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	s.identity = order
	assessment := &interfaces.AlphaDeskAssessment{AssessmentID: "assessment-controller-boundary", Decision: "PASS", Pass: true, Qualified: true}
	s.auditCalled = true
	if err := order.AssessmentAuditSink(assessment); err != nil {
		return nil, err
	}
	result := *s.result
	return &result, nil
}

func (s *emptyOptionsChainTradingService) GetMarketClock(context.Context) (*interfaces.MarketClock, error) {
	return s.clock, nil
}

func TestOptionsChainEmptyResultDistinguishesClosedFromValidEmpty(t *testing.T) {
	for _, tc := range []struct {
		name string
		open bool
		want int
	}{
		{name: "pre-market", open: false, want: http.StatusServiceUnavailable},
		{name: "post-open empty", open: true, want: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trading := &emptyOptionsChainTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				clock:                        &interfaces.MarketClock{IsOpen: tc.open},
			}
			controller := NewOrderController(trading, nil, nil)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Params = gin.Params{{Key: "symbol", Value: "XLF"}}
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/XLF", nil)
			controller.GetOptionsChain(ctx)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}

func (s *optionsResultTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	result := *s.result
	return &result, nil
}

func TestPlaceOptionsOrderValidatesProviderResultAgainstServerIdentity(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*interfaces.OrderResult)
		wantStatus int
	}{
		{name: "complete matching identity", wantStatus: 200},
		{name: "missing identity", mutate: func(result *interfaces.OrderResult) { result.SandboxID = "" }, wantStatus: 502},
		{name: "mismatched identity", mutate: func(result *interfaces.OrderResult) { result.TenantID = "other-tenant" }, wantStatus: 502},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
			if err != nil {
				t.Fatalf("NewLocalStorage() error = %v", err)
			}
			defer storage.Close()
			identity := storage.DurableIdentity()

			result := &interfaces.OrderResult{
				OrderID: "broker-options-1", Status: "accepted", ClientOrderID: "opt-identity-1", Symbol: "TSLA251219C00400000",
				Side: "buy", Qty: 1, Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1.25),
				PositionIntent: "buy_to_open", Purpose: "entry",
				BrokerAccountID: identity.BrokerAccountID, PaperLive: identity.PaperLive, TenantID: identity.TenantID, SandboxID: identity.SandboxID,
			}
			if testCase.mutate != nil {
				testCase.mutate(result)
			}
			trading := &optionsResultTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				result:                       result,
			}
			controller := NewOrderController(trading, nil, storage)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"opt-identity-1","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1.25}`))
			ctx.Request.Header.Set("Content-Type", "application/json")

			controller.PlaceOptionsOrder(ctx)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
}

func TestPlaceOptionsOrderPassesStableIdentityFieldsAndAuditSinkToService(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()
	identity := storage.DurableIdentity()
	limit := 1.25
	maxLoss := 42.0
	observedAt := time.Date(2026, 9, 23, 13, 0, 0, 0, time.UTC)
	trading := &recordingOptionsTradingService{
		reconciliationTradingService: &reconciliationTradingService{},
		result: &interfaces.OrderResult{
			OrderID: "broker-boundary-1", Status: "accepted", ClientOrderID: "opt-boundary-1",
			Symbol: "TSLA251219C00400000", Side: "buy", Qty: 2, Type: "limit", TimeInForce: "day", LimitPrice: &limit,
			PositionIntent: "buy_to_open", Purpose: "entry", BrokerAccountID: identity.BrokerAccountID, PaperLive: identity.PaperLive,
			TenantID: identity.TenantID, SandboxID: identity.SandboxID,
		},
	}
	controller := NewOrderController(trading, nil, storage)
	body := `{"client_order_id":"opt-boundary-1","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":2,"side":"buy","position_intent":"buy_to_open","type":"limit","time_in_force":"day","limit_price":1.25,"strategy_type":"vertical","max_loss":42,"observed_at":"2026-09-23T13:00:00Z"}`
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	passed := trading.identity
	if passed == nil {
		t.Fatal("service did not receive an options order")
	}
	if !trading.auditCalled {
		t.Fatal("service did not invoke the assessment audit sink")
	}
	if passed.ClientOrderID != "opt-boundary-1" || passed.Symbol != "TSLA251219C00400000" || passed.Underlying != "TSLA" || passed.Qty != 2 || passed.Side != "buy" || passed.PositionIntent != "buy_to_open" || passed.Type != "limit" || passed.TimeInForce != "day" || passed.LimitPrice == nil || *passed.LimitPrice != limit || passed.StrategyType != "vertical" || passed.AssessmentMaxLoss == nil || *passed.AssessmentMaxLoss != maxLoss || !passed.ObservedAt.Equal(observedAt) {
		t.Fatalf("service received incomplete options order: %#v", passed)
	}
	if passed.AssessmentAuditSink == nil {
		t.Fatal("service did not receive the assessment audit sink")
	}
	durable, err := storage.GetOrderByClientOrderID("opt-boundary-1")
	if err != nil {
		t.Fatalf("GetOrderByClientOrderID() error = %v", err)
	}
	if durable == nil || !strings.Contains(durable.Metadata, "assessment-controller-boundary") {
		t.Fatalf("durable intent metadata = %#v, want assessment audit", durable)
	}
}

func (s *plannedOptionsTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	s.calls++
	return nil, &services.MarketClosedError{NextOpen: s.nextOpen}
}

func TestAttemptedPlannedOptionsIntentCannotBeReplayed(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "attempted-planned.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	eligible := time.Now().Add(-time.Minute)
	expires := time.Now().Add(time.Hour)
	order := &interfaces.Order{ClientOrderID: "attempted-planned", Symbol: "TSLA251219C00400000", Underlying: "TSLA", AssetClass: "us_option", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1.25), PositionIntent: "buy_to_open", Purpose: "entry", Status: "planned_for_next_session", SubmissionAttempted: true, NextEligibleAt: &eligible, ExpiresAt: &expires}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	trading := &plannedOptionsTradingService{reconciliationTradingService: &reconciliationTradingService{}, nextOpen: time.Now().Add(time.Hour)}
	controller := NewOrderController(trading, nil, storage)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"attempted-planned","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","time_in_force":"day","limit_price":1.25}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)
	if recorder.Code != http.StatusConflict || trading.calls != 0 {
		t.Fatalf("status=%d broker/service calls=%d body=%s; want replay fence before submission", recorder.Code, trading.calls, recorder.Body.String())
	}
	saved, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil || saved == nil || saved.Status != "planned_for_next_session" || !saved.SubmissionAttempted {
		t.Fatalf("attempted planned intent after replay rejection = %#v, %v; want lifecycle/attempt bit preserved", saved, err)
	}
}

func TestPlaceOptionsOrderPersistsPlannedIntentWhenMarketClosed(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()

	nextOpen := time.Date(2026, 9, 21, 13, 30, 0, 0, time.UTC)
	trading := &plannedOptionsTradingService{
		reconciliationTradingService: &reconciliationTradingService{},
		nextOpen:                     nextOpen,
	}
	controller := NewOrderController(trading, nil, storage)

	body, err := json.Marshal(map[string]any{
		"client_order_id": "opt-planned-1",
		"symbol":          "TSLA251219C00400000",
		"underlying":      "TSLA",
		"qty":             1,
		"side":            "buy",
		"position_intent": "buy_to_open",
		"type":            "limit",
		"limit_price":     1.25,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)

	if ctx.Writer.Status() != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", ctx.Writer.Status(), http.StatusAccepted)
	}
	var response interfaces.OrderResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("response JSON error = %v; body=%s", err, recorder.Body.String())
	}
	if response.Status != "planned_for_next_session" || response.ClientOrderID == "" || response.NextEligibleAt == nil || !response.NextEligibleAt.Equal(nextOpen) {
		t.Fatalf("response = %#v, want planned status, stable client ID, and next open", response)
	}

	var retryPayload map[string]any
	if err := json.Unmarshal(body, &retryPayload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	retryPayload["client_order_id"] = response.ClientOrderID
	planned, err := storage.GetOrderByClientOrderID(response.ClientOrderID)
	if err != nil {
		t.Fatalf("GetOrderByClientOrderID() error = %v", err)
	}
	eligible := time.Now().Add(-time.Minute)
	expires := time.Now().Add(time.Hour)
	planned.NextEligibleAt = &eligible
	planned.ExpiresAt = &expires
	if err := storage.SaveOrder(planned); err != nil {
		t.Fatalf("SaveOrder(eligible retry) error = %v", err)
	}
	retryBody, err := json.Marshal(retryPayload)
	if err != nil {
		t.Fatalf("Marshal(retry) error = %v", err)
	}
	retryRecorder := httptest.NewRecorder()
	retryCtx, _ := gin.CreateTestContext(retryRecorder)
	retryCtx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewReader(retryBody))
	retryCtx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(retryCtx)
	if retryCtx.Writer.Status() != http.StatusAccepted {
		t.Fatalf("retry status = %d, want %d", retryCtx.Writer.Status(), http.StatusAccepted)
	}

	listRecorder := httptest.NewRecorder()
	listCtx, _ := gin.CreateTestContext(listRecorder)
	listCtx.Request = httptest.NewRequest(http.MethodGet, "/api/orders?status=all", nil)
	controller.HandleGetOrders(listCtx)
	if listCtx.Writer.Status() != http.StatusOK {
		t.Fatalf("list status = %d, want %d", listCtx.Writer.Status(), http.StatusOK)
	}
	var visibleResponse struct {
		Orders   []*interfaces.Order `json:"orders"`
		Complete bool                `json:"complete"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &visibleResponse); err != nil {
		t.Fatalf("visible orders JSON error = %v; body=%s", err, listRecorder.Body.String())
	}
	visible := visibleResponse.Orders
	if !visibleResponse.Complete || len(visible) != 1 || visible[0].Status != "planned_for_next_session" || visible[0].ClientOrderID != response.ClientOrderID {
		t.Fatalf("visible orders = %#v, want one durable planned intent", visible)
	}

	plannedOrders, err := storage.GetOrders("planned_for_next_session")
	if err != nil {
		t.Fatalf("GetOrders() error = %v", err)
	}
	if len(plannedOrders) != 1 || plannedOrders[0].AssetClass != "us_option" || plannedOrders[0].Underlying != "TSLA" || plannedOrders[0].PositionIntent != "buy_to_open" || plannedOrders[0].ID != "" {
		t.Fatalf("planned order = %#v, want durable unsubmitted option intent", plannedOrders)
	}
}

func TestPlannedIntentEligibilityWinsAtExactSessionOpen(t *testing.T) {
	now := time.Date(2026, 9, 21, 13, 30, 0, 0, time.UTC)
	expires := now.Add(time.Hour)
	order := &interfaces.Order{Status: "planned_for_next_session", NextEligibleAt: &now, ExpiresAt: &expires}
	controller := &OrderController{}
	eligible, expired := controller.plannedIntentState(order, now)
	if !eligible || expired {
		t.Fatalf("at next eligible boundary: eligible=%v expired=%v; want eligible=true expired=false", eligible, expired)
	}
	stale := now.Add(2 * time.Hour)
	eligible, expired = controller.plannedIntentState(order, stale)
	if eligible || !expired {
		t.Fatalf("after explicit expiry: eligible=%v expired=%v; want eligible=false expired=true", eligible, expired)
	}
}

// ---- F2: Herald target-allocation guard ----

const disContract = "DIS270115C00120000"

type targetGuardService struct {
	*reconciliationTradingService
	mu       sync.Mutex
	identity models.DurableIdentity
	position *interfaces.OptionsPosition
	posErr   error
	orders   []*interfaces.Order
	listErr  error
	calls    int
	admitted []string
	// When true each admitted order is recorded as a working broker order, like a real submission.
	recordWorking bool
}

func (s *targetGuardService) GetOptionsPosition(context.Context, string) (*interfaces.OptionsPosition, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.position, s.posErr
}

func (s *targetGuardService) ListOrders(context.Context, string) ([]*interfaces.Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listErr != nil {
		return nil, s.listErr
	}
	out := make([]*interfaces.Order, len(s.orders))
	copy(out, s.orders)
	return out, nil
}

func (s *targetGuardService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.admitted = append(s.admitted, order.ClientOrderID)
	id := "broker-" + order.ClientOrderID
	if s.recordWorking {
		s.orders = append(s.orders, &interfaces.Order{ID: id, ClientOrderID: order.ClientOrderID, Symbol: order.Symbol, Side: order.Side,
			PositionIntent: order.PositionIntent, Qty: order.Qty, Status: "new", SubmittedAt: time.Now()})
	}
	return &interfaces.OrderResult{
		OrderID: id, Status: "accepted", ClientOrderID: order.ClientOrderID, Symbol: order.Symbol, Side: order.Side, Qty: order.Qty,
		Type: order.Type, TimeInForce: order.TimeInForce, LimitPrice: order.LimitPrice, PositionIntent: order.PositionIntent, Purpose: "close",
		BrokerAccountID: s.identity.BrokerAccountID, PaperLive: s.identity.PaperLive, TenantID: s.identity.TenantID, SandboxID: s.identity.SandboxID,
	}, nil
}

var targetGuardBase = time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)

func tgFill(id, client, side string, qty, filled float64, status string, at time.Time) *interfaces.Order {
	o := &interfaces.Order{ID: id, ClientOrderID: client, Symbol: disContract, Side: side, Qty: qty, FilledQty: filled, Status: status, SubmittedAt: at}
	if filled > 0 {
		f := at.Add(time.Minute)
		o.FilledAt = &f
	}
	return o
}

func newTargetGuard(t *testing.T, positionQty float64, orders ...*interfaces.Order) (*OrderController, *targetGuardService) {
	t.Helper()
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	t.Cleanup(func() { storage.Close() })
	svc := &targetGuardService{
		reconciliationTradingService: &reconciliationTradingService{},
		identity:                     storage.DurableIdentity(),
		position:                     &interfaces.OptionsPosition{BrokerAccountID: "723be98b", Symbol: disContract, Underlying: "DIS", Qty: positionQty, Side: "long"},
		orders:                       orders,
	}
	return NewOrderController(svc, nil, storage), svc
}

func tgOpening(qty float64) *interfaces.Order {
	return tgFill("d86ec4b9-dc49-4a8e-9fbd-17ae923c73ad", "herald-20261124-dis-entry-01", "buy", qty, qty, "filled", targetGuardBase)
}

func tgPost(c *OrderController, clientID string, qty float64) (int, interfaces.OrderResult) {
	body, _ := json.Marshal(map[string]any{
		"client_order_id": clientID, "symbol": disContract, "underlying": "DIS", "qty": qty, "side": "sell",
		"position_intent": "sell_to_close", "type": "limit", "limit_price": 8.7,
	})
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	c.PlaceOptionsOrder(ctx)
	var result interfaces.OrderResult
	_ = json.Unmarshal(recorder.Body.Bytes(), &result)
	return recorder.Code, result
}

func tgRefused(code int, result interfaces.OrderResult, want string) bool {
	return code == http.StatusConflict && result.Status == "risk_blocked" && len(result.FailedCheckCodes) == 1 && result.FailedCheckCodes[0] == want
}

func tgDISOrders() []*interfaces.Order {
	// 24 Nov opening fill 10 @ 5.70; 25 Nov target 73c36318 filled 5 @ 7.40.
	return []*interfaces.Order{
		tgOpening(10),
		tgFill("73c36318-befa-49c7-9b28-126abccbd05c", "herald-20261125-dis-target-1330-01", "sell", 5, 5, "filled", targetGuardBase.Add(24*time.Hour)),
	}
}

func TestTargetGuardRefusesDISReplayWithNoBrokerCallback(t *testing.T) {
	c, svc := newTargetGuard(t, 5, tgDISOrders()...)
	for _, tc := range []struct {
		id  string
		qty float64
	}{{"herald-20261127-dis-target-1020-01", 2}, {"herald-20261127-dis-target-1040-02", 2}, {"herald-20261127-dis-target-1050-03", 3}} {
		code, result := tgPost(c, tc.id, tc.qty)
		if !tgRefused(code, result, "TARGET_ALLOCATION_SPENT") {
			t.Fatalf("%s: status=%d result=%#v, want spent refusal", tc.id, code, result)
		}
		if !strings.Contains(result.Message, "fresh intent") {
			t.Fatalf("refusal message must explain the fresh-intent route: %q", result.Message)
		}
	}
	if svc.calls != 0 {
		t.Fatalf("broker callback count = %d, want 0", svc.calls)
	}
}

func TestTargetGuardAllocationFiveTwoFilledOneReservedPermitsAtMostTwo(t *testing.T) {
	orders := []*interfaces.Order{
		tgOpening(10),
		tgFill("t1", "herald-20261125-dis-target-1330-01", "sell", 2, 2, "filled", targetGuardBase.Add(24*time.Hour)),
		tgFill("t2", "herald-20261125-dis-target-1400-02", "sell", 1, 0, "new", targetGuardBase.Add(25*time.Hour)),
	}
	c, svc := newTargetGuard(t, 8, orders...)
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.EvidenceStatus != "confirmed" || state.AllocatedQty != 5 || state.FilledQty != 2 || state.ReservedQty != 1 || state.AvailableQty != 2 || state.Spent {
		t.Fatalf("state = %#v", state)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-03", 3); !tgRefused(code, result, "TARGET_ALLOCATION_EXCEEDED") {
		t.Fatalf("3 contracts: status=%d result=%#v, want exceeded", code, result)
	}
	if svc.calls != 0 {
		t.Fatalf("calls = %d after refusal, want 0", svc.calls)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-04", 2); code != http.StatusOK {
		t.Fatalf("2 contracts: status=%d result=%#v, want admitted", code, result)
	}
	if svc.calls != 1 {
		t.Fatalf("calls = %d, want 1", svc.calls)
	}
}

func TestTargetGuardTerminalCancelledPartialPermitsOnlyUnfilledRemainder(t *testing.T) {
	orders := []*interfaces.Order{
		tgOpening(10),
		tgFill("t1", "herald-20261125-dis-target-1330-01", "sell", 5, 1, "canceled", targetGuardBase.Add(24*time.Hour)),
	}
	c, svc := newTargetGuard(t, 9, orders...)
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.AllocatedQty != 5 || state.FilledQty != 1 || state.ReservedQty != 0 || state.AvailableQty != 4 || state.Spent {
		t.Fatalf("state = %#v, want allocation 5, filled 1, reserved 0, available 4", state)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-02", 5); !tgRefused(code, result, "TARGET_ALLOCATION_EXCEEDED") {
		t.Fatalf("5 contracts: status=%d result=%#v, want exceeded", code, result)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-03", 4); code != http.StatusOK {
		t.Fatalf("4 contracts: status=%d result=%#v, want admitted", code, result)
	}
	if svc.calls != 1 {
		t.Fatalf("calls = %d, want 1", svc.calls)
	}
}

func TestTargetGuardOverlappingAdmissionsCannotOverAllocate(t *testing.T) {
	c, svc := newTargetGuard(t, 10, tgOpening(10))
	svc.recordWorking = true
	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = tgPost(c, fmt.Sprintf("herald-20261126-dis-target-1000-%02d", i+1), 3)
		}(i)
	}
	wg.Wait()
	if svc.calls != 1 {
		t.Fatalf("admitted = %d (%v), want exactly 1 of four overlapping 3-contract targets against allocation 5", svc.calls, svc.admitted)
	}
	ok := 0
	for _, code := range codes {
		if code == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("HTTP 200 count = %d (codes %v), want 1", ok, codes)
	}
}

func TestTargetGuardUnresolvedCancelKeepsReservation(t *testing.T) {
	orders := []*interfaces.Order{
		tgOpening(10),
		tgFill("t1", "herald-20261125-dis-target-1330-01", "sell", 5, 0, "pending_cancel", targetGuardBase.Add(24*time.Hour)),
	}
	c, svc := newTargetGuard(t, 10, orders...)
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.ReservedQty != 5 || state.AvailableQty != 0 {
		t.Fatalf("state = %#v, want the pending cancel to keep 5 reserved", state)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-02", 1); !tgRefused(code, result, "TARGET_ALLOCATION_EXCEEDED") || svc.calls != 0 {
		t.Fatalf("status=%d result=%#v calls=%d, want refusal with no callback", code, result, svc.calls)
	}
}

func TestTargetGuardDedupesOrdersAndNeverCountsDecisions(t *testing.T) {
	target := tgFill("t1", "herald-20261125-dis-target-1330-01", "sell", 2, 2, "filled", targetGuardBase.Add(24*time.Hour))
	dup := *target
	working := tgFill("t2", "herald-20261125-dis-target-1400-02", "sell", 1, 0, "new", targetGuardBase.Add(25*time.Hour))
	c, _ := newTargetGuard(t, 8, tgOpening(10), target, &dup, working)
	// The same working order also exists as an uncertain local intent; it must not reserve twice.
	if err := c.storageService.SaveOrder(&interfaces.Order{ClientOrderID: working.ClientOrderID, Symbol: disContract, Side: "sell", Qty: 1, Status: "submission_uncertain", SubmittedAt: working.SubmittedAt, SubmissionAttempted: true}); err != nil {
		t.Fatalf("SaveOrder() error = %v", err)
	}
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.FilledQty != 2 || state.ReservedQty != 1 || state.AvailableQty != 2 {
		t.Fatalf("state = %#v, want filled 2 reserved 1 (duplicate broker rows and the local copy counted once)", state)
	}
	// A local-only uncertain intent with no broker record does reserve.
	if err := c.storageService.SaveOrder(&interfaces.Order{ClientOrderID: "herald-20261126-dis-target-1100-05", Symbol: disContract, Side: "sell", Qty: 1, Status: "submission_uncertain", SubmittedAt: targetGuardBase.Add(48 * time.Hour), SubmissionAttempted: true}); err != nil {
		t.Fatalf("SaveOrder() error = %v", err)
	}
	if state = c.computeTargetAllocation(context.Background(), disContract, ""); state.ReservedQty != 2 || state.AvailableQty != 1 {
		t.Fatalf("state = %#v, want the local-only uncertain intent to reserve 1 more", state)
	}
}

func TestTargetGuardReopenedContractGetsNewCycle(t *testing.T) {
	day := 24 * time.Hour
	orders := []*interfaces.Order{
		tgOpening(10),
		tgFill("t1", "herald-20261125-dis-target-1330-01", "sell", 5, 5, "filled", targetGuardBase.Add(day)),
		tgFill("stop1", "herald-20261125-dis-stop-1500-01", "sell", 5, 5, "filled", targetGuardBase.Add(day+2*time.Hour)),
		tgFill("open2", "herald-20261126-dis-entry-02", "buy", 4, 4, "filled", targetGuardBase.Add(2*day)),
	}
	c, svc := newTargetGuard(t, 4, orders...)
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.EvidenceStatus != "confirmed" || state.AllocatedQty != 2 || state.FilledQty != 0 || state.AvailableQty != 2 || state.Spent || !strings.HasSuffix(state.PositionCycle, "/open2") {
		t.Fatalf("state = %#v, want a fresh cycle opened by open2 with allocation 2", state)
	}
	if code, result := tgPost(c, "herald-20261127-dis-target-1020-01", 2); code != http.StatusOK {
		t.Fatalf("status=%d result=%#v, want the new cycle's target admitted", code, result)
	}
	if svc.calls != 1 {
		t.Fatalf("calls = %d, want 1", svc.calls)
	}
}

func TestTargetGuardSingletonAllocatesOneContract(t *testing.T) {
	c, svc := newTargetGuard(t, 1, tgOpening(1))
	state := c.computeTargetAllocation(context.Background(), disContract, "")
	if state.AllocatedQty != 1 || state.AvailableQty != 1 {
		t.Fatalf("state = %#v, want singleton allocation 1", state)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-01", 2); !tgRefused(code, result, "TARGET_ALLOCATION_EXCEEDED") {
		t.Fatalf("status=%d result=%#v, want exceeded for 2 of a singleton", code, result)
	}
	if code, result := tgPost(c, "herald-20261126-dis-target-1000-02", 1); code != http.StatusOK {
		t.Fatalf("status=%d result=%#v, want singleton admitted", code, result)
	}
	if svc.calls != 1 {
		t.Fatalf("calls = %d, want 1", svc.calls)
	}
}

func TestTargetGuardMissingOrAmbiguousEvidenceRefusesTargetsOnly(t *testing.T) {
	cases := map[string]func(*targetGuardService){
		"order history unavailable":          func(s *targetGuardService) { s.listErr = errors.New("history incomplete") },
		"position unreadable":                func(s *targetGuardService) { s.posErr = errors.New("broker down") },
		"history disagrees with position":    func(s *targetGuardService) { s.position.Qty = 7 },
		"opening order still working":        func(s *targetGuardService) { s.orders = append(s.orders, tgFill("b2", "x-entry-2", "buy", 2, 0, "new", targetGuardBase.Add(time.Hour))) },
		"no opening fill in history at all":  func(s *targetGuardService) { s.orders = nil },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c, svc := newTargetGuard(t, 10, tgOpening(10))
			mutate(svc)
			if code, result := tgPost(c, "herald-20261126-dis-target-1000-01", 1); !tgRefused(code, result, "TARGET_ALLOCATION_UNKNOWN") {
				t.Fatalf("target: status=%d result=%#v, want unknown refusal", code, result)
			}
			if svc.calls != 0 {
				t.Fatalf("target reached the broker: calls=%d", svc.calls)
			}
			if code, result := tgPost(c, "herald-20261126-dis-stop-1000-02", 1); code != http.StatusOK {
				t.Fatalf("non-target close: status=%d result=%#v, want it to reach the existing close path", code, result)
			}
			if svc.calls != 1 {
				t.Fatalf("non-target calls = %d, want 1", svc.calls)
			}
		})
	}
}

func TestTargetGuardLegitimateNonTargetClosesStillGoThroughWhenAllocationSpent(t *testing.T) {
	c, svc := newTargetGuard(t, 5, tgDISOrders()...)
	for i, id := range []string{"herald-20261127-dis-stop-1020-01", "herald-20261127-dis-trail-1040-02", "herald-20261127-dis-time-close-1550-03", "herald-20261127-dis-invalidation-1100-04", "herald-20261127-dis-targeted-note-05"} {
		if code, result := tgPost(c, id, 1); code != http.StatusOK {
			t.Fatalf("%s: status=%d result=%#v, want admitted", id, code, result)
		}
		if svc.calls != i+1 {
			t.Fatalf("%s: calls = %d, want %d", id, svc.calls, i+1)
		}
	}
	// Exits carry no AlphaDesk requirement: the mock service has none and no assessment fields are sent.
}

func TestTargetIntentRecognitionRequiresStandaloneTargetTokenOnSingleLegSellToClose(t *testing.T) {
	for id, want := range map[string]bool{
		"herald-20261127-dis-target-1020-01": true, "HERALD-TARGET-1": true, "target": true, "x_target_exit": true,
		"herald-dis-targeted-01": false, "herald-dis-stop-01": false, "retarget-1": false,
	} {
		if got := isTargetIntentClientID(id); got != want {
			t.Fatalf("isTargetIntentClientID(%q) = %v, want %v", id, got, want)
		}
	}
	if isTargetIntentSell(OptionsOrderRequest{ClientOrderID: "a-target-1", Side: "buy", PositionIntent: "buy_to_open"}) {
		t.Fatal("a buy must never be a target-intent sell")
	}
}

func TestOptionsPositionReadExposesTargetAllocation(t *testing.T) {
	c, _ := newTargetGuard(t, 5, tgDISOrders()...)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "symbol", Value: disContract}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/options/position/"+disContract, nil)
	c.GetOptionsPosition(ctx)
	var body struct {
		Symbol           string
		Qty              float64
		TargetAllocation *TargetAllocation `json:"target_allocation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response JSON error = %v; body=%s", err, recorder.Body.String())
	}
	ta := body.TargetAllocation
	if body.Symbol != disContract || body.Qty != 5 || ta == nil || ta.AllocatedQty != 5 || ta.FilledQty != 5 || ta.ReservedQty != 0 || ta.AvailableQty != 0 || !ta.Spent || ta.EvidenceStatus != "confirmed" || !strings.HasSuffix(ta.PositionCycle, "/d86ec4b9-dc49-4a8e-9fbd-17ae923c73ad") {
		t.Fatalf("response = %s", recorder.Body.String())
	}
}
