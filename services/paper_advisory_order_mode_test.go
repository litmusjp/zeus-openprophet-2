package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
)

func TestPaperAdvisoryModePassReachesBrokerThroughFinalOrderBoundary(t *testing.T) {
	now := time.Now().UTC()
	minimum := "65"
	alphaCalls, legacyCalls, brokerCalls, auditCalls := 0, 0, 0, 0
	brokerPositions := `[]`
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			snapshot, version := standaloneFixturePolicyAt(minimum)
			_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": minimum})
			return
		}
		if r.URL.Path != "/api/v2/option-trade-assessments" {
			legacyCalls++
			http.NotFound(w, r)
			return
		}
		alphaCalls++
		var proposal StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&proposal); err != nil {
			t.Errorf("decode proposal: %v", err)
			return
		}
		_ = json.NewEncoder(w).Encode(standaloneFixtureReceipt(proposal, now))
	}))
	defer alpha.Close()
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account":
			_, _ = w.Write([]byte(`{"id":"fixture","equity":"10000","last_equity":"10000","cash":"10000","portfolio_value":"10000","buying_power":"10000","daytrade_count":0}`))
		case "/v2/positions":
			_, _ = w.Write([]byte(brokerPositions))
		case "/v2/orders":
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer broker.Close()
	policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: true, RequireConfirmation: false, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100}
	s := &AlpacaTradingService{client: alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}), clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), policy: policy,
		expectedAccountID: "fixture", expectedPaper: true, expectedTenantID: "fixture", expectedSandboxID: "fixture",
		localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
		alphaDesk:          &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, ExecutionMode: "PAPER_ADVISORY_OP2", URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return now }},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			brokerCalls++
			return &alpaca.Order{ID: "paper-order", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, PositionIntent: req.PositionIntent, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted"}, nil
		},
	}
	s.SetSubmissionMarker(func(string) error { return nil })
	s.SetManagedExecutionBlockCheck(func() bool { return false })
	s.SetOpeningReservationLock(filepath.Join(t.TempDir(), "reservation.lock"))
	price := 2.0
	order := &interfaces.OptionsOrder{ClientOrderID: "paper-advisory-test", Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 2, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
		auditCalls++
		if a == nil || a.ExecutionAllowed || !a.HumanApprovalRequired || a.Scope != "TRADE_ASSESSMENT" {
			t.Errorf("audit must preserve assessment-only metadata: %#v", a)
		}
		return nil
	}
	if _, err := s.PlaceOptionsOrder(context.Background(), order); err != nil {
		t.Fatalf("PlaceOptionsOrder rejected advisory PASS: %v", err)
	}
	if alphaCalls != 1 || legacyCalls != 0 || auditCalls != 1 || brokerCalls != 1 {
		t.Fatalf("standalone=%d legacy=%d audit=%d broker=%d; want 1/0/1/1", alphaCalls, legacyCalls, auditCalls, brokerCalls)
	}
	// Simulate broker reconciliation independently from the accepted opening
	// acknowledgement, then route a close for the exact remaining quantity.
	brokerPositions = `[{"symbol":"AAPL261106C00200000","qty":"1","avg_entry_price":"2","market_value":"100","cost_basis":"100","unrealized_pl":"0","unrealized_plpc":"0","current_price":"2","side":"long","asset_class":"us_option"}]`
	position, err := s.GetOptionsPosition(context.Background(), order.Symbol)
	if err != nil || position == nil || position.Qty != 1 || position.Symbol != order.Symbol {
		t.Fatalf("broker options position=%#v err=%v; want exact OCC symbol and 1 remaining", position, err)
	}
	closePrice := 1.9
	closeOrder := &interfaces.OptionsOrder{ClientOrderID: "paper-advisory-close", Symbol: order.Symbol, Underlying: order.Underlying, Qty: position.Qty, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &closePrice}
	if _, err := s.PlaceOptionsOrder(context.Background(), closeOrder); err != nil {
		t.Fatalf("PlaceOptionsOrder rejected existing long option reduction: %v", err)
	}
	if alphaCalls != 1 || brokerCalls != 2 {
		t.Fatalf("after close: standalone=%d broker=%d; want assessment only for entry and two broker routes", alphaCalls, brokerCalls)
	}
	// The accepted close is not proof of closure; broker-zero reconciliation is.
	position, err = s.GetOptionsPosition(context.Background(), order.Symbol)
	if err != nil || position == nil || position.Qty != 1 {
		t.Fatalf("close acknowledgement incorrectly implied closure: position=%#v err=%v", position, err)
	}
	brokerPositions = `[]`
	position, err = s.GetOptionsPosition(context.Background(), order.Symbol)
	if err == nil || position != nil || !strings.Contains(err.Error(), "options position not found") {
		t.Fatalf("broker-zero reconciliation position=%#v err=%v; want broker-confirmed position not found", position, err)
	}
}

type paperAdvisoryTestClock struct {
	open   bool
	onRead func()
}

func (c *paperAdvisoryTestClock) GetClock() (*alpaca.Clock, error) {
	if c.onRead != nil {
		c.onRead()
	}
	return &alpaca.Clock{IsOpen: c.open}, nil
}

