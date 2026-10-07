package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
)

func TestStandaloneReviewFinalFreshnessAndPolicy(t *testing.T) {
	for _, scenario := range []string{"policy_during_fresh_post", "policy_during_audit", "expires_during_policy", "expires_during_audit", "cancel_during_audit", "trade_changes_during_audit", "account_changes_during_audit", "audit_mutates_record"} {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now().UTC()
			initial := now
			minimum := "65"
			p := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					if scenario == "expires_during_policy" {
						now = initial.Add(2 * time.Minute)
					}
					if scenario == "policy_during_fresh_post" {
						minimum = "66"
					}
					snapshot, version := standaloneFixturePolicyAt(minimum)
					json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": minimum})
					return
				}
				var echo StandaloneTradeProposal
				json.NewDecoder(r.Body).Decode(&echo)
				json.NewEncoder(w).Encode(standaloneFixtureReceipt(echo, initial))
			}))
			defer server.Close()
			c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-only", HTTP: server.Client(), Now: func() time.Time { return now }}
			identity := models.DurableIdentity{BrokerAccountID: "fixture", TenantID: "fixture", SandboxID: "fixture", PaperLive: "paper"}
			if scenario == "policy_during_fresh_post" {
				if _, err := c.cachedStandalone(context.Background(), identity, p, true); err == nil {
					t.Fatal("old-policy fresh PASS accepted")
				}
				return
			}
			if scenario == "expires_during_policy" {
				if _, err := c.cachedStandalone(context.Background(), identity, p, false); err != nil {
					t.Fatal(err)
				}
				if _, err := c.cachedStandalone(context.Background(), identity, p, true); err == nil {
					t.Fatal("expired cached PASS accepted")
				}
				return
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var s *AlpacaTradingService
			price := 2.0
			order := &interfaces.OptionsOrder{Symbol: p.Legs[0].Symbol, Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price}
			order.AssessmentAuditSink = func(record *interfaces.AlphaDeskAssessment) error {
				if scenario == "expires_during_audit" {
					now = initial.Add(2 * time.Minute)
				} else if scenario == "policy_during_audit" {
					minimum = "66"
				} else if scenario == "trade_changes_during_audit" {
					order.Qty = 2
				} else if scenario == "account_changes_during_audit" {
					s.expectedAccountID = "changed-account"
				} else if scenario == "audit_mutates_record" {
					record.Decision = "FAIL"
					if evidence, ok := record.Evidence.(map[string]any); ok {
						evidence["decision"] = "FAIL"
					}
				} else {
					cancel()
				}
				return nil
			}
			s = &AlpacaTradingService{expectedPaper: true, expectedAccountID: "fixture", expectedTenantID: "fixture", expectedSandboxID: "fixture", policy: &TradingPolicy{}, alphaDesk: c}
			if err := s.requireStandaloneApproval(ctx, order); scenario == "audit_mutates_record" {
				if err == nil || order.AlphaDeskAssessment != nil {
					t.Fatalf("paper advisory crossed the order guard before audit: err=%v assessment=%#v", err, order.AlphaDeskAssessment)
				}
				return
			} else if err == nil {
				t.Fatal("expired/canceled PASS crossed final audit boundary")
			}
			if order.AlphaDeskAssessment != nil {
				t.Fatal("rejected receipt attached as approval")
			}
		})
	}
}

func TestStandaloneWaitingCallerCanCancel(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		json.NewEncoder(w).Encode(map[string]any{"decision": "UNAVAILABLE", "execution_allowed": false})
	}))
	defer server.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-only", HTTP: server.Client()}
	identity := models.DurableIdentity{BrokerAccountID: "fixture", TenantID: "fixture", SandboxID: "fixture", PaperLive: "paper"}
	p := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	ownerDone := make(chan struct{})
	go func() { defer close(ownerDone); c.cachedStandalone(context.Background(), identity, p, false) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.cachedStandalone(ctx, identity, p, false); done <- err }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("canceled waiter succeeded")
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("canceled waiter blocked behind owner")
	}
	close(release)
	<-ownerDone
}

func TestStandaloneAdvisoryDeniedBeforeAuditAndBrokerSubmission(t *testing.T) {
	now := time.Now().UTC()
	minimum := "65"
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			snapshot, version := standaloneFixturePolicyAt(minimum)
			_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": minimum})
			return
		}
		var proposal StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&proposal); err != nil {
			t.Errorf("decode proposal: %v", err)
		}
		_ = json.NewEncoder(w).Encode(standaloneFixtureReceipt(proposal, now))
	}))
	defer alpha.Close()
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account":
			_, _ = w.Write([]byte(`{"id":"paper-account","equity":"10000","last_equity":"10000","cash":"10000","portfolio_value":"10000","buying_power":"10000","daytrade_count":0}`))
		case "/v2/positions", "/v2/orders":
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer broker.Close()
	brokerMutations := 0
	auditCalls := 0
	policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: true, RequireConfirmation: false, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100}
	service := &AlpacaTradingService{
		client:      alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}),
		clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), policy: policy,
		expectedAccountID: "paper-account", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox",
		localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
		placeOrderFn:       func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) { brokerMutations++; return nil, nil },
		alphaDesk:          &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, ExecutionMode: "STANDALONE_OP2", URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return now }},
		submissionMarker:   func(string) error { return nil },
	}
	service.SetOpeningReservationLock(filepath.Join(t.TempDir(), "reservation.lock"))
	price := 2.0
	order := &interfaces.OptionsOrder{ClientOrderID: "standalone-final-gate", Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
		auditCalls++
		if a.Decision != "PASS" || a.ExecutionAllowed {
			t.Errorf("audit must record only a framework receipt: %#v", a)
		}
		return nil
	}
	if _, err := service.PlaceOptionsOrder(context.Background(), order); err == nil {
		t.Fatal("policy changed during audit was accepted")
	}
	if auditCalls != 0 || brokerMutations != 0 || order.AlphaDeskAssessment != nil {
		t.Fatalf("audit=%d broker_mutations=%d attached=%#v", auditCalls, brokerMutations, order.AlphaDeskAssessment)
	}
}
