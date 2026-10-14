package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
)

func standaloneFixturePolicyAt(minimum string) (map[string]any, string) {
	snapshot := map[string]any{"minimum_signal_score": minimum, "execution_max_quote_age_seconds": 120}
	raw, _ := json.Marshal(map[string]any{"workspace_policy": snapshot, "profile": "paper_advisory_greeks_v1", "paper_only": true, "require_greek_values": true, "unknown_greek_calculation_time": "warning"})
	hash := sha256.Sum256(raw)
	return snapshot, "standalone-paper-advisory-v1:" + hex.EncodeToString(hash[:])
}

func standaloneFixturePolicy() (map[string]any, string) { return standaloneFixturePolicyAt("65") }

func standaloneFixtureReceiptAt(p StandaloneTradeProposal, now time.Time, minimum string) map[string]any {
	snapshot, version := standaloneFixturePolicyAt(minimum)
	price, _ := decimal.NewFromString(string(p.LimitPrice))
	legs := make([]map[string]any, 0, len(p.Legs))
	for _, leg := range p.Legs {
		ratio := 1
		if leg.RatioQuantity != nil {
			ratio = *leg.RatioQuantity
		}
		legs = append(legs, map[string]any{"symbol": leg.Symbol, "side": leg.Side, "ratio_quantity": ratio})
	}
	echo := map[string]any{"legs": legs, "quantity": p.Quantity, "limit_price": price.String(), "client_reference": p.ClientReference}
	return map[string]any{
		"decision": "PASS", "scope": "TRADE_ASSESSMENT", "score_source": "alphadesk_direct_market_data",
		"score_profile": "catalyst_momentum_v1", "signal_score": 80, "minimum_passing_score": minimum,
		"advisory_policy_profile": "paper_advisory_greeks_v1", "advisory_policy_hash": "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca", "paper_only": true, "human_approval_required": true,
		"market_data":       map[string]any{"source": "alpaca", "feed": "indicative", "quality": "testing_only", "greeks_calculated_at": now, "greeks_calculation_provenance": "fixture-provider", "greeks_calculation_freshness": "verified", "warnings": []any{}},
		"execution_allowed": false, "retryable": false, "trade": echo,
		"trade_fingerprint": standaloneProposalFingerprint(p), "policy_snapshot": snapshot, "policy_version": version,
		"assessment_id": "fixture-id", "observed_at": now, "evidence_observed_at": now, "evidence_as_of": now,
		"expires_at": now.Add(time.Minute), "blocking_reasons": []string{}, "remediation": []string{},
		"checks":           []map[string]any{{"code": "quality", "passed": true}},
		"score_components": map[string]float64{"catalyst_confidence": .30, "sentiment": .15, "directional_momentum": .20, "relative_volume": .10, "market_confirmation": .025, "sector_confirmation": .025, "liquidity": 0},
	}
}

func standaloneFixtureReceipt(p StandaloneTradeProposal, now time.Time) map[string]any {
	return standaloneFixtureReceiptAt(p, now, "65")
}

func TestStandaloneConsumerPreservesFeedbackAndCannotAuthorizeOrders(t *testing.T) {
	now := time.Now().UTC()
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/api/v2/option-trade-assessments" {
			t.Errorf("unexpected route: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-AlphaDesk-API-Key") != "fixture-key" {
			t.Error("missing authentication")
		}
		var body StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		json.NewEncoder(w).Encode(standaloneFixtureReceipt(body, now))
	}))
	defer upstream.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: upstream.URL, APIKey: "fixture-key", HTTP: upstream.Client(), Now: func() time.Time { return now }}
	result, err := c.AssessOptionsTrade(context.Background(), proposal)
	if err != nil {
		t.Fatal(err)
	}
	if result["decision"] != "PASS" || result["execution_allowed"] != false || calls != 1 {
		t.Fatalf("bad result: %#v", result)
	}
}

func TestStandaloneConsumerAcceptsProducerGeneratedFastAPIReceipt(t *testing.T) {
	data, err := os.ReadFile("testdata/op2-pass-receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	}))
	defer server.Close()
	now := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC)
	client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
	clientReference := "op2-receipt-wire-format"
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("1.84"), ClientReference: &clientReference}
	result, err := client.AssessOptionsTrade(context.Background(), proposal)
	if err != nil {
		t.Fatalf("producer-generated FastAPI PASS receipt rejected: %v", err)
	}
	if result["decision"] != "PASS" || result["execution_allowed"] != false {
		t.Fatalf("unexpected producer receipt result: %#v", result)
	}
}