func TestPaperAdvisoryModeRejectsUnsafeFinalBoundaryCases(t *testing.T) {
	for _, scenario := range []string{"fail", "unavailable", "mismatched_receipt", "live", "disabled", "audit_failure", "canceled_audit", "changed_proposal", "session_closed_during_audit", "blocked_reconciliation", "cancel_during_marker", "expire_during_marker", "proposal_change_during_marker", "cancel_during_final_clock", "expire_during_final_clock", "proposal_change_during_final_clock", "managed_blocked", "managed_unknown"} {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now().UTC()
			assessmentNow := now
			clockReads := 0
			var order *interfaces.OptionsOrder
			var cancel context.CancelFunc = func() {}
			clock := &paperAdvisoryTestClock{open: true}
			clock.onRead = func() {
				clockReads++
				if clockReads == 2 {
					switch scenario {
					case "cancel_during_final_clock":
						cancel()
					case "expire_during_final_clock":
						assessmentNow = now.Add(2 * time.Minute)
					case "proposal_change_during_final_clock":
						order.Qty = 2
					}
				}
			}
			alphaCalls, brokerCalls := 0, 0
			alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					snapshot, version := standaloneFixturePolicyAt("65")
					_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": "65"})
					return
				}
				alphaCalls++
				var proposal StandaloneTradeProposal
				_ = json.NewDecoder(r.Body).Decode(&proposal)
				receipt := standaloneFixtureReceipt(proposal, now)
				switch scenario {
				case "fail":
					receipt["decision"] = "FAIL"
				case "unavailable":
					receipt["decision"] = "UNAVAILABLE"
				case "mismatched_receipt":
					receipt["trade"] = map[string]any{"legs": []any{}, "quantity": 2, "limit_price": "2"}
				}
				_ = json.NewEncoder(w).Encode(receipt)
			}))
			defer alpha.Close()
			broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v2/account":
					_, _ = w.Write([]byte(`{"id":"fixture","equity":"10000","last_equity":"10000","cash":"10000","portfolio_value":"10000","buying_power":"10000","daytrade_count":0}`))
				case "/v2/positions", "/v2/orders":
					_, _ = w.Write([]byte(`[]`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer broker.Close()
			policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: true, RequireConfirmation: false, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100}
			paper := scenario != "live"
			enabled := scenario != "disabled"
			s := &AlpacaTradingService{client: alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}), clockReader: clock, logger: logrus.New(), policy: policy,
				expectedAccountID: "fixture", expectedPaper: paper, expectedTenantID: "fixture", expectedSandboxID: "fixture",
				localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
				alphaDesk:          &AlphaDeskClient{Enabled: enabled, SignalQualityEnabled: true, ExecutionMode: "PAPER_ADVISORY_OP2", URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return assessmentNow }},
				placeOrderFn:       func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) { brokerCalls++; return nil, nil },
			}
			s.SetOpeningReservationLock(filepath.Join(t.TempDir(), "reservation.lock"))
			if scenario == "blocked_reconciliation" {
				s.executionBlocked = true
			}
			if scenario == "managed_blocked" {
				manager := &PositionManager{positions: map[string]*ManagedPosition{"unresolved": {Status: "PROTECTION_BLOCKED"}}}
				s.SetManagedExecutionBlockCheck(manager.ExecutionBlocked)
			} else if scenario != "managed_unknown" {
				s.SetManagedExecutionBlockCheck(func() bool { return false })
			}
			price := 2.0
			order = &interfaces.OptionsOrder{ClientOrderID: "paper-advisory-negative", Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
			ctx := context.Background()
			if scenario == "canceled_audit" || scenario == "cancel_during_marker" || scenario == "cancel_during_final_clock" {
				ctx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			order.AssessmentAuditSink = func(*interfaces.AlphaDeskAssessment) error {
				switch scenario {
				case "audit_failure":
					return context.DeadlineExceeded
				case "canceled_audit":
					cancel()
				case "changed_proposal":
					order.Qty = 2
				case "session_closed_during_audit":
					clock.open = false
				}
				return nil
			}
			s.SetSubmissionMarker(func(string) error {
				switch scenario {
				case "cancel_during_marker":
					cancel()
				case "expire_during_marker":
					assessmentNow = now.Add(2 * time.Minute)
				case "proposal_change_during_marker":
					order.Qty = 2
				}
				return nil
			})
			_, err := s.PlaceOptionsOrder(ctx, order)
			if err == nil || brokerCalls != 0 {
				t.Fatalf("err=%v broker calls=%d; expected fail-closed with no broker submission", err, brokerCalls)
			}
			if strings.Contains(scenario, "marker") || strings.Contains(scenario, "final_clock") || scenario == "managed_blocked" || scenario == "managed_unknown" {
				if order.AlphaDeskAssessment != nil || order.SubmissionAttempted {
					t.Fatalf("pre-submit failure retained assessment/attempt marker: assessment=%#v attempted=%v", order.AlphaDeskAssessment, order.SubmissionAttempted)
				}
			}
			if scenario == "fail" || scenario == "unavailable" || scenario == "mismatched_receipt" {
				if alphaCalls != 1 {
					t.Fatalf("standalone assessment calls=%d, want 1", alphaCalls)
				}
			}
		})
	}
}
