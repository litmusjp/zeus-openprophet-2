package controllers

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"prophet-trader/services"
)

func standaloneUnavailable(code string) gin.H {
	return gin.H{"decision": "UNAVAILABLE", "signal_score": nil, "execution_allowed": false,
		"scope": "TRADE_ASSESSMENT", "retryable": true, "score_profile": "catalyst_momentum_v1", "score_components": nil,
		"advisory_policy_profile": "paper_advisory_greeks_v1", "advisory_policy_hash": "c5282def77c620c544eb6a3906df21839f8ee775851bb8cdf73dfb99ceccfeca", "policy_version": nil, "paper_only": true, "human_approval_required": true,
		"market_data": gin.H{"source": "unknown", "feed": nil, "requested_feed": "indicative", "quality": "testing_only", "greeks_calculation_provenance": nil, "greeks_calculation_freshness": "unknown", "warnings": []string{"greek_calculation_time_unknown"}},
		"checks":      []any{}, "blocking_reasons": []string{code},
		"remediation": []string{"Check AlphaDesk configuration and current market evidence; skip this proposal and continue other work."}}
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
		c.JSON(http.StatusOK, standaloneUnavailable("assessment_service_unavailable"))
		return
	}
	c.JSON(http.StatusOK, result)
}
