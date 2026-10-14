package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"prophet-trader/services"
)

func standaloneUnavailable(code string, stages ...string) gin.H {
	result := gin.H{"decision": "UNAVAILABLE", "signal_score": nil, "execution_allowed": false,
		"scope": "TRADE_ASSESSMENT", "retryable": true, "score_profile": "catalyst_momentum_v1", "score_components": nil,
		"advisory_policy_profile": "paper_advisory_greeks_v1", "advisory_policy_hash": "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca", "policy_version": nil, "paper_only": true, "human_approval_required": true,
		"market_data": gin.H{"source": "unknown", "feed": nil, "requested_feed": "indicative", "quality": "testing_only", "greeks_calculation_provenance": nil, "greeks_calculation_freshness": "unknown", "warnings": []string{"greek_calculation_time_unknown"}},
		"checks":      []any{}, "blocking_reasons": []string{code},
		"remediation": []string{"Check AlphaDesk configuration and current market evidence; skip this proposal and continue other work."}}
	if len(stages) > 0 {
		switch stages[0] {
		case "response_read", "decision", "execution_allowed", "pass", "scope", "score_source", "score_profile", "retryable", "advisory_policy_profile", "advisory_policy_hash", "paper_only", "human_approval_required", "assessment_id", "policy_version", "observed_at", "evidence_observed_at", "market_data", "market_data.source", "market_data.feed", "market_data.quality", "market_data.greeks_calculated_at", "market_data.greeks_calculation_provenance", "market_data.greeks_calculation_freshness", "market_data.warnings", "evidence_as_of", "signal_score", "minimum_passing_score", "expires_at", "policy_snapshot", "policy_snapshot.execution_max_quote_age_seconds", "score_components", "trade_fingerprint", "remediation", "blocking_reasons", "checks", "trade":
			result["validation_stage"] = stages[0]
		}
	}
	return result
}

func standaloneErrorCategory(err error) string {
	var unavailable *services.AlphaDeskUnavailableError
	if errors.As(err, &unavailable) {
		switch unavailable.Category {
		case "configuration", "deadline_exceeded", "transport_error", "upstream_authentication", "upstream_service_error", "response_validation":
			return unavailable.Category
		}
	}
	var configuration *services.AlphaDeskConfigurationError
	if errors.As(err, &configuration) {
		return "configuration"
	}
	return "assessment_service_unavailable"
}

// AssessOptionsTrade only calls AlphaDesk's standalone assessment API. It never
// constructs trading services, queries account equity or submits any broker order.
func (oc *OrderController) AssessOptionsTrade(c *gin.Context) {
	var proposal services.StandaloneTradeProposal
	decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 16385))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proposal); err != nil || decoder.Decode(new(any)) != io.EOF {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid standalone trade proposal"})
		return
	}
	if err := proposal.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	assessor, ok := oc.tradingService.(interface {
		AssessOptionsTradeReadOnly(context.Context, services.StandaloneTradeProposal) (map[string]any, error)
	})
	if !ok {
		c.JSON(http.StatusOK, standaloneUnavailable("account_bound_assessor_unavailable"))
		return
	}
	result, err := assessor.AssessOptionsTradeReadOnly(c.Request.Context(), proposal)
	if err != nil {
		var unavailable *services.AlphaDeskUnavailableError
		if errors.As(err, &unavailable) && unavailable.Category == "response_validation" {
			c.JSON(http.StatusOK, standaloneUnavailable(standaloneErrorCategory(err), unavailable.Stage))
			return
		}
		c.JSON(http.StatusOK, standaloneUnavailable(standaloneErrorCategory(err)))
		return
	}
	c.JSON(http.StatusOK, result)
}

// ReadOptionsAssessmentPolicy exposes only the authenticated AlphaDesk budget
// fields needed before selecting a long-options candidate. It is not an
// assessment and never invokes broker or order methods.
func (oc *OrderController) ReadOptionsAssessmentPolicy(c *gin.Context) {
	reader, ok := oc.tradingService.(interface {
		ReadStandaloneAssessmentPolicy(context.Context) (map[string]any, error)
	})
	if !ok {
		c.JSON(http.StatusServiceUnavailable, gin.H{"kind": "assessment_policy_metadata", "decision": "POLICY_ONLY", "assessment_performed": false, "status": "unavailable", "execution_allowed": false})
		return
	}
	policy, err := reader.ReadStandaloneAssessmentPolicy(c.Request.Context())
	if err != nil || policy == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"kind": "assessment_policy_metadata", "decision": "POLICY_ONLY", "assessment_performed": false, "status": "unavailable", "execution_allowed": false})
		return
	}
	c.JSON(http.StatusOK, policy)
}
