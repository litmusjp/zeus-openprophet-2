package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStandaloneReceiptsSingleFlightSeparateAccountsAndPolicyChanges(t *testing.T) {
	now := time.Now().UTC()
	var posts atomic.Int32
	minimum := "65"
	qualityRevision := 1
	p := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			snapshot, version := standaloneFixturePolicyAt(minimum)
			version += fmt.Sprintf(":quality:%d", qualityRevision)
			json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": minimum})
			return
		}
		posts.Add(1)
		time.Sleep(10 * time.Millisecond)
		var echo StandaloneTradeProposal
		json.NewDecoder(r.Body).Decode(&echo)
		receipt := standaloneFixtureReceiptAt(echo, now, minimum)
		_, receiptVersion := standaloneFixturePolicyAt(minimum)
		receipt["policy_version"] = fmt.Sprintf("%s:quality:%d", receiptVersion, qualityRevision)
		json.NewEncoder(w).Encode(receipt)
	}))
	defer server.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-only", HTTP: server.Client(), Now: func() time.Time { return now }}
	l1 := models.DurableIdentity{BrokerAccountID: "paper-one", SandboxID: "l1", TenantID: "one", PaperLive: "paper"}
	l2 := models.DurableIdentity{BrokerAccountID: "paper-two", SandboxID: "l2", TenantID: "two", PaperLive: "paper"}
	var group sync.WaitGroup
	for i := 0; i < 10; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			doc, err := c.cachedStandalone(context.Background(), l1, p, false)
			if err != nil || doc["decision"] != "PASS" {
				t.Errorf("%v %#v", err, doc)
			}
		}()
	}
	group.Wait()
	if posts.Load() != 1 {
		t.Fatalf("duplicate assessments: %d", posts.Load())
	}
	doc, err := c.cachedStandalone(context.Background(), l1, p, true)
	if err != nil {
		t.Fatal(err)
	}
	doc["decision"] = "forged"
	again, err := c.cachedStandalone(context.Background(), l1, p, false)
	if err != nil || again["decision"] != "PASS" {
		t.Fatal("mutable return poisoned cache")
	}
	if _, err := c.cachedStandalone(context.Background(), l2, p, false); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Fatal("cross-account reuse")
	}
	minimum = "66"
	if _, err := c.cachedStandalone(context.Background(), l1, p, true); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 3 {
		t.Fatal("policy change did not reassess")
	}
	qualityRevision++
	if _, err := c.cachedStandalone(context.Background(), l1, p, true); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 4 {
		t.Fatal("quality policy version change reused an old PASS")
	}
	p.Quantity = 2
	if _, err := c.cachedStandalone(context.Background(), l1, p, false); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 5 {
		t.Fatal("changed proposal reused receipt")
	}
	if len(c.standaloneLocks) != 0 {
		t.Fatal("single-flight lock leak")
	}
}

func TestStandaloneFinalGuardRequiresPaperPolicyAndDurableAudit(t *testing.T) {
	price := 2.0
	order := &interfaces.OptionsOrder{Symbol: "AAPL261106C00200000", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price}
	for _, s := range []*AlpacaTradingService{
		{}, {expectedPaper: false, policy: &TradingPolicy{}, alphaDesk: &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true}},
		{expectedPaper: true, alphaDesk: &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true}},
		{expectedPaper: true, policy: &TradingPolicy{}, alphaDesk: &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true}},
	} {
		if err := s.requireStandaloneApproval(context.Background(), order); err == nil {
			t.Fatal("missing final prerequisites accepted")
		}
	}
}

