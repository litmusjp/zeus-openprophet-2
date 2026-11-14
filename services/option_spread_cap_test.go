package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func spreadProposal(symbols ...string) StandaloneTradeProposal {
	legs := make([]StandaloneTradeLeg, 0, len(symbols))
	for i, symbol := range symbols {
		side := "buy"
		if i == 1 {
			side = "sell"
		}
		legs = append(legs, StandaloneTradeLeg{Symbol: symbol, Side: side})
	}
	return StandaloneTradeProposal{Legs: legs, Quantity: 1, LimitPrice: json.Number("2")}
}

func spreadDoc(profile string, ratios ...any) map[string]any {
	checks := []any{map[string]any{"code": "evidence_fresh", "passed": true, "actual": "1.5"}}
	for i, ratio := range ratios {
		checks = append(checks, map[string]any{"code": "leg_" + string(rune('0'+i)) + "_quote", "passed": true, "actual": ratio, "threshold": "0.50"})
	}
	return map[string]any{"score_profile": profile, "checks": checks}
}

func rebuildPolicyVersion(snapshot map[string]any) string {
	raw, _ := json.Marshal(map[string]any{"workspace_policy": snapshot, "profile": "paper_advisory_greeks_v1", "paper_only": true, "require_greek_values": true, "unknown_greek_calculation_time": "warning"})
	hash := sha256.Sum256(raw)
	return "standalone-paper-advisory-v1:" + hex.EncodeToString(hash[:])
}

func capService(t *testing.T, pct float64) *AlpacaTradingService {
	t.Helper()
	s := &AlpacaTradingService{}
	if err := s.SetOptionSpreadCapPct(pct); err != nil {
		t.Fatal(err)
	}
	return s
}

func spreadCapCode(err error) string {
	var capErr *OptionSpreadCapError
	if errors.As(err, &capErr) {
		return capErr.Code
	}
	return ""
}

func TestOptionSpreadCapBoundaryBelowEqualAbove(t *testing.T) {
	p := spreadProposal("AAPL261106C00200000")
	s := capService(t, 10)
	for name, tc := range map[string]struct {
		actual any
		want   string
	}{
		"below":              {"0.0912", ""},
		"equal":              {"0.1", ""},
		"equal_long_zeros":   {"0.10000000000000000000", ""},
		"just_above":         {"0.1000001", optionSpreadAboveCapCode},
		"above":              {"0.1227", optionSpreadAboveCapCode},
		"number_type":        {json.Number("0.0999"), ""},
		"number_type_above":  {json.Number("0.2393"), optionSpreadAboveCapCode},
		"zero_spread":        {"0", ""},
		"negative":           {"-0.01", optionSpreadEvidenceCode},
		"not_a_number":       {"abc", optionSpreadEvidenceCode},
		"missing_value":      {nil, optionSpreadEvidenceCode},
		"boolean":            {true, optionSpreadEvidenceCode},
		"huge_unbounded_999": {"999", optionSpreadAboveCapCode},
	} {
		t.Run(name, func(t *testing.T) {
			err := s.enforceOptionSpreadCap(p, spreadDoc(scoreProfileV1, tc.actual))
			if got := spreadCapCode(err); got != tc.want {
				t.Fatalf("code=%q want %q (%v)", got, tc.want, err)
			}
			if tc.want != "" && !IsPreSubmissionRejection(err) {
				t.Fatal("a spread refusal must be a pre-submission rejection")
			}
		})
	}
}

func TestOptionSpreadCapMessageCarriesObservedValueAndCap(t *testing.T) {
	err := capService(t, 10).enforceOptionSpreadCap(spreadProposal("BA261204C00170000"), spreadDoc(scoreProfileV1, "0.1227"))
	if err == nil || !strings.Contains(err.Error(), optionSpreadAboveCapCode) || !strings.Contains(err.Error(), "12.27%") || !strings.Contains(err.Error(), "cap of 10%") {
		t.Fatalf("unexpected refusal text: %v", err)
	}
}

