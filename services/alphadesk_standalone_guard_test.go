package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStandaloneReceiptsSingleFlightSeparateAccountsAndPolicyChanges(t *testing.T) {
	now := time.Now().UTC()
	var posts atomic.Int32
	minimum := "65"
	p := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			snapshot, version := standaloneFixturePolicyAt(minimum)
			json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": minimum})
			return
		}
		posts.Add(1)
		time.Sleep(10 * time.Millisecond)
		var echo StandaloneTradeProposal
		json.NewDecoder(r.Body).Decode(&echo)
		json.NewEncoder(w).Encode(standaloneFixtureReceiptAt(echo, now, minimum))
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
	p.Quantity = 2
	if _, err := c.cachedStandalone(context.Background(), l1, p, false); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 4 {
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