func TestPaperAdvisoryPASSCannotCrossDormantOrderOpeningGuard(t *testing.T) {
	now := time.Now().UTC()
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			snapshot, version := standaloneFixturePolicy()
			json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": "65"})
			return
		}
		var echoed StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&echoed); err != nil {
			t.Error(err)
			return
		}
		json.NewEncoder(w).Encode(standaloneFixtureReceipt(echoed, now))
	}))
	defer server.Close()
	client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-only", HTTP: server.Client(), Now: func() time.Time { return now }}
	price := 2.0
	audits := 0
	order := &interfaces.OptionsOrder{Symbol: proposal.Legs[0].Symbol, Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price,
		AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { audits++; return nil }}
	service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: "paper-fixture", expectedTenantID: "tenant-fixture", expectedSandboxID: "sandbox-fixture", policy: &TradingPolicy{}, alphaDesk: client}
	if err := service.requireStandaloneApproval(context.Background(), order); err == nil {
		t.Fatal("paper advisory PASS authorized an opening")
	}
	if audits != 0 || order.AlphaDeskAssessment != nil {
		t.Fatalf("advisory reached order audit/attachment: audits=%d assessment=%#v", audits, order.AlphaDeskAssessment)
	}
}

func TestFutureMarketTimesBlockRealOpeningGuard(t *testing.T) {
	for _, futureField := range []string{"evidence_observed_at", "market_data.greeks_calculated_at"} {
		t.Run(futureField, func(t *testing.T) {
			now := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)
			proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					snapshot, version := standaloneFixturePolicy()
					_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": "65"})
					return
				}
				var echoed StandaloneTradeProposal
				if err := json.NewDecoder(r.Body).Decode(&echoed); err != nil {
					t.Error(err)
					return
				}
				doc := standaloneFixtureReceiptAt(echoed, now, "65")
				doc["observed_at"] = now.Add(2 * time.Millisecond)
				if futureField == "evidence_observed_at" {
					doc["evidence_observed_at"] = now.Add(time.Millisecond)
					doc["evidence_as_of"] = now.Add(time.Millisecond)
				} else {
					market := doc["market_data"].(map[string]any)
					market["greeks_calculated_at"] = now.Add(time.Millisecond)
				}
				_ = json.NewEncoder(w).Encode(doc)
			}))
			defer server.Close()
			client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture", HTTP: server.Client(), Now: func() time.Time { return now }}
			price := 2.0
			audits := 0
			order := &interfaces.OptionsOrder{Symbol: proposal.Legs[0].Symbol, Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price, AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { audits++; return nil }}
			service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: "paper", expectedTenantID: "tenant", expectedSandboxID: "sandbox", policy: &TradingPolicy{}, alphaDesk: client}
			err := service.requireStandaloneApproval(context.Background(), order)
			var unavailable *AlphaDeskUnavailableError
			wantStage := futureField
			if futureField == "evidence_observed_at" {
				wantStage = "evidence_observed_at"
			}
			if !errors.As(err, &unavailable) || unavailable.Stage != wantStage || audits != 0 || order.AlphaDeskAssessment != nil || len(client.standaloneCache) != 0 {
				t.Fatalf("future market timestamp crossed opening guard: err=%v audits=%d assessment=%#v cache=%d", err, audits, order.AlphaDeskAssessment, len(client.standaloneCache))
			}
		})
	}
}