func TestOptionSpreadCapEvidenceMustBeCompleteAndUnambiguous(t *testing.T) {
	two := spreadProposal("AAPL261106C00200000", "AAPL261106C00210000")
	s := capService(t, 10)
	cases := map[string]struct {
		proposal StandaloneTradeProposal
		doc      map[string]any
	}{
		"no_checks":   {spreadProposal("AAPL261106C00200000"), map[string]any{"score_profile": scoreProfileV1}},
		"no_quote":    {spreadProposal("AAPL261106C00200000"), map[string]any{"score_profile": scoreProfileV1, "checks": []any{map[string]any{"code": "evidence_fresh", "passed": true, "actual": "1"}}}},
		"missing_leg": {two, spreadDoc(scoreProfileV1, "0.05")},
		"extra_leg":   {spreadProposal("AAPL261106C00200000"), spreadDoc(scoreProfileV1, "0.05", "0.05")},
		"duplicate": {spreadProposal("AAPL261106C00200000"), map[string]any{"score_profile": scoreProfileV1, "checks": []any{
			map[string]any{"code": "leg_0_quote", "passed": true, "actual": "0.05"}, map[string]any{"code": "leg_0_quote", "passed": true, "actual": "0.05"}}}},
		"not_passed": {spreadProposal("AAPL261106C00200000"), map[string]any{"score_profile": scoreProfileV1, "checks": []any{
			map[string]any{"code": "leg_0_quote", "passed": false, "actual": "0.05"}}}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := spreadCapCode(s.enforceOptionSpreadCap(tc.proposal, tc.doc)); got != optionSpreadEvidenceCode {
				t.Fatalf("code=%q, want %q", got, optionSpreadEvidenceCode)
			}
		})
	}
}

func TestOptionSpreadCapUsesTheWorstLegOfAVertical(t *testing.T) {
	two := spreadProposal("AAPL261106C00200000", "AAPL261106C00210000")
	s := capService(t, 10)
	if err := s.enforceOptionSpreadCap(two, spreadDoc(scoreProfileV1, "0.05", "0.08")); err != nil {
		t.Fatalf("both legs inside the cap were refused: %v", err)
	}
	if got := spreadCapCode(s.enforceOptionSpreadCap(two, spreadDoc(scoreProfileV1, "0.05", "0.12"))); got != optionSpreadAboveCapCode {
		t.Fatalf("a wide second leg was not refused: %q", got)
	}
	if got := spreadCapCode(s.enforceOptionSpreadCap(two, spreadDoc(scoreProfileV1, "0.12", "0.05"))); got != optionSpreadAboveCapCode {
		t.Fatalf("a wide first leg was not refused: %q", got)
	}
}

func v2Quotes(rows ...[3]string) []any {
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, map[string]any{"symbol": row[0], "bid": row[1], "ask": row[2], "bid_size": "10", "ask_size": "10"})
	}
	return out
}

func TestOptionSpreadCapV2QuoteBlockIsCrossCheckedAgainstTheChecks(t *testing.T) {
	p := spreadProposal("AAPL261106C00200000")
	s := capService(t, 10)
	// bid 9.55 / ask 10.45 -> (0.90 / 10.00) = 0.09
	good := spreadDoc(scoreProfileV2, "0.09")
	good["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "9.55", "10.45"})
	if err := s.enforceOptionSpreadCap(p, good); err != nil {
		t.Fatalf("matching v2 evidence refused: %v", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"block_missing":      func(d map[string]any) { delete(d, "option_quotes") },
		"block_wrong_length": func(d map[string]any) { d["option_quotes"] = []any{} },
		"other_contract": func(d map[string]any) {
			d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00210000", "9.55", "10.45"})
		},
		"disagrees": func(d map[string]any) {
			d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "9.00", "11.00"})
		},
		"crossed": func(d map[string]any) {
			d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "10.45", "9.55"})
		},
		"zero_bid":      func(d map[string]any) { d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "0", "0.10"}) },
		"malformed_row": func(d map[string]any) { d["option_quotes"] = []any{"x"} },
		"hides_a_wide_quote": func(d map[string]any) {
			d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "5.00", "15.00"})
		},
		"unparseable_numbers": func(d map[string]any) { d["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "bid", "ask"}) },
	} {
		t.Run(name, func(t *testing.T) {
			doc := spreadDoc(scoreProfileV2, "0.09")
			doc["option_quotes"] = v2Quotes([3]string{"AAPL261106C00200000", "9.55", "10.45"})
			mutate(doc)
			if got := spreadCapCode(s.enforceOptionSpreadCap(p, doc)); got != optionSpreadEvidenceCode {
				t.Fatalf("code=%q, want %q", got, optionSpreadEvidenceCode)
			}
		})
	}
	// A v1 receipt does not need the block.
	if err := s.enforceOptionSpreadCap(p, spreadDoc(scoreProfileV1, "0.09")); err != nil {
		t.Fatalf("v1 receipt refused: %v", err)
	}
}