func standaloneBudgetPolicyDocument() map[string]any {
	snapshot := map[string]any{
		"minimum_signal_score": "65", "execution_max_quote_age_seconds": 120,
		"max_investment_per_candidate": "750", "maximum_contracts_per_candidate": 3,
	}
	bound := map[string]any{"workspace_policy": snapshot, "profile": "paper_advisory_greeks_v1", "paper_only": true, "require_greek_values": true, "unknown_greek_calculation_time": "warning"}
	raw, _ := json.Marshal(bound)
	hash := sha256.Sum256(raw)
	return map[string]any{
		"scope": "TRADE_ASSESSMENT", "policy_version": "standalone-paper-advisory-v1:" + hex.EncodeToString(hash[:]),
		"minimum_passing_score": "65", "policy_snapshot": snapshot, "execution_allowed": false,
		"advisory_policy_profile": "paper_advisory_greeks_v1", "advisory_policy_hash": "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca",
		"paper_only": true, "human_approval_required": true,
	}
}

func TestReadAssessmentPolicyReturnsOnlyAuthenticatedBudgetMetadata(t *testing.T) {
	valid, _ := json.Marshal(standaloneBudgetPolicyDocument())
	for _, tc := range []struct {
		name       string
		status     int
		body       []byte
		wantErr    string
		wantMethod string
	}{
		{"valid", http.StatusOK, valid, "", http.MethodGet},
		{"auth", http.StatusUnauthorized, []byte("private body"), "upstream_authentication", http.MethodGet},
		{"malformed", http.StatusOK, []byte(`{"scope":"TRADE_ASSESSMENT"}`), "response_validation", http.MethodGet},
		{"missing_budget", http.StatusOK, func() []byte {
			doc := standaloneBudgetPolicyDocument()
			delete(doc["policy_snapshot"].(map[string]any), "max_investment_per_candidate")
			data, _ := json.Marshal(doc)
			return data
		}(), "response_validation", http.MethodGet},
		{"redirect", http.StatusFound, []byte{}, "upstream_service_error", http.MethodGet},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.wantMethod || r.URL.Path != "/api/v2/option-trade-assessments/policy" || r.Header.Get("X-AlphaDesk-API-Key") != "fixture-key" {
					t.Errorf("unexpected authenticated read-only request: %s %s", r.Method, r.URL.Path)
				}
				if tc.name == "redirect" {
					w.Header().Set("Location", "https://untrusted.invalid")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write(tc.body)
			}))
			defer server.Close()
			client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client()}
			result, err := client.ReadAssessmentPolicy(context.Background())
			if tc.wantErr != "" {
				var unavailable *AlphaDeskUnavailableError
				if !errors.As(err, &unavailable) || unavailable.Category != tc.wantErr || result != nil {
					t.Fatalf("expected safe unavailable %q, got result=%#v err=%#v", tc.wantErr, result, err)
				}
				if strings.Contains(err.Error(), "private body") || strings.Contains(err.Error(), "fixture-key") {
					t.Fatal("upstream body or key reflected")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result["max_investment_per_candidate"] != "750" || result["maximum_contracts_per_candidate"] != json.Number("3") || result["decision"] != "POLICY_ONLY" || result["assessment_performed"] != false || result["execution_allowed"] != false {
				t.Fatalf("unexpected policy metadata: %#v", result)
			}
			if _, exists := result["signal_score"]; exists {
				t.Fatal("policy lookup returned assessment score")
			}
		})
	}
}

