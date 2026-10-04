package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
)

func TestSignalQualityOP2FinalBrokerBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, mode, decision                                                 string
		wrongIdentity, stale, live, blocked, auditFails, nullScore, disabled bool
		wantBroker                                                           bool
		wantAssessments                                                      int
	}{
		{name: "default retains account verified", decision: "PASS", wantAssessments: 2},
		{name: "opted in pass", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", wantBroker: true, wantAssessments: 1},
		{name: "fail", mode: "SIGNAL_QUALITY_OP2", decision: "FAIL", wantAssessments: 1},
		{name: "unavailable", mode: "SIGNAL_QUALITY_OP2", decision: "UNAVAILABLE", wantAssessments: 1},
		{name: "null score", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", nullScore: true, wantAssessments: 1},
		{name: "wrong identity", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", wrongIdentity: true, wantAssessments: 1},
		{name: "stale evidence", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", stale: true, wantAssessments: 1},
		{name: "live", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", live: true, wantAssessments: 1},
		{name: "reconciliation blocked", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", blocked: true},
		{name: "audit failed", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", auditFails: true, wantAssessments: 1},
		{name: "unknown mode", mode: "UNKNOWN", decision: "PASS"},
		{name: "unknown mode with plugin disabled", mode: "UNKNOWN", decision: "PASS", disabled: true},
		{name: "signal mode with plugin disabled", mode: "SIGNAL_QUALITY_OP2", decision: "PASS", disabled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assessments, broker := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assessments++
				var req AlphaDeskAssessmentRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
					return
				}
				if r.Header.Get("X-AlphaDesk-API-Key") != "test-key" {
					t.Error("missing authenticated request")
				}
				observed := req.ObservedAt
				if tc.stale {
					observed = observed.Add(-3 * time.Minute)
				}
				account := "paper-account"
				if tc.wrongIdentity {
					account = "other-account"
				}
				response := map[string]any{
					"scope": "SIGNAL_QUALITY", "decision": tc.decision,
					"market_scanner_signal_score": 0.9, "score_source": "alphadesk_connected_opportunity", "score_observed_at": req.ObservedAt,
					"market_evidence_at": req.MarketEvidenceAt, "observed_at": observed, "expires_at": req.ExpiresAt,
					"strategy_identity": map[string]any{"underlying_symbol": req.UnderlyingSymbol, "strategy_type": req.StrategyType, "side": req.Side, "quantity": req.Quantity},
					"external_identity": map[string]any{"account_id": account, "sandbox_id": "sandbox-1", "environment": "PAPER"},
					"execution_allowed": false, "human_approval_required": true,
				}
				if tc.nullScore {
					response["market_scanner_signal_score"] = nil
				}
				_ = json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			price := 1.0
			order := &interfaces.OptionsOrder{ClientOrderID: "stable-id", Symbol: "TSLA271217C00400000", Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
			order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
				if tc.auditFails {
					return errors.New("audit unavailable")
				}
				if a == nil || a.ExecutionAllowed || !a.HumanApprovalRequired {
					t.Error("provider assessment was rewritten")
				}
				return nil
			}
			s := &AlpacaTradingService{logger: logrus.New(), expectedAccountID: "paper-account", expectedPaper: !tc.live, expectedTenantID: "tenant-1", expectedSandboxID: "sandbox-1", clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, alphaDesk: &AlphaDeskClient{Enabled: !tc.disabled, SignalQualityEnabled: true, ExecutionMode: tc.mode, URL: server.URL, APIKey: "test-key", HTTP: server.Client(), Now: time.Now}, optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
				return []*interfaces.OptionContract{{Symbol: order.Symbol, Bid: .9, Ask: 1.1, BidSize: 10, AskSize: 10, QuoteTimestamp: time.Now().Add(-time.Second), Delta: .5}}, nil
			}, placeOrderFn: func(alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
				broker++
				return nil, errors.New("provider timeout")
			}}
			s.SetSubmissionMarker(func(string) error { return nil })
			if tc.blocked {
				s.executionBlocked = true
			}
			_, err := s.PlaceOptionsOrder(context.Background(), order)
			if err == nil || broker != map[bool]int{true: 1, false: 0}[tc.wantBroker] || assessments != tc.wantAssessments {
				t.Fatalf("err=%v broker=%d assessments=%d", err, broker, assessments)
			}
			if tc.wantBroker && !IsSubmissionUncertain(err) {
				t.Fatalf("broker timeout must be uncertain: %v", err)
			}
		})
	}
}