func TestOptionSpreadCapConfigurationEnvPushAndValidation(t *testing.T) {
	p := spreadProposal("AAPL261106C00200000")
	wide := spreadDoc(scoreProfileV1, "0.12")

	t.Run("unset_means_no_cap_was_supplied", func(t *testing.T) {
		t.Setenv(optionSpreadCapEnv, "")
		s := &AlpacaTradingService{}
		s.LoadOptionSpreadCapFromEnv()
		if _, configured, invalid := s.OptionSpreadCapPct(); configured || invalid {
			t.Fatal("empty variable configured a cap")
		}
		if err := s.enforceOptionSpreadCap(p, wide); err != nil {
			t.Fatalf("unconfigured cap refused an opening: %v", err)
		}
	})
	t.Run("valid_env", func(t *testing.T) {
		t.Setenv(optionSpreadCapEnv, "10")
		s := &AlpacaTradingService{}
		s.LoadOptionSpreadCapFromEnv()
		if pct, configured, invalid := s.OptionSpreadCapPct(); !configured || invalid || pct != 10 {
			t.Fatalf("pct=%v configured=%v invalid=%v", pct, configured, invalid)
		}
		if got := spreadCapCode(s.enforceOptionSpreadCap(p, wide)); got != optionSpreadAboveCapCode {
			t.Fatalf("env cap not enforced: %q", got)
		}
	})
	for _, bad := range []string{"abc", "1", "26", "NaN", "-5"} {
		t.Run("invalid_env_"+bad, func(t *testing.T) {
			t.Setenv(optionSpreadCapEnv, bad)
			s := &AlpacaTradingService{}
			s.LoadOptionSpreadCapFromEnv()
			if _, _, invalid := s.OptionSpreadCapPct(); !invalid {
				t.Fatal("malformed cap was not flagged")
			}
			if got := spreadCapCode(s.enforceOptionSpreadCap(p, spreadDoc(scoreProfileV1, "0.01"))); got != optionSpreadCapConfigErr {
				t.Fatalf("malformed cap did not fail closed: %q", got)
			}
		})
	}
	t.Run("run_time_change_applies_immediately_and_recovers_from_invalid", func(t *testing.T) {
		t.Setenv(optionSpreadCapEnv, "abc")
		s := &AlpacaTradingService{}
		s.LoadOptionSpreadCapFromEnv()
		if err := s.SetOptionSpreadCapPct(15); err != nil {
			t.Fatal(err)
		}
		if err := s.enforceOptionSpreadCap(p, wide); err != nil {
			t.Fatalf("15%% cap refused a 12%% spread: %v", err)
		}
		if err := s.SetOptionSpreadCapPct(8); err != nil {
			t.Fatal(err)
		}
		if got := spreadCapCode(s.enforceOptionSpreadCap(p, wide)); got != optionSpreadAboveCapCode {
			t.Fatalf("tightened cap not applied: %q", got)
		}
		for _, bad := range []float64{0, 1.9, 25.1, -1} {
			if err := s.SetOptionSpreadCapPct(bad); err == nil {
				t.Fatalf("out-of-range cap %v accepted", bad)
			}
		}
		if pct, _, _ := s.OptionSpreadCapPct(); pct != 8 {
			t.Fatalf("a rejected change altered the cap: %v", pct)
		}
	})
}