func TestReadStandaloneAssessmentPolicyDoesNotAssessOrCallBroker(t *testing.T) {
	policyBytes, _ := json.Marshal(standaloneBudgetPolicyDocument())
	gets, posts, brokerCalls := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			gets++
			_, _ = w.Write(policyBytes)
			return
		}
		posts++
	}))
	defer server.Close()
	alpha := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client()}
	service := &AlpacaTradingService{
		alphaDesk: alpha, expectedPaper: true, expectedAccountID: "paper-account",
		expectedTenantID: "workspace", expectedSandboxID: "sandbox",
		placeOrderFn: func(_ alpaca.PlaceOrderRequest) (*alpaca.Order, error) { brokerCalls++; return nil, nil },
	}
	if _, err := service.ReadStandaloneAssessmentPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gets != 1 || posts != 0 || brokerCalls != 0 {
		t.Fatalf("policy read crossed assessment/order boundary: GET=%d POST=%d broker=%d", gets, posts, brokerCalls)
	}
}

func TestStandaloneConsumerAcceptsExplicitlyUnknownGreekCalculationTime(t *testing.T) {
	now := time.Now().UTC()
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		doc := standaloneFixtureReceipt(proposal, now)
		market := doc["market_data"].(map[string]any)
		delete(market, "greeks_calculated_at")
		delete(market, "greeks_calculation_provenance")
		market["greeks_calculation_freshness"] = "unknown"
		market["warnings"] = []any{"greek_calculation_time_unknown"}
		json.NewEncoder(w).Encode(doc)
	}))
	defer server.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
	if _, err := c.AssessOptionsTrade(context.Background(), proposal); err != nil {
		t.Fatalf("unknown Greek calculation age rejected: %v", err)
	}
}

func TestStandaloneProposalFingerprintMatchesPythonContractFixture(t *testing.T) {
	p := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2.00")}
	if got := standaloneProposalFingerprint(p); got != "b1f1afbeb11913b98726ec9d88584c0d271bef8826adc2a6034a24e9a88a02be" {
		t.Fatalf("cross-language canonical fingerprint mismatch: %s", got)
	}
	_, version := standaloneFixturePolicy()
	if !strings.HasPrefix(version, "standalone-paper-advisory-v1:") {
		t.Fatalf("cross-language policy snapshot hash mismatch: %s", version)
	}
}

