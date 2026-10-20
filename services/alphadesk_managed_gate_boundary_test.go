package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
)

func managedFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	doc := standaloneClone(data)
	if doc == nil {
		t.Fatal("invalid managed fixture")
	}
	return doc
}

func cloneManagedFixture(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return standaloneClone(b)
}

func TestManagedGateStatesAndBrokerBoundary(t *testing.T) {
	pass3 := managedFixture(t, "managed-review-pass.json")
	locked4 := managedFixture(t, "managed-review-locked.json")
	pass5 := managedFixture(t, "managed-review-pass-r5.json")
	for _, receipt := range []map[string]any{pass3, locked4, pass5} {
		receipt["policy_version"] = receipt["policy_version"].(string) + ":quality:2"
	}
	now, err := time.Parse(time.RFC3339Nano, pass3["observed_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                                                                                             string
		confirmation, gateOn, requireGate, unknown, toggleCache, wrongScope, contradictory, flipAtMarker bool
		wantBroker                                                                                       int
		wantADDecision                                                                                   string
	}{
		{name: "OP2 off AD off reaches broker", wantBroker: 1},
		{name: "OP2 off AD on independently vetoes", gateOn: true, requireGate: true, wantADDecision: "UNAVAILABLE"},
		{name: "OP2 on AD off blocks", confirmation: true, wantADDecision: ""},
		{name: "OP2 on AD on blocks", confirmation: true, gateOn: true, requireGate: true},
		{name: "unknown managed policy fails closed", requireGate: true, unknown: true},
		{name: "cached OFF PASS is revoked ON then fresh OFF revision proceeds", requireGate: true, toggleCache: true, wantBroker: 1},
		{name: "policy scope mismatch blocks", requireGate: true, wrongScope: true},
		{name: "contradictory managed receipt blocks", requireGate: true, contradictory: true},
		{name: "fresh final read catches lock flip before broker callback", requireGate: true, flipAtMarker: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stateOn, stateRevision := tc.gateOn, int64(3)
			if stateOn {
				stateRevision = 4
			}
			assessmentPosts, brokerCalls := 0, 0
			alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					if tc.unknown {
						_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": "legacy", "policy_snapshot": pass3["policy_snapshot"], "minimum_passing_score": pass3["minimum_passing_score"]})
						return
					}
					doc := pass3
					if stateOn {
						doc = locked4
					} else if stateRevision == 5 {
						doc = pass5
					}
					scope := doc["approval_gate"].(map[string]any)["scope"].(map[string]any)
					if tc.wrongScope {
						scope = map[string]any{"workspace_id": "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3", "assessment_key_id": scope["assessment_key_id"]}
					}
					gate := map[string]any{"required": stateOn, "revision": json.Number(strconv.FormatInt(stateRevision, 10)), "scope": scope}
					stateText := "False"
					if stateOn {
						stateText = "True"
					}
					baseVersion := managedPolicyVersionBase(doc["policy_version"].(string))
					_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "contract_version": doc["contract_version"], "assessment_authority": doc["assessment_authority"], "approval_gate": gate, "policy_version": fmt.Sprintf("%s:managed:%d:%s:quality:2", baseVersion, stateRevision, stateText), "policy_snapshot": doc["policy_snapshot"], "minimum_passing_score": doc["minimum_passing_score"]})
					return
				}
				assessmentPosts++
				if tc.unknown {
					_ = json.NewEncoder(w).Encode(standaloneFixtureReceipt(StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: "1.84", ClientReference: stringPtr("op2-managed-fixture")}, now))
					return
				}
				doc := pass3
				if stateOn {
					doc = locked4
				} else if stateRevision == 5 {
					doc = pass5
				}
				if tc.contradictory {
					doc = cloneManagedFixture(t, doc)
					doc["execution_allowed"] = false
				}
				_ = json.NewEncoder(w).Encode(doc)
			}))
			defer alpha.Close()
			broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			price := 1.84
			order := &interfaces.OptionsOrder{ClientOrderID: "op2-managed-fixture", Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
			audits := 0
			order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
				audits++
				if a == nil || !a.ManagedContract || a.ManagedGateRequired || a.ManagedGateRevision != stateRevision {
					t.Errorf("managed assessment audit lost gate binding: %#v", a)
				}
				return nil
			}
			// RequireConfirmation=false here deliberately exercises the Go broker path
			// as though OP2's ordinary confirmation check had been bypassed.
			policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: true, RequireConfirmation: tc.confirmation, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100}
			s := &AlpacaTradingService{client: alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}), clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), policy: policy,
				expectedAccountID: "fixture", expectedPaper: true, expectedTenantID: "fixture", expectedSandboxID: "fixture",
				localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
				alphaDesk:          &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, RequireManagedApprovalGate: tc.requireGate, ExecutionMode: "PAPER_ADVISORY_OP2", URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return now }},
				optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
					return []*interfaces.OptionContract{{Symbol: order.Symbol, Bid: 1.80, Ask: 1.90, BidSize: 10, AskSize: 10, QuoteTimestamp: now.Add(-time.Second), Delta: .5}}, nil
				},
				placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
					brokerCalls++
					return &alpaca.Order{ID: "managed-order", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, PositionIntent: req.PositionIntent, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted"}, nil
				},
			}
			s.SetSubmissionMarker(func(string) error {
				if tc.flipAtMarker {
					stateOn, stateRevision = true, 4
				}
				return nil
			})
			s.SetManagedExecutionBlockCheck(func() bool { return false })
			s.SetOpeningReservationLock(filepath.Join(t.TempDir(), "managed-reservation.lock"))
			if tc.toggleCache {
				if err := s.requirePaperAdvisoryQualification(context.Background(), order); err != nil {
					t.Fatalf("initial OFF qualification: %v", err)
				}
				stateOn, stateRevision = true, 4
				if err := s.validatePaperAdvisoryAtSubmission(context.Background(), order); err == nil {
					t.Fatal("OFF receipt survived OFF->ON")
				}
				_, err := s.PlaceOptionsOrder(context.Background(), order)
				if err == nil || brokerCalls != 0 {
					t.Fatalf("cached PASS crossed ON lock: err=%v callbacks=%d", err, brokerCalls)
				}
				stateOn, stateRevision = false, 5
				err = s.validatePaperAdvisoryAtSubmission(context.Background(), order)
				var stale *AlphaDeskUnavailableError
				if !errors.As(err, &stale) || stale.Category == "managed_review_required" || strings.Contains(stale.Error(), "human-review lock is ON") {
					t.Fatal("pre-lock receipt revived after ON->OFF")
				}
				_, err = s.PlaceOptionsOrder(context.Background(), order)
				if err != nil || brokerCalls != 1 || assessmentPosts != 2 {
					t.Fatalf("fresh revision did not qualify: err=%v callbacks=%d posts=%d", err, brokerCalls, assessmentPosts)
				}
				return
			}
			_, callErr := s.PlaceOptionsOrder(context.Background(), order)
			if brokerCalls != tc.wantBroker {
				t.Fatalf("broker callbacks=%d want %d err=%v", brokerCalls, tc.wantBroker, callErr)
			}
			if tc.wantBroker == 1 && callErr != nil {
				t.Fatalf("fresh managed PASS rejected: %v", callErr)
			}
			if tc.gateOn && tc.wantADDecision == "UNAVAILABLE" {
				var unavailable *AlphaDeskUnavailableError
				if !errors.As(callErr, &unavailable) || unavailable.Decision != "UNAVAILABLE" || !strings.Contains(unavailable.Error(), "human-review lock is ON") {
					t.Fatalf("AD lock did not surface explicit UNAVAILABLE: %v", callErr)
				}
			}
			if tc.confirmation && (callErr == nil || !strings.Contains(callErr.Error(), "operator confirmation")) {
				t.Fatalf("OP2 confirmation did not block: %v", callErr)
			}
			if tc.unknown && (callErr == nil || brokerCalls != 0) {
				t.Fatalf("unknown managed policy did not fail closed: %v", callErr)
			}
			if (tc.wrongScope || tc.contradictory || tc.flipAtMarker) && (callErr == nil || brokerCalls != 0) {
				t.Fatalf("managed policy/receipt inconsistency crossed broker boundary: err=%v callbacks=%d", callErr, brokerCalls)
			}
			if tc.gateOn && !tc.confirmation && assessmentPosts != 1 {
				t.Fatalf("expected AD's locked UNAVAILABLE attempt, got %d posts", assessmentPosts)
			}
		})
	}
}

func stringPtr(value string) *string { return &value }