func TestOptionSpreadCapIsSafeUnderConcurrentUse(t *testing.T) {
	s := capService(t, 10)
	p := spreadProposal("AAPL261106C00200000")
	doc := spreadDoc(scoreProfileV1, "0.05")
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(2)
		go func(i int) { defer group.Done(); _ = s.SetOptionSpreadCapPct(float64(5 + i%10)) }(i)
		go func() { defer group.Done(); _ = s.enforceOptionSpreadCap(p, doc) }()
	}
	group.Wait()
}

// --- evaluator version (score profile) through the policy state, caches and both order guards ---

type evaluatorFixture struct {
	mu             sync.Mutex
	policyProfile  string // "" = the policy names no profile (the AlphaDesk that exists today)
	receiptProfile string
	ratio          string
	posts          int
	gets           int
}

func (f *evaluatorFixture) set(fn func(*evaluatorFixture)) { f.mu.Lock(); defer f.mu.Unlock(); fn(f) }

func newEvaluatorServer(t *testing.T, f *evaluatorFixture, now time.Time) (*httptest.Server, *AlpacaTradingService) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodGet {
			f.gets++
			snapshot, version := standaloneFixturePolicy()
			doc := map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": "65"}
			if f.policyProfile != "" {
				doc["score_profile"] = f.policyProfile
			}
			_ = json.NewEncoder(w).Encode(doc)
			return
		}
		f.posts++
		var echoed StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&echoed); err != nil {
			t.Error(err)
			return
		}
		receipt := standaloneFixtureReceiptAt(echoed, now, "65")
		receipt["score_profile"] = f.receiptProfile
		checks := []map[string]any{{"code": "quality", "passed": true}}
		quotes := []any{}
		for i, leg := range echoed.Legs {
			checks = append(checks, map[string]any{"code": "leg_" + string(rune('0'+i)) + "_quote", "passed": true, "actual": f.ratio, "threshold": "0.50"})
			quotes = append(quotes, map[string]any{"symbol": leg.Symbol, "bid": "9.55", "ask": "10.45"})
		}
		receipt["checks"] = checks
		if f.receiptProfile == scoreProfileV2 {
			receipt["option_quotes"] = quotes
		}
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	t.Cleanup(server.Close)
	client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-only", HTTP: server.Client(), Now: func() time.Time { return now }}
	service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: "paper", expectedTenantID: "tenant", expectedSandboxID: "sandbox", policy: &TradingPolicy{}, alphaDesk: client}
	return server, service
}

func evaluatorOrder(audits *int) *interfaces.OptionsOrder {
	price := 2.0
	return &interfaces.OptionsOrder{Symbol: "AAPL261106C00200000", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", LimitPrice: &price,
		AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { *audits++; return nil }}
}

func TestEvaluatorVersionAcceptsExactlyTheTwoCoherentTuples(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		name, policy, receipt string
		wantOK                bool
	}{
		{"legacy_policy_v1_receipt", "", scoreProfileV1, true},
		{"explicit_v1", scoreProfileV1, scoreProfileV1, true},
		{"explicit_v2", scoreProfileV2, scoreProfileV2, true},
		{"v2_receipt_legacy_policy", "", scoreProfileV2, false},
		{"v1_receipt_v2_policy", scoreProfileV2, scoreProfileV1, false},
		{"v2_receipt_v1_policy", scoreProfileV1, scoreProfileV2, false},
		{"unknown_receipt", scoreProfileV1, "catalyst_momentum_v3", false},
		{"unknown_policy", "catalyst_momentum_v3", scoreProfileV1, false},
		{"empty_receipt", scoreProfileV1, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &evaluatorFixture{policyProfile: tc.policy, receiptProfile: tc.receipt, ratio: "0.09"}
			_, service := newEvaluatorServer(t, f, now)
			audits := 0
			order := evaluatorOrder(&audits)
			err := service.requirePaperAdvisoryQualification(context.Background(), order)
			if tc.wantOK {
				if err != nil || audits != 1 || order.AlphaDeskAssessment == nil || order.AlphaDeskAssessment.ScoreProfile != tc.receipt {
					t.Fatalf("coherent tuple refused: err=%v audits=%d", err, audits)
				}
				return
			}
			if err == nil || audits != 0 || order.AlphaDeskAssessment != nil {
				t.Fatalf("incoherent tuple accepted: err=%v audits=%d", err, audits)
			}
		})
	}
}