func TestStandaloneConsumerRejectsInvalidOrUnboundPASS(t *testing.T) {
	now := time.Now().UTC()
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	cases := []string{"authority", "stale", "missing_score", "weak_score", "unknown_decision", "wrong_quantity", "failed_check", "missing_marker", "redirect", "bad_json", "http_error", "blocker", "missing_metadata", "missing_blockers", "malformed_blockers", "retryable", "bad_fingerprint", "bool_score", "string_score", "policy_tampered", "missing_policy_snapshot", "malformed_policy_snapshot", "component_sum", "bool_component", "missing_check_code", "contradictory_pass", "unknown_trade_field", "missing_advisory_profile", "forged_advisory_hash", "execution_profile", "bool_greek_time", "number_greek_source", "map_greek_time", "whitespace_greek_source", "bool_unknown_greek_time"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				doc := standaloneFixtureReceipt(proposal, now)
				switch name {
				case "bool_greek_time":
					doc["market_data"].(map[string]any)["greeks_calculated_at"] = true
				case "number_greek_source":
					doc["market_data"].(map[string]any)["greeks_calculation_provenance"] = 7
				case "map_greek_time":
					doc["market_data"].(map[string]any)["greeks_calculated_at"] = map[string]any{"x": 1}
				case "whitespace_greek_source":
					doc["market_data"].(map[string]any)["greeks_calculation_provenance"] = "   "
				case "bool_unknown_greek_time":
					m := doc["market_data"].(map[string]any)
					delete(m, "greeks_calculated_at")
					delete(m, "greeks_calculation_provenance")
					m["greeks_calculated_at"] = false
					m["greeks_calculation_freshness"] = "unknown"
					m["warnings"] = []any{"greek_calculation_time_unknown"}
				case "missing_advisory_profile":
					delete(doc, "advisory_policy_profile")
				case "forged_advisory_hash":
					doc["advisory_policy_hash"] = strings.Repeat("0", 64)
				case "execution_profile":
					doc["paper_only"] = false
				case "missing_blockers":
					delete(doc, "blocking_reasons")
				case "malformed_blockers":
					doc["blocking_reasons"] = "invalid"
				case "blocker":
					doc["blocking_reasons"] = []string{"criterion failed"}
				case "missing_metadata":
					delete(doc, "observed_at")
				case "authority":
					doc["execution_allowed"] = true
				case "stale":
					doc["expires_at"] = now.Add(-time.Minute)
				case "missing_score":
					doc["signal_score"] = nil
				case "weak_score":
					doc["signal_score"] = 40
				case "unknown_decision":
					doc["decision"] = "approved"
				case "wrong_quantity":
					wrong := proposal
					wrong.Quantity = 2
					doc["trade"] = wrong
				case "failed_check":
					doc["checks"] = []map[string]any{{"passed": false}}
				case "retryable":
					doc["retryable"] = true
				case "bad_fingerprint":
					doc["trade_fingerprint"] = "forged"
				case "bool_score":
					doc["signal_score"] = true
				case "string_score":
					doc["signal_score"] = "80"
				case "policy_tampered":
					doc["policy_snapshot"] = map[string]any{"minimum_signal_score": "1"}
				case "missing_policy_snapshot":
					delete(doc, "policy_snapshot")
				case "malformed_policy_snapshot":
					doc["policy_snapshot"] = "invalid"
				case "component_sum":
					doc["score_components"] = map[string]float64{"catalyst_confidence": .30}
				case "bool_component":
					doc["score_components"] = map[string]any{"catalyst_confidence": true}
				case "missing_check_code":
					doc["checks"] = []map[string]any{{"passed": true}}
				case "contradictory_pass":
					doc["pass"] = false
				case "unknown_trade_field":
					doc["trade"] = map[string]any{"legs": proposal.Legs, "quantity": 1, "limit_price": "2", "caller_authority": true}
				case "missing_marker":
					delete(doc, "execution_allowed")
				case "redirect":
					w.Header().Set("Location", "https://untrusted.invalid")
					w.WriteHeader(302)
					return
				case "bad_json":
					w.Write([]byte("private-upstream-fixture-value"))
					return
				case "http_error":
					w.WriteHeader(403)
					w.Write([]byte("fixture-key"))
					return
				}
				json.NewEncoder(w).Encode(doc)
			}))
			defer server.Close()
			c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
			result, err := c.AssessOptionsTrade(context.Background(), proposal)
			if err == nil || result != nil {
				t.Fatalf("unsafe response accepted: %#v", result)
			}
			expectedStages := map[string]string{
				"wrong_quantity": "trade", "bad_fingerprint": "trade_fingerprint",
				"policy_tampered": "policy_version", "component_sum": "score_components",
				"forged_advisory_hash": "advisory_policy_hash", "missing_advisory_profile": "advisory_policy_profile",
				"execution_profile": "paper_only", "retryable": "retryable",
				"bool_greek_time": "market_data.greeks_calculated_at", "number_greek_source": "market_data.greeks_calculation_provenance",
				"whitespace_greek_source": "market_data.greeks_calculation_provenance",
				"missing_metadata":        "observed_at",
			}
			if expected := expectedStages[name]; expected != "" {
				var unavailable *AlphaDeskUnavailableError
				if !errors.As(err, &unavailable) || unavailable.Category != "response_validation" || unavailable.Stage != expected {
					t.Fatalf("validation diagnostic compatibility or safe stage missing: %#v", err)
				}
			}
			if strings.Contains(err.Error(), "fixture-key") || strings.Contains(err.Error(), "private-upstream") {
				t.Fatal("secret reflected")
			}
		})
	}
}

func TestStandaloneConsumerAcceptsNullUnknownGreekProvenance(t *testing.T) {
	now := time.Now().UTC()
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		doc := standaloneFixtureReceipt(proposal, now)
		market := doc["market_data"].(map[string]any)
		delete(market, "greeks_calculated_at")
		market["greeks_calculation_provenance"] = nil
		market["greeks_calculation_freshness"] = "unknown"
		market["warnings"] = []any{"greek_calculation_time_unknown"}
		json.NewEncoder(w).Encode(doc)
	}))
	defer server.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client(), Now: func() time.Time { return now }}
	if _, err := c.AssessOptionsTrade(context.Background(), proposal); err != nil {
		t.Fatalf("null unknown Greek provenance rejected: %v", err)
	}
}