func TestBoundedSkewCachedPASSPreservesReceiptAndOpeningAudit(t *testing.T) {
	now := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)
	proposalRef := "op2-receipt-wire-format"
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("1.84"), ClientReference: &proposalRef}
	golden, err := os.ReadFile("testdata/op2-pass-receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	if err := json.Unmarshal(golden, &receipt); err != nil {
		t.Fatal(err)
	}
	evidenceAt := now.Add(-10 * time.Second)
	receipt["observed_at"] = now.Add(2 * time.Millisecond).Format(time.RFC3339Nano)
	receipt["evidence_observed_at"] = evidenceAt.Format(time.RFC3339Nano)
	receipt["evidence_as_of"] = evidenceAt.Format(time.RFC3339Nano)
	receipt["expires_at"] = now.Add(240 * time.Second).Format(time.RFC3339Nano)
	market := receipt["market_data"].(map[string]any)
	market["source_quote_times"].(map[string]any)[proposal.Legs[0].Symbol] = now.Add(-time.Second).Format(time.RFC3339Nano)
	snapshot := receipt["policy_snapshot"].(map[string]any)
	snapshot["execution_max_quote_age_seconds"] = 300
	bound := map[string]any{"workspace_policy": snapshot, "profile": "paper_advisory_greeks_v1", "paper_only": true, "require_greek_values": true, "unknown_greek_calculation_time": "warning"}
	policyBytes, err := json.Marshal(bound)
	if err != nil {
		t.Fatal(err)
	}
	policyHash := sha256.Sum256(policyBytes)
	baseVersion := "standalone-paper-advisory-v1:" + hex.EncodeToString(policyHash[:])
	policyVersion := baseVersion + ":managed:9:False:quality:2"
	receipt["policy_version"] = policyVersion
	receipt["contract_version"] = "managed-assessment-v1"
	receipt["assessment_authority"] = "assessment_only"
	delete(receipt, "execution_allowed")
	delete(receipt, "human_approval_required")
	receipt["approval_gate"] = map[string]any{"required": false, "revision": json.Number("9"), "scope": map[string]any{
		"workspace_id": "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", "assessment_key_id": "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2"}}
	body, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	posts, gets := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			gets++
			_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "contract_version": "managed-assessment-v1", "assessment_authority": "assessment_only", "approval_gate": receipt["approval_gate"], "policy_version": policyVersion, "policy_snapshot": snapshot, "minimum_passing_score": receipt["minimum_passing_score"]})
			return
		}
		posts++
		_, _ = w.Write(body)
	}))
	defer server.Close()
	client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
	identity := models.DurableIdentity{BrokerAccountID: "paper", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	cached, err := client.cachedStandalone(context.Background(), identity, proposal, true)
	if err != nil {
		t.Fatalf("cached standalone PASS rejected: %#v (%v)", err, err)
	}
	effectiveDeadline := evidenceAt.Add(brokerQuoteMaxAge)
	cacheEntry := client.standaloneCache[standaloneKey(identity, proposal)]
	if !cacheEntry.expires.Equal(effectiveDeadline) {
		t.Fatalf("cache expiry=%v, want existing OP2 evidence deadline %v", cacheEntry.expires, effectiveDeadline)
	}
	observed, _ := time.Parse(time.RFC3339Nano, cached["observed_at"].(string))
	expiry, _ := time.Parse(time.RFC3339Nano, cached["expires_at"].(string))
	effective, parseErr := time.Parse(time.RFC3339Nano, cached["op2_effective_expires_at"].(string))
	if parseErr != nil || !observed.Equal(now.Add(2*time.Millisecond)) || !expiry.Equal(now.Add(240*time.Second)) || !effective.Equal(effectiveDeadline) || cached["trade_fingerprint"] != standaloneProposalFingerprint(proposal) {
		t.Fatalf("cached receipt timestamps/identity changed: observed=%v expiry=%v effective=%v err=%v", observed, expiry, effective, parseErr)
	}
	echo := cached["trade"].(map[string]any)
	if echo["client_reference"] != proposalRef {
		t.Fatalf("cached trade/client identity changed: %#v", echo)
	}
	price := 1.84
	audits := 0
	var audited *interfaces.AlphaDeskAssessment
	order := &interfaces.OptionsOrder{Symbol: proposal.Legs[0].Symbol, Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price, ClientOrderID: proposalRef,
		AssessmentAuditSink: func(value *interfaces.AlphaDeskAssessment) error { audits++; audited = value; return nil }}
	service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: identity.BrokerAccountID, expectedTenantID: identity.TenantID, expectedSandboxID: identity.SandboxID, policy: &TradingPolicy{}, alphaDesk: client}
	if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil {
		t.Fatalf("cached bounded-skew receipt failed opening guard: %v", err)
	}
	if posts != 1 || gets != 3 || audits != 1 || order.AlphaDeskAssessment == nil || audited == nil {
		t.Fatalf("cache/recheck/audit path counts: POST=%d GET=%d audits=%d attached=%t", posts, gets, audits, order.AlphaDeskAssessment != nil)
	}
	auditEvidence := audited.Evidence.(map[string]any)
	auditedObserved, _ := time.Parse(time.RFC3339Nano, auditEvidence["observed_at"].(string))
	auditedExpiry, _ := time.Parse(time.RFC3339Nano, auditEvidence["expires_at"].(string))
	if !auditedObserved.Equal(now.Add(2*time.Millisecond)) || !auditedExpiry.Equal(now.Add(240*time.Second)) || !audited.OP2EffectiveExpiresAt.Equal(effectiveDeadline) || auditEvidence["trade"].(map[string]any)["client_reference"] != proposalRef {
		t.Fatalf("opening audit lost original timestamps, effective deadline, or trade identity: %#v", audited)
	}
	now = effectiveDeadline.Add(time.Nanosecond)
	if err := client.standaloneFresh(context.Background(), auditEvidence); err == nil {
		t.Fatal("receipt remained fresh at its existing OP2 evidence deadline")
	} else {
		var unavailable *AlphaDeskUnavailableError
		if !errors.As(err, &unavailable) || unavailable.Stage != "evidence_observed_at" {
			t.Fatalf("deadline rejected at wrong stage: %v", err)
		}
	}
	if posts != 1 {
		t.Fatalf("valid cache reuse caused another assessment POST: %d", posts)
	}
}

