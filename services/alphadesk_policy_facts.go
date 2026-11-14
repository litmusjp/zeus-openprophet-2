package services

// AlphaDesk's evaluator version is its score profile. OP2 accepts exactly two coherent versions. A policy read
// that does not name one is the current (v1) AlphaDesk; a named value outside the two is refused. A receipt is
// usable only while its evaluator version equals the version in the current policy state.

func standalonePolicyScoreProfile(doc map[string]any) (string, bool) {
	raw, present := doc["score_profile"]
	if !present {
		return scoreProfileV1, true
	}
	profile, ok := raw.(string)
	if !ok || (profile != scoreProfileV1 && profile != scoreProfileV2) {
		return "", false
	}
	return profile, true
}

func receiptEvaluator(doc map[string]any) string {
	profile, _ := doc["score_profile"].(string)
	return profile
}

// evaluatorOrLegacy treats an assessment that was built before this field existed as the original evaluator.
func evaluatorOrLegacy(profile string) string {
	if profile == "" {
		return scoreProfileV1
	}
	return profile
}

func policyFactNumber(value any) any {
	if value == nil {
		return nil
	}
	number, err := standaloneNumber(value)
	if err != nil {
		return nil
	}
	return number
}

// standalonePolicyFacts are descriptive facts for the agent: the live thresholds AlphaDesk applies. They never
// authorize an order and are derived only from the already-validated policy snapshot.
func standalonePolicyFacts(snapshot map[string]any, profile string) map[string]any {
	priceAction := true
	if value, present := snapshot["require_price_action_confirmation"]; present {
		if flag, ok := value.(bool); ok {
			priceAction = flag
		}
	}
	facts := map[string]any{
		"score_profile":                     profile,
		"minimum_signal_score":              policyFactNumber(snapshot["minimum_signal_score"]),
		"minimum_catalyst_confidence":       policyFactNumber(snapshot["minimum_catalyst_confidence"]),
		"execution_max_quote_age_seconds":   policyFactNumber(snapshot["execution_max_quote_age_seconds"]),
		"execution_min_open_interest":       policyFactNumber(snapshot["execution_min_open_interest"]),
		"minimum_quote_size":                policyFactNumber(snapshot["minimum_quote_size"]),
		"minimum_dte":                       policyFactNumber(snapshot["minimum_dte"]),
		"maximum_dte":                       policyFactNumber(snapshot["maximum_dte"]),
		"maximum_strike_distance_ratio":     policyFactNumber(snapshot["maximum_strike_distance_ratio"]),
		"maximum_gap_percent":               policyFactNumber(snapshot["maximum_gap_percent"]),
		"require_price_action_confirmation": priceAction,
		"scope_note":                        "These settings are workspace-wide: every agent that uses this AlphaDesk key is judged by the same values. Facts only; they never authorize an order.",
	}
	if profile == scoreProfileV2 {
		facts["spread_veto"] = "delegated_to_op2"
	} else {
		facts["spread_veto"] = "alphadesk_numeric_limit"
		facts["execution_max_spread_ratio"] = policyFactNumber(snapshot["execution_max_spread_ratio"])
	}
	return facts
}