func TestEvaluatorVersionChangeBetweenAssessmentAndSubmissionIsRefused(t *testing.T) {
	now := time.Now().UTC()
	f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.09"}
	_, service := newEvaluatorServer(t, f, now)
	audits := 0
	order := evaluatorOrder(&audits)
	if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil {
		t.Fatal(err)
	}
	if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); err != nil {
		t.Fatalf("unchanged tuple refused at submission: %v", err)
	}
	f.set(func(f *evaluatorFixture) { f.policyProfile = scoreProfileV2 })
	if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); err == nil {
		t.Fatal("a v1 receipt crossed the final guard after AlphaDesk moved to v2")
	}
}

func TestEvaluatorVersionChangeForcesAFreshAssessment(t *testing.T) {
	now := time.Now().UTC()
	f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.09"}
	_, service := newEvaluatorServer(t, f, now)
	p := spreadProposal("AAPL261106C00200000")
	identity := service.standaloneIdentity()
	if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, true); err != nil {
		t.Fatal(err)
	}
	if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, true); err != nil || f.posts != 1 {
		t.Fatalf("unchanged tuple reassessed: posts=%d err=%v", f.posts, err)
	}
	// AlphaDesk moves to v2: the cached v1 receipt must not be reused, and the new v2 receipt is accepted.
	f.set(func(f *evaluatorFixture) { f.policyProfile, f.receiptProfile = scoreProfileV2, scoreProfileV2 })
	doc, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, true)
	if err != nil || f.posts != 2 || doc["score_profile"] != scoreProfileV2 {
		t.Fatalf("v1 receipt reused after the evaluator changed: posts=%d profile=%v err=%v", f.posts, doc["score_profile"], err)
	}
	// Read-only (non-verifying) cache path through the managed branch uses the same comparison; the legacy
	// non-managed branch never reads policy, so a stale receipt there is bounded by its own expiry (documented).
}

func TestSpreadCapAppliesAtBothOrderGuardsAndFollowsTheRunningSetting(t *testing.T) {
	now := time.Now().UTC()
	for _, profile := range []string{scoreProfileV1, scoreProfileV2} {
		t.Run(profile, func(t *testing.T) {
			f := &evaluatorFixture{policyProfile: profile, receiptProfile: profile, ratio: "0.09"}
			_, service := newEvaluatorServer(t, f, now)
			if err := service.SetOptionSpreadCapPct(10); err != nil {
				t.Fatal(err)
			}
			audits := 0
			order := evaluatorOrder(&audits)
			if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil || audits != 1 {
				t.Fatalf("9%% spread refused by a 10%% cap: %v", err)
			}
			if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); err != nil {
				t.Fatalf("submission guard refused an approved order: %v", err)
			}
			// The saved cap is tightened while the backend is running: the final guard follows it.
			if err := service.SetOptionSpreadCapPct(8.5); err != nil {
				t.Fatal(err)
			}
			if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); spreadCapCode(err) != optionSpreadAboveCapCode {
				t.Fatalf("a 9%% spread above an 8.5%% cap should be refused at the final guard: %v", err)
			}
		})
	}
}

func TestSpreadCapRefusesWideSpreadBeforeAuditAndAttachment(t *testing.T) {
	now := time.Now().UTC()
	f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.1227"}
	_, service := newEvaluatorServer(t, f, now)
	if err := service.SetOptionSpreadCapPct(10); err != nil {
		t.Fatal(err)
	}
	audits := 0
	order := evaluatorOrder(&audits)
	err := service.requirePaperAdvisoryQualification(context.Background(), order)
	if spreadCapCode(err) != optionSpreadAboveCapCode || !IsPreSubmissionRejection(err) || audits != 0 || order.AlphaDeskAssessment != nil {
		t.Fatalf("wide spread not refused cleanly: err=%v audits=%d", err, audits)
	}
	var unavailable *AlphaDeskUnavailableError
	if errors.As(err, &unavailable) {
		t.Fatal("a spread-cap refusal must not look like an AlphaDesk decision")
	}
}