func TestAssessmentFailureDiagnosticsAreWhitelistedAndPreserved(t *testing.T) {
	retryable := false
	doc := map[string]any{
		"decision": "FAIL", "assessment_id": "888c17f7-e4af-408f-a8bb-50109488f262", "policy_version": "standalone-paper-advisory-v1:abc123:quality:2",
		"retryable": retryable, "failed_check_codes": []any{"minimum_catalyst_confidence", "bad\nsecret"},
		"expires_at": "2026-10-06T15:02:00Z", "evidence_observed_at": "2026-10-06T15:00:00Z", "blocking_reasons": []any{"minimum_catalyst_confidence", "bad\nsecret"},
		"checks": []any{map[string]any{"code": "minimum_catalyst_confidence", "passed": false, "actual": json.Number("0.12"), "threshold": "0.15", "message": "secret upstream body"}, map[string]any{"code": "leg_liquidity", "actual": map[string]any{"open_interest": 1000, "api_key": "secret"}, "threshold": map[string]any{"open_interest": 25}}, map[string]any{"code": "private token", "actual": map[string]any{"secret": "x"}}},
	}
	result := &AlphaDeskUnavailableError{Decision: "FAIL", Category: "assessment_rejected", Stage: "decision"}
	addAssessmentReceiptDiagnostics(result, doc)
	if result.Decision != "FAIL" || len(result.FailedCheckCodes) != 1 || result.FailedCheckCodes[0] != "minimum_catalyst_confidence" || result.AssessmentID == "" || result.PolicyVersion == "" || result.Retryable == nil || *result.Retryable || result.ExpiresAt.IsZero() || result.EvidenceObservedAt.IsZero() || len(result.BlockingReasons) != 1 {
		t.Fatalf("failure receipt fields lost or invalid: %#v", result)
	}
	if len(result.AssessmentChecks) != 2 || result.AssessmentChecks[0].Actual != json.Number("0.12") || result.AssessmentChecks[0].Threshold != "0.15" || result.AssessmentChecks[0].Passed == nil || *result.AssessmentChecks[0].Passed {
		t.Fatalf("safe actual/required diagnostics missing: %#v", result.AssessmentChecks)
	}
	liquidityActual := result.AssessmentChecks[1].Actual.(map[string]any)
	if liquidityActual["open_interest"] != 1000 || liquidityActual["api_key"] != nil {
		t.Fatalf("unsafe nested actual was not filtered: %#v", liquidityActual)
	}
	serialized, _ := json.Marshal(result)
	if strings.Contains(string(serialized), "secret upstream body") || strings.Contains(string(serialized), "bad\\nsecret") || strings.Contains(string(serialized), "private token") {
		t.Fatalf("unsafe upstream values leaked: %s", serialized)
	}
}
