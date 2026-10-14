package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/shopspring/decimal"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// StandaloneTradeProposal contains only the proposed trade, never caller evidence.
type StandaloneTradeLeg struct {
	Symbol        string `json:"symbol"`
	Side          string `json:"side"`
	RatioQuantity *int   `json:"ratio_quantity,omitempty"`
}

func (leg *StandaloneTradeLeg) UnmarshalJSON(data []byte) error {
	type wireLeg StandaloneTradeLeg
	var decoded wireLeg
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*leg = StandaloneTradeLeg(decoded)
	return nil
}

type StandaloneTradeProposal struct {
	Legs            []StandaloneTradeLeg `json:"legs"`
	Quantity        int                  `json:"quantity"`
	LimitPrice      json.Number          `json:"limit_price"`
	ClientReference *string              `json:"client_reference,omitempty"`
}

func (p *StandaloneTradeProposal) UnmarshalJSON(data []byte) error {
	var wire struct {
		Legs            []StandaloneTradeLeg `json:"legs"`
		Quantity        int                  `json:"quantity"`
		LimitPrice      json.RawMessage      `json:"limit_price"`
		ClientReference *string              `json:"client_reference,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var price string
	if len(wire.LimitPrice) == 0 {
		return errors.New("missing limit price")
	}
	if wire.LimitPrice[0] == '"' {
		if err := json.Unmarshal(wire.LimitPrice, &price); err != nil {
			return err
		}
	} else {
		price = string(wire.LimitPrice)
	}
	p.Legs, p.Quantity, p.LimitPrice, p.ClientReference = wire.Legs, wire.Quantity, json.Number(price), wire.ClientReference
	return nil
}

var standaloneOCC = regexp.MustCompile(`^[A-Z0-9]{1,6}[0-9]{6}[CP][0-9]{8}$`)

func (p StandaloneTradeProposal) Validate() error {
	price, err := decimal.NewFromString(string(p.LimitPrice))
	if err != nil || !price.IsPositive() || p.Quantity < 1 || p.Quantity > 10 || len(p.Legs) < 1 || len(p.Legs) > 2 {
		return errors.New("invalid standalone trade quantity, price or legs")
	}
	if p.ClientReference != nil && len(*p.ClientReference) > 128 {
		return errors.New("invalid client reference")
	}
	for _, leg := range p.Legs {
		if len(leg.Symbol) > 21 || !standaloneOCC.MatchString(leg.Symbol) || (leg.Side != "buy" && leg.Side != "sell") || (leg.RatioQuantity != nil && (*leg.RatioQuantity < 1 || *leg.RatioQuantity > 10)) {
			return errors.New("invalid standalone option leg")
		}
	}
	return nil
}
func standaloneProposalFingerprint(p StandaloneTradeProposal) string {
	reference := "-1:"
	if p.ClientReference != nil {
		reference = strconv.Itoa(len([]byte(*p.ClientReference))) + ":" + *p.ClientReference
	}
	legs := ""
	for i, leg := range p.Legs {
		if i > 0 {
			legs += ";"
		}
		ratio := 1
		if leg.RatioQuantity != nil {
			ratio = *leg.RatioQuantity
		}
		legs += strconv.Itoa(len(leg.Symbol)) + ":" + leg.Symbol + ":" + leg.Side + ":" + strconv.Itoa(ratio)
	}
	price, _ := decimal.NewFromString(string(p.LimitPrice))
	canonical := "standalone-proposal-v2|q:" + strconv.Itoa(p.Quantity) + "|p:" + price.String() + "|r:" + reference + "|n:" + strconv.Itoa(len(p.Legs)) + "|" + legs
	hash := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(hash[:])
}
func standaloneNumber(v any) (float64, error) {
	var raw string
	switch n := v.(type) {
	case json.Number:
		raw = string(n)
	case string:
		raw = n
	default:
		return 0, errors.New("missing score")
	}
	number, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, errors.New("invalid score")
	}
	return number, nil
}
func validStandalonePolicyDigest(snapshot map[string]any, version string) bool {
	if len(version) != len("standalone-paper-advisory-v1:")+64 || !bytes.HasPrefix([]byte(version), []byte("standalone-paper-advisory-v1:")) {
		return false
	}
	bound := map[string]any{"workspace_policy": snapshot, "profile": "paper_advisory_greeks_v1", "paper_only": true, "require_greek_values": true, "unknown_greek_calculation_time": "warning"}
	raw, err := json.Marshal(bound)
	if err != nil {
		return false
	}
	hash := sha256.Sum256(raw)
	if version != "standalone-paper-advisory-v1:"+hex.EncodeToString(hash[:]) {
		return false
	}
	return true
}
func validStandalonePolicy(value any, versionValue any, threshold float64) bool {
	snapshot, ok := value.(map[string]any)
	version, versionOK := versionValue.(string)
	if !ok || !versionOK || !validStandalonePolicyDigest(snapshot, version) {
		return false
	}
	minimum, err := standaloneNumber(snapshot["minimum_signal_score"])
	maxAge, ageErr := standaloneNumber(snapshot["execution_max_quote_age_seconds"])
	return err == nil && ageErr == nil && minimum == threshold && maxAge > 0 && maxAge <= 300
}
func validStandaloneComponents(value any, score float64) bool {
	components, ok := value.(map[string]any)
	if !ok || len(components) != 7 {
		return false
	}
	limits := map[string]float64{"catalyst_confidence": .30, "sentiment": .15, "directional_momentum": .20, "relative_volume": .10, "market_confirmation": .075, "sector_confirmation": .075, "liquidity": .10}
	total := 0.0
	for name, limit := range limits {
		v, exists := components[name]
		if !exists {
			return false
		}
		if _, numeric := v.(json.Number); !numeric {
			return false
		}
		component, err := standaloneNumber(v)
		if err != nil || component < 0 || component > limit {
			return false
		}
		total += component
	}
	return math.Abs(total-score/100) <= .000051
}
func sameStandaloneTrade(a, b StandaloneTradeProposal) bool {
	if a.Quantity != b.Quantity || len(a.Legs) != len(b.Legs) {
		return false
	}
	ad, ade := decimal.NewFromString(string(a.LimitPrice))
	bd, bde := decimal.NewFromString(string(b.LimitPrice))
	if ade != nil || bde != nil || !ad.Equal(bd) {
		return false
	}
	if (a.ClientReference == nil) != (b.ClientReference == nil) || (a.ClientReference != nil && *a.ClientReference != *b.ClientReference) {
		return false
	}
	for i, leg := range a.Legs {
		other := b.Legs[i]
		ratio, otherRatio := 1, 1
		if leg.RatioQuantity != nil {
			ratio = *leg.RatioQuantity
		}
		if other.RatioQuantity != nil {
			otherRatio = *other.RatioQuantity
		}
		if leg.Symbol != other.Symbol || leg.Side != other.Side || ratio != otherRatio {
			return false
		}
	}
	return true
}

// AssessOptionsTrade is a five-second, read-only quality check. It does not call
// a broker or modify ACCOUNT_VERIFIED execution, accounts or approval storage.
func (c *AlphaDeskClient) AssessOptionsTrade(ctx context.Context, proposal StandaloneTradeProposal) (map[string]any, error) {
	validationStage := "response_read"
	unavailable := func(category string) (map[string]any, error) {
		stage := ""
		if category == "response_validation" {
			stage = validationStage
		}
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone AlphaDesk assessment is unavailable; do not execute this proposal", Category: category, Stage: stage}
	}
	rejectField := func(field string) (map[string]any, error) {
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone AlphaDesk assessment is unavailable; do not execute this proposal", Category: "response_validation", Stage: field}
	}
	if err := proposal.Validate(); err != nil {
		return nil, err
	}
	if c == nil || !c.Enabled || !c.SignalQualityEnabled || c.APIKey == "" {
		return unavailable("configuration")
	}
	if err := ValidateAlphaDeskURL(c.URL); err != nil {
		return unavailable("configuration")
	}
	body, err := json.Marshal(proposal)
	if err != nil {
		return unavailable("response_validation")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", c.URL+"/api/v2/option-trade-assessments", bytes.NewReader(body))
	if err != nil {
		return unavailable("response_validation")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AlphaDesk-API-Key", c.APIKey)
	client := http.Client{Timeout: 5 * time.Second}
	if c.HTTP != nil {
		client = *c.HTTP
		client.Timeout = 5 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return unavailable("deadline_exceeded")
		}
		return unavailable("transport_error")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return unavailable("upstream_authentication")
		}
		return unavailable("upstream_service_error")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 262145))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return unavailable("deadline_exceeded")
		}
		return unavailable("transport_error")
	}
	if len(data) > 262144 {
		return unavailable("response_validation")
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF {
		return unavailable("response_validation")
	}
	validationStage = "decision"
	decision, ok := result["decision"].(string)
	if !ok || (decision != "PASS" && decision != "FAIL" && decision != "UNAVAILABLE") {
		return unavailable("response_validation")
	}
	authority, ok := result["execution_allowed"].(bool)
	if !ok || authority {
		return rejectField("execution_allowed")
	}
	if decision == "PASS" {
		if passValue, exists := result["pass"]; exists && passValue != true {
			return rejectField("pass")
		}
		if result["scope"] != "TRADE_ASSESSMENT" {
			return rejectField("scope")
		}
		if result["score_source"] != "alphadesk_direct_market_data" {
			return rejectField("score_source")
		}
		if result["score_profile"] != "catalyst_momentum_v1" {
			return rejectField("score_profile")
		}
		if result["retryable"] != false {
			return rejectField("retryable")
		}
		if result["advisory_policy_profile"] != "paper_advisory_greeks_v1" {
			return rejectField("advisory_policy_profile")
		}
		if result["advisory_policy_hash"] != "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca" {
			return rejectField("advisory_policy_hash")
		}
		if result["paper_only"] != true {
			return rejectField("paper_only")
		}
		if result["human_approval_required"] != true {
			return rejectField("human_approval_required")
		}
		if value, ok := result["assessment_id"].(string); !ok || value == "" {
			return rejectField("assessment_id")
		}
		if value, ok := result["policy_version"].(string); !ok || value == "" {
			return rejectField("policy_version")
		}
		validationStage = "observed_at"
		observedText, ok := result["observed_at"].(string)
		if !ok {
			return rejectField("observed_at")
		}
		observed, parseErr := time.Parse(time.RFC3339Nano, observedText)
		if parseErr != nil {
			return rejectField("observed_at")
		}
		validationStage = "evidence_observed_at"
		evidenceText, ok := result["evidence_observed_at"].(string)
		if !ok {
			return rejectField("evidence_observed_at")
		}
		evidenceAt, parseErr := time.Parse(time.RFC3339Nano, evidenceText)
		if parseErr != nil || evidenceAt.After(observed) {
			return rejectField("evidence_observed_at")
		}
		validationStage = "market_data"
		market, marketOK := result["market_data"].(map[string]any)
		if !marketOK {
			return rejectField("market_data")
		}
		if market["source"] != "alpaca" {
			return rejectField("market_data.source")
		}
		if market["feed"] != "indicative" {
			return rejectField("market_data.feed")
		}
		if market["quality"] != "testing_only" {
			return rejectField("market_data.quality")
		}
		rawGreekTime, timePresent := market["greeks_calculated_at"]
		rawGreekSource, sourcePresent := market["greeks_calculation_provenance"]
		if timePresent && rawGreekTime != nil {
			if _, ok := rawGreekTime.(string); !ok {
				return rejectField("market_data.greeks_calculated_at")
			}
		}
		if sourcePresent && rawGreekSource != nil {
			if _, ok := rawGreekSource.(string); !ok {
				return rejectField("market_data.greeks_calculation_provenance")
			}
		}
		greekTime, hasGreekTime := rawGreekTime.(string)
		greekSource, hasGreekSource := rawGreekSource.(string)
		warnings, warningOK := market["warnings"].([]any)
		if !hasGreekTime {
			if (sourcePresent && rawGreekSource != nil) || market["greeks_calculation_freshness"] != "unknown" || !warningOK || len(warnings) != 1 || warnings[0] != "greek_calculation_time_unknown" {
				return rejectField("market_data.greeks_calculation_freshness")
			}
		} else {
			calculatedAt, greekErr := time.Parse(time.RFC3339Nano, greekTime)
			if greekErr != nil || calculatedAt.After(observed) {
				return rejectField("market_data.greeks_calculated_at")
			}
			if !hasGreekSource || strings.TrimSpace(greekSource) == "" {
				return rejectField("market_data.greeks_calculation_provenance")
			}
			if market["greeks_calculation_freshness"] != "verified" {
				return rejectField("market_data.greeks_calculation_freshness")
			}
			if !warningOK || len(warnings) != 0 {
				return rejectField("market_data.warnings")
			}
		}
		validationStage = "evidence_as_of"
		asOfText, ok := result["evidence_as_of"].(string)
		if !ok {
			return rejectField("evidence_as_of")
		}
		asOf, parseErr := time.Parse(time.RFC3339Nano, asOfText)
		if parseErr != nil || !asOf.Equal(evidenceAt) {
			return rejectField("evidence_as_of")
		}
		current := time.Now()
		if c.Now != nil {
			current = c.Now()
		}
		if observed.After(current) {
			return rejectField("observed_at")
		}

		validationStage = "signal_score"
		if _, numeric := result["signal_score"].(json.Number); !numeric {
			return rejectField("signal_score")
		}
		score, err := standaloneNumber(result["signal_score"])
		if err != nil || score < 0 || score > 100 {
			return rejectField("signal_score")
		}
		threshold, err := standaloneNumber(result["minimum_passing_score"])
		if err != nil || threshold < 0 || threshold > 100 || score < threshold {
			return rejectField("minimum_passing_score")
		}
		validationStage = "receipt_expiry"
		expiryText, ok := result["expires_at"].(string)
		if !ok {
			return rejectField("expires_at")
		}
		expiry, err := time.Parse(time.RFC3339Nano, expiryText)
		now := time.Now()
		if c.Now != nil {
			now = c.Now()
		}
		if err != nil || !expiry.After(now) {
			return rejectField("expires_at")
		}
		validationStage = "policy_snapshot"
		policySnapshot, ok := result["policy_snapshot"].(map[string]any)
		if !ok {
			return rejectField("policy_snapshot")
		}
		policyVersion, _ := result["policy_version"].(string)
		if !validStandalonePolicyDigest(policySnapshot, policyVersion) {
			return rejectField("policy_version")
		}
		maxAgeSeconds, ageErr := standaloneNumber(policySnapshot["execution_max_quote_age_seconds"])
		if ageErr != nil || expiry.After(evidenceAt.Add(time.Duration(maxAgeSeconds*float64(time.Second)))) {
			return rejectField("policy_snapshot.execution_max_quote_age_seconds")
		}
		if fp, ok := result["trade_fingerprint"].(string); !ok || fp != standaloneProposalFingerprint(proposal) {
			return rejectField("trade_fingerprint")
		}
		if !validStandalonePolicy(policySnapshot, policyVersion, threshold) {
			return rejectField("policy_snapshot")
		}
		if !validStandaloneComponents(result["score_components"], score) {
			return rejectField("score_components")
		}
		validationStage = "checks"
		if result["remediation"] == nil {
			return rejectField("remediation")
		}
		remediation, ok := result["remediation"].([]any)
		if !ok || len(remediation) != 0 {
			return rejectField("remediation")
		}
		blockers, ok := result["blocking_reasons"].([]any)
		if !ok || len(blockers) != 0 {
			return rejectField("blocking_reasons")
		}
		checks, ok := result["checks"].([]any)
		if !ok || len(checks) == 0 {
			return rejectField("checks")
		}
		seenChecks := make(map[string]bool, len(checks))
		for _, entry := range checks {
			check, ok := entry.(map[string]any)
			if !ok {
				return rejectField("checks")
			}
			code, codeOK := check["code"].(string)
			if !codeOK || code == "" || seenChecks[code] || check["passed"] != true {
				return rejectField("checks")
			}
			seenChecks[code] = true
		}
		validationStage = "trade_echo"
		raw, err := json.Marshal(result["trade"])
		if err != nil {
			return rejectField("trade")
		}
		var echo StandaloneTradeProposal
		tradeDecoder := json.NewDecoder(bytes.NewReader(raw))
		tradeDecoder.DisallowUnknownFields()
		if tradeDecoder.Decode(&echo) != nil || !sameStandaloneTrade(proposal, echo) {
			return rejectField("trade")
		}
	}
	return result, nil
}

// ReadAssessmentPolicy returns only validated candidate-budget metadata. It is
// neither a trade assessment nor authority to place an order.
func (c *AlphaDeskClient) ReadAssessmentPolicy(ctx context.Context) (map[string]any, error) {
	unavailable := func(category string) (map[string]any, error) {
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone assessment policy is unavailable", Category: category}
	}
	if c == nil || !c.Enabled || !c.SignalQualityEnabled || c.APIKey == "" || ValidateAlphaDeskURL(c.URL) != nil {
		return unavailable("configuration")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/api/v2/option-trade-assessments/policy", nil)
	if err != nil {
		return unavailable("configuration")
	}
	request.Header.Set("X-AlphaDesk-API-Key", c.APIKey)
	client := http.Client{Timeout: 5 * time.Second}
	if c.HTTP != nil {
		client = *c.HTTP
		client.Timeout = 5 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return unavailable("deadline_exceeded")
		}
		return unavailable("transport_error")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return unavailable("upstream_authentication")
	}
	if response.StatusCode != http.StatusOK {
		return unavailable("upstream_service_error")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 262145))
	if err != nil || len(data) > 262144 {
		return unavailable("response_validation")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var document map[string]any
	if decoder.Decode(&document) != nil || document == nil || decoder.Decode(new(any)) != io.EOF {
		return unavailable("response_validation")
	}
	snapshot, ok := document["policy_snapshot"].(map[string]any)
	version, versionOK := document["policy_version"].(string)
	scopeOK := document["scope"] == "TRADE_ASSESSMENT"
	threshold, thresholdErr := standaloneNumber(document["minimum_passing_score"])
	if !ok || !versionOK || !scopeOK || document["execution_allowed"] != false || document["paper_only"] != true || document["human_approval_required"] != true || document["advisory_policy_profile"] != "paper_advisory_greeks_v1" || document["advisory_policy_hash"] != "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca" || thresholdErr != nil || !validStandalonePolicy(snapshot, version, threshold) {
		return unavailable("response_validation")
	}
	budget, budgetOK := snapshot["max_investment_per_candidate"].(string)
	budgetValue, budgetErr := standaloneNumber(json.Number(budget))
	contractsValue, contractsErr := standaloneNumber(snapshot["maximum_contracts_per_candidate"])
	if !budgetOK || budgetErr != nil || budgetValue <= 0 || contractsErr != nil || contractsValue < 1 || math.Trunc(contractsValue) != contractsValue {
		return unavailable("response_validation")
	}
	return map[string]any{
		"kind": "assessment_policy_metadata", "decision": "POLICY_ONLY", "assessment_performed": false, "scope": "TRADE_ASSESSMENT",
		"policy_version": version, "max_investment_per_candidate": budget,
		"maximum_contracts_per_candidate": snapshot["maximum_contracts_per_candidate"],
		"standard_contract_multiplier":    100, "paper_only": true,
		"human_approval_required": true, "execution_allowed": false,
	}, nil
}