func TestStandaloneFAILAndUnavailablePreserveFeedback(t *testing.T) {
	for _, decision := range []string{"FAIL", "UNAVAILABLE"} {
		t.Run(decision, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"decision": decision, "signal_score": 40, "execution_allowed": false,
					"blocking_reasons": []string{"criterion"}, "remediation": []string{"specific repair"}, "checks": []map[string]any{{"code": "criterion", "passed": false}}})
			}))
			defer s.Close()
			c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: s.URL, APIKey: "fixture-key", HTTP: s.Client()}
			doc, err := c.AssessOptionsTrade(context.Background(), StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")})
			if err != nil || doc["decision"] != decision || len(doc["remediation"].([]any)) != 1 {
				t.Fatalf("feedback lost: %#v %v", doc, err)
			}
		})
	}
}

func TestStandaloneConsumerClassifiesSafeUnavailableErrors(t *testing.T) {
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"authentication", http.StatusUnauthorized, "secret response", "upstream_authentication"},
		{"service", http.StatusBadGateway, "private body", "upstream_service_error"},
		{"schema", http.StatusOK, `{"decision":"PASS"}`, "response_validation"},
		{"invalid_json", http.StatusOK, "private body", "response_validation"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "test-key", HTTP: server.Client()}
			_, err := client.AssessOptionsTrade(context.Background(), proposal)
			var unavailable *AlphaDeskUnavailableError
			if !errors.As(err, &unavailable) || unavailable.Category != tc.want {
				t.Fatalf("got error %#v, want category %s", err, tc.want)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private body") {
				t.Fatal("upstream data leaked in error")
			}
		})
	}
}

func TestStandaloneEffectiveScoreThresholdIsBoundToPolicyVersion(t *testing.T) {
	snapshot, version := standaloneFixturePolicyAt("25")
	snapshot["execution_max_quote_age_seconds"] = json.Number("120")
	if !validStandalonePolicy(snapshot, version, 25) {
		t.Fatal("standalone score override did not validate against its effective policy")
	}
	if validStandalonePolicy(snapshot, version, 35) {
		t.Fatal("submission recheck accepted a different score threshold")
	}
}

func TestStandaloneConsumerClassifiesConfigurationDeadlineAndTransport(t *testing.T) {
	proposal := StandaloneTradeProposal{Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}, Quantity: 1, LimitPrice: json.Number("2")}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := server.URL
	server.Close()
	cases := []struct {
		name   string
		client *AlphaDeskClient
		ctx    context.Context
		want   string
	}{
		{"configuration", &AlphaDeskClient{}, context.Background(), "configuration"},
		{"deadline", &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: closedURL, APIKey: "test-key"}, expiredStandaloneContext(), "deadline_exceeded"},
		{"transport", &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: closedURL, APIKey: "test-key"}, context.Background(), "transport_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.client.AssessOptionsTrade(tc.ctx, proposal)
			var unavailable *AlphaDeskUnavailableError
			if !errors.As(err, &unavailable) || unavailable.Category != tc.want {
				t.Fatalf("got error %#v, want category %s", err, tc.want)
			}
		})
	}
}

func expiredStandaloneContext() context.Context {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	cancel()
	return ctx
}

func TestStandaloneValidationNeverCallsProvider(t *testing.T) {
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++; w.WriteHeader(500) }))
	defer s.Close()
	c := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: s.URL, APIKey: "fixture-key", HTTP: s.Client()}
	for _, proposal := range []StandaloneTradeProposal{
		{Quantity: 1, LimitPrice: json.Number("NaN")},
		{Quantity: 0, LimitPrice: json.Number("2"), Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}},
		{Quantity: 1, LimitPrice: json.Number("2"), Legs: []StandaloneTradeLeg{{Symbol: "aapl261106C00200000", Side: "buy"}}},
	} {
		if _, err := c.AssessOptionsTrade(context.Background(), proposal); err == nil {
			t.Fatal("invalid trade accepted")
		}
	}
	c.APIKey = ""
	if _, err := c.AssessOptionsTrade(context.Background(), StandaloneTradeProposal{Quantity: 1, LimitPrice: json.Number("2"), Legs: []StandaloneTradeLeg{{Symbol: "AAPL261106C00200000", Side: "buy"}}}); err == nil {
		t.Fatal("missing key accepted")
	}
	if requests != 0 {
		t.Fatal("unexpected external request")
	}
}