func TestSpreadCapDoesNotTouchOrdersThatCloseOrReduce(t *testing.T) {
	// Closing and reducing orders never reach the AlphaDesk guard; standaloneProposalForOrder only accepts
	// buy_to_open, so a sell_to_close cannot be checked by (or refused for) the cap.
	price := 2.0
	closing := &interfaces.OptionsOrder{Symbol: "AAPL261106C00200000", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", LimitPrice: &price}
	if _, err := standaloneProposalForOrder(closing); err == nil {
		t.Fatal("a closing order was treated as an opening proposal")
	}
}

func TestReadAssessmentPolicyReturnsEvaluatorAndFacts(t *testing.T) {
	for _, tc := range []struct {
		name, profile, wantProfile, wantVeto string
		wantErr                              bool
	}{
		{"legacy_no_profile", "", scoreProfileV1, "alphadesk_numeric_limit", false},
		{"v1", scoreProfileV1, scoreProfileV1, "alphadesk_numeric_limit", false},
		{"v2", scoreProfileV2, scoreProfileV2, "delegated_to_op2", false},
		{"unknown", "catalyst_momentum_v9", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := standaloneBudgetPolicyDocument()
			snapshot := doc["policy_snapshot"].(map[string]any)
			snapshot["minimum_catalyst_confidence"] = "0.15"
			snapshot["execution_max_spread_ratio"] = "0.50"
			snapshot["minimum_dte"], snapshot["maximum_dte"] = 1, 180
			// the digest binds the snapshot, so rebuild the version for the edited snapshot
			doc["policy_version"] = rebuildPolicyVersion(snapshot)
			if tc.profile != "" {
				doc["score_profile"] = tc.profile
			}
			body, _ := json.Marshal(doc)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
			defer server.Close()
			client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client()}
			result, err := client.ReadAssessmentPolicy(context.Background())
			if tc.wantErr {
				if err == nil || result != nil {
					t.Fatalf("unknown evaluator accepted: %#v", result)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			facts, ok := result["assessment_policy_facts"].(map[string]any)
			if !ok || result["score_profile"] != tc.wantProfile || facts["score_profile"] != tc.wantProfile || facts["spread_veto"] != tc.wantVeto {
				t.Fatalf("unexpected facts: %#v", result)
			}
			if facts["minimum_signal_score"] != 65.0 || facts["minimum_catalyst_confidence"] != 0.15 || facts["maximum_dte"] != 180.0 || facts["require_price_action_confirmation"] != true {
				t.Fatalf("facts do not carry the live thresholds: %#v", facts)
			}
			if _, has := result["signal_score"]; has {
				t.Fatal("policy facts leaked an assessment")
			}
		})
	}
}

func TestReadStandaloneAssessmentPolicyAddsTheOp2Cap(t *testing.T) {
	doc := standaloneBudgetPolicyDocument()
	body, _ := json.Marshal(doc)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	client := &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, URL: server.URL, APIKey: "fixture-key", HTTP: server.Client()}
	service := &AlpacaTradingService{expectedPaper: true, expectedAccountID: "a", expectedTenantID: "t", expectedSandboxID: "s", alphaDesk: client}
	result, err := service.ReadStandaloneAssessmentPolicy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, has := result["assessment_policy_facts"].(map[string]any)["op2_option_spread_cap_pct"]; has {
		t.Fatal("an unconfigured cap was reported")
	}
	_ = service.SetOptionSpreadCapPct(10)
	result, _ = service.ReadStandaloneAssessmentPolicy(context.Background())
	if result["assessment_policy_facts"].(map[string]any)["op2_option_spread_cap_pct"] != 10.0 {
		t.Fatalf("cap missing from facts: %#v", result["assessment_policy_facts"])
	}
}
